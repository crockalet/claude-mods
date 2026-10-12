import type { On } from 'claude-code'

import { openQuestions } from '../hooks/text'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test runtime has timers; its types don't declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const NOW = Date.UTC(2026, 9, 5, 9, 0)
const ROOT = '/home/dev/.agents/notes/acme-app/feat-sync'

const PANE = {
  component: 'Pane',
  requestId: 'breadcrumbs',
  props: {
    title: 'breadcrumbs',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const TESTS = { ...PANE, requestId: 'tests', props: { ...PANE.props, title: 'tests' } } as const

const submitted: string[] = []
const sent: string[] = []
const spawnedModels: unknown[] = []

let stepAnswer = ''
let sessionId = 'abc123def456'
// Set by a test that needs a different side-pass reply per call; gets each request's prompt.
let replyTo: ((prompt: string) => string) | null = null

// One model response of the main loop, read to its end as the engine reads it.
const step = async ($: Engine, answer: string) => {
  stepAnswer = answer
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream);
  return stream.result
}

const world = (on: On, reply = '{}', hasStore = false) => {
  sessionId = 'abc123def456'
  replyTo = null
  const files = new Map<string, string>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/dev' })
  if (!hasStore) mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__breadcrumbs__${e.name}` } }))
  on('agent.register', ($, e) => ({ value: { agent: `breadcrumbs:${e.name}` } }))
  on('agent.spawn', ($, e) => (spawnedModels.push(e.model), { model: String(e.model ?? 'sonnet'), agentId: 'agent-1' }))
  on('session.send', ($, e) => (sent.push(e.text), { isDelivered: true }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: sessionId }))
  on('session.cwd', () => ({ value: '/code/feat-sync' }))
  on('session.repo', () => ({ value: { root: '/code/acme-app', remote: null, internal: false, name: null } }))
  on('process.run', async ($, e) => {
    // A real `sleep 1` yields; an instant one would let a waiting step spin without ever yielding.
    if (e.argv[0] === 'sleep') await new Promise<void>(resolve => setTimeout(resolve, 5))
    const out = e.argv.includes('--show-toplevel')
      ? '/code/feat-sync\n'
      : e.argv.includes('--show-current')
        ? 'feat/sync\n'
        : e.argv.includes('status')
          ? '## feat/sync...origin/feat/sync [ahead 1]\n M hooks/a.ts\n'
          : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set([...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split('/')[0] ?? ''))
    return { value: [...names].map(name => ({ name, kind: [...files.keys()].some(k => k.startsWith(`${prefix}${name}/`)) ? ('dir' as const) : ('file' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('model.complete', ($, e) => ({
    value: { isAnswered: true, text: replyTo ? replyTo(e.prompt) : reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: stepAnswer, toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('tool.call', ($, e, next) => (e.tool === 'SubagentHandback' ? ({ result: 'handed back' } as never) : next(e)))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })

  return { files, clock }
}

describe('breadcrumbs', () => {
  test('save_note writes a note file and the pane previews it', async ($, on) => {
    const { files } = world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })

    const saved = await $.tool.call({
      tool: 'mcp__breadcrumbs__save_note',
      title: 'Why the backoff raced',
      markdown: 'Two timers both **reconnected**.',
    })
    expect(saved.deny).toBeUndefined()

    const note = [...files.keys()].find(p => p.endsWith('01-why-the-backoff-raced.md'))
    expect(note?.startsWith(`${ROOT}/2026-10-05-`)).toBe(true)
    expect(files.get(note ?? '')).toContain('Two timers both **reconnected**.')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface, ...PANE })
      expect(await ui.find({ type: 'Button', text: /Why the backoff raced/ })).toBeDefined()
      const row = await ui.find({ type: 'Button', text: /Why the backoff raced/ })
      await ui.press({ key: row?.key ?? '' })
      const kind = surface === 'terminal' ? 'Text' : 'Markdown'
      expect(await ui.find({ type: kind, text: /Two timers/ })).toBeDefined()
      await ui.press({ key: 'close-note' })
      expect(await ui.find({ type: kind, text: /Two timers/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('edit_note changes a note in place, and saving the same title again replaces it', async ($, on) => {
    const { files } = world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const saved = await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Plan', markdown: '- step one\n- step two\n- step two' })
    const id = /Its id is (\S+);/.exec(String(saved.result))?.[1] ?? ''
    const file = () => [...files.entries()].find(([p]) => p.endsWith('01-plan.md'))?.[1] ?? ''

    const edited = await $.tool.call({ tool: 'mcp__breadcrumbs__edit_note', id, edits: [{ old: 'step one', new: 'step 1' }] })
    expect(edited.deny).toBeUndefined()
    expect(file()).toContain('- step 1\n- step two')
    expect(file()).toContain('title: Plan\n')

    const ambiguous = await $.tool.call({ tool: 'mcp__breadcrumbs__edit_note', id, edits: [{ old: 'step 1', new: 'x' }, { old: 'step two', new: 'y' }] })
    expect(ambiguous.deny).toContain('appears 2 times')
    expect(file()).toContain('- step 1\n')

    await $.tool.call({ tool: 'mcp__breadcrumbs__edit_note', id: 'plan', markdown: 'Rewritten.' })
    expect(file()).toContain('# Plan\n\nRewritten.\n')
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Plan', markdown: 'Saved again.' })
    expect(file()).toContain('Saved again.')
    expect([...files.keys()].filter(p => p.endsWith('.md') && /\/\d\d-/.test(p))).toHaveLength(1)

    const missing = await $.tool.call({ tool: 'mcp__breadcrumbs__edit_note', id: 'nope', markdown: 'x' })
    expect(missing.deny).toContain('No note "nope"')
  })

  test('a note table too wide for the pane is shown as a list, the file keeps the table', async ($, on) => {
    const { files } = world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const wide = [
      '| Need | Mod API piece | Already in breadcrumbs? |',
      '|---|---|---|',
      '| Claude lays out the test plan | `$.tool.register` → a test_plan tool | yes, same pattern as save_note |',
    ].join('\n')
    const narrow = '| a | b |\n|---|---|\n| 1 | 2 |'
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Tables', markdown: `${wide}\n\n${narrow}` })
    expect([...files.values()].some(t => t.includes('| Need | Mod API piece |'))).toBe(true)

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'desktop', ...PANE })
    const row = await ui.find({ type: 'Button', text: /Tables/ })
    await ui.press({ key: row?.key ?? '' })
    const body = await ui.find({ type: 'Markdown', text: /Claude lays out/ })
    const text = String(body?.props.text ?? '')
    expect(text).toContain('- Claude lays out the test plan\n  - *Mod API piece*: `$.tool.register` → a test_plan tool')
    expect(text).not.toContain('| Need |')
    expect(text).toContain('| a | b |')
    await ui.unmount()

    // The terminal wraps cells, so the wide table stays a table until the pane can't give each column room.
    const term = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await term.find({ type: 'Text', text: /^ Need +│ Mod API +│ Already in/ })).toBeDefined()
    expect(await term.find({ type: 'Text', text: /^ a │ b$/ })).toBeDefined()
    expect(await term.find({ type: 'Text', text: /\| a \| b \|/ })).toBeUndefined()
    await term.unmount()

    const narrowPane = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 30 } })
    expect(await narrowPane.find({ type: 'Text', text: /^• Claude lays out/ })).toBeDefined()
    expect(await narrowPane.find({ type: 'Text', text: /^ a │ b$/ })).toBeDefined()
    await narrowPane.unmount()
  })

  test('a test plan lists tests; a bare pass rides on the next prompt and a fail goes to Claude', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const listed = await $.tool.call({
      tool: 'mcp__breadcrumbs__test_plan',
      tests: [
        { title: 'Login with SSO', steps: ['Open the app', 'Tap Sign in with Google'], expect: 'Lands on home', trigger: 'signIn() navigates home' },
        { title: 'Push while backgrounded', steps: ['Background the app'] },
      ],
    })
    expect(listed.deny).toBeUndefined()

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await ui.find({ type: 'Text', text: /2 tests · 0 passed/ })).toBeDefined()
    await ui.press({ key: 'test-1-row' })
    expect(await ui.find({ type: 'Text', text: 'Tap Sign in with Google' })).toBeDefined()
    await ui.press({ key: 'test-1-pass' })
    expect(submitted).toEqual([])

    await ui.press({ key: 'test-2-row' })
    await ui.input({ key: 'test-2-input', text: 'no banner', kind: 'change' })
    await ui.press({ key: 'test-2-fail' })
    expect(submitted).toEqual(['[manual test 2 ✗] Push while backgrounded: no banner'])
    expect(await ui.find({ type: 'Text', text: /1 passed · 1 failed/ })).toBeDefined()

    const next = await $.prompt.submit({ text: 'fixed it', wait: false, origin: { kind: 'composer' } })
    expect(next.context?.join('\n')).toContain('✓ test 1 Login with SSO')
    await ui.unmount()
  })

  test('Start tester asks the main agent to spawn the tester, since a plugin-spawned agent gets no plugin hooks', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Push while backgrounded', steps: ['Background the app'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    await ui.press({ key: 'test-1-row' })
    await ui.press({ key: 'test-1-start' })

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('subagent_type "breadcrumbs:tester", run_in_background true')
    expect(submitted[0]).toContain('Test 1: Push while backgrounded\n\nSteps:\n1. Background the app')
    expect(await ui.find({ key: 'test-1-row', text: /● 1/ })).toBeDefined()
    await ui.unmount()
  })

  test('with the launcher running, Start tester leaves it a request instead of asking Claude', async ($, on) => {
    submitted.length = 0
    const { files } = world(on)
    const launch = '/home/dev/.agents/notes/.launch/abc123def456'
    files.set(`${launch}/ready`, String(NOW))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Push while backgrounded', steps: ['Background the app'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    await ui.press({ key: 'test-1-row' })
    await ui.press({ key: 'test-1-start' })

    expect(submitted).toEqual([])
    const request = JSON.parse([...files.entries()].find(([p]) => p.startsWith(`${launch}/`) && p.endsWith('.json'))?.[1] ?? '{}')
    expect(request.subagentType).toBe('breadcrumbs:tester')
    expect(request.description).toBe('Test 1: Push while backgrounded')
    expect(request.prompt).toContain('Test 1: Push while backgrounded\n\nSteps:\n1. Background the app')

    // The launcher's spawn passes through this plugin's own hook, which binds the tester to its test.
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: request.prompt, description: request.description })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', agentId: 'agent-1', note: 'Capturing logs' })
    expect(await ui.find({ type: 'Text', text: /tester: Capturing logs/ })).toBeDefined()
    await ui.unmount()
  })

  test('a request the launcher never takes, or a launcher gone quiet, falls back to Claude', async ($, on) => {
    submitted.length = 0
    const { files, clock } = world(on)
    const launch = '/home/dev/.agents/notes/.launch/abc123def456'
    files.set(`${launch}/ready`, String(NOW))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'One' }, { title: 'Two' }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    await ui.press({ key: 'test-1-row' })
    await ui.press({ key: 'test-1-start' })
    expect(submitted).toEqual([])
    await clock.advance(15_000)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('subagent_type "breadcrumbs:tester"')

    // Its last stamp is now older than the launcher's heartbeat allows.
    await clock.advance(90_000)
    await ui.press({ key: 'test-2-row' })
    await ui.press({ key: 'test-2-start' })
    expect(submitted).toHaveLength(2)
    expect(submitted[1]).toContain('Test 2: Two')
    await ui.unmount()
  })

  test('tests added later join the list, with fresh ids when theirs are taken', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ id: '1', title: 'Login' }] })
    const later = await $.tool.call({
      tool: 'mcp__breadcrumbs__test_plan',
      tests: [{ id: '1', title: 'Logout' }, { id: '2', title: 'Log back in', needs: ['1'] }],
    })
    expect(later.result).toContain('2 Logout; 3 Log back in')

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await ui.find({ key: 'test-1-row', text: /Login/ })).toBeDefined()
    expect(await ui.find({ key: 'test-2-row', text: /Logout/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'after 2' })).toBeDefined()

    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', mode: 'replace', tests: [{ title: 'Fresh start' }] })
    expect(await ui.find({ type: 'Text', text: /^1 tests/ })).toBeDefined()
    await ui.unmount()
  })

  test('a step waits in the pane until Done and returns what the person typed', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Push while backgrounded', steps: ['Background the app'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const waiting = $.tool.call({ tool: 'mcp__breadcrumbs__await_user', id: '1', step: 1, instruction: 'Background the app' })
    let card
    for (let i = 0; i < 50 && !card; i++) card = await ui.find({ type: 'Button', text: 'Done' })
    expect(await ui.find({ type: 'Text', text: /⏳ 1 waiting on you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⏳ step 1' })).toBeDefined()
    await ui.input({ key: String(card?.key).replace(/-done$/, '-input'), text: 'banner showed', kind: 'change' })
    await ui.press({ key: String(card?.key) })
    expect((await waiting).result).toBe('The person answered: Done. banner showed')
    expect(await ui.find({ type: 'Text', text: /waiting on you/ })).toBeUndefined()

    await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', id: '1', status: 'retest', note: 'Fixed the token refresh' })
    expect(await ui.find({ type: 'Text', text: /claude: ⟳ Fixed the token refresh/ })).toBeDefined()
    expect(submitted).toEqual([])
    await ui.unmount()
  })

  test('a checkpoint shows several steps and answers with the tester\'s own options', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Cancel clears chat', steps: ['Book a ride', 'Cancel it'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const waiting = $.tool.call({
      tool: 'mcp__breadcrumbs__await_user',
      id: '1',
      step: 1,
      steps: ['Book a ride', 'Cancel it'],
      instruction: 'Is the chat notification gone?',
      options: ['Gone', 'Still there'],
    })
    let gone
    for (let i = 0; i < 50 && !gone; i++) gone = await ui.find({ type: 'Button', text: 'Gone' })
    expect(await ui.find({ type: 'Text', text: 'Cancel it' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Done' })).toBeUndefined()
    await ui.press({ key: String(gone?.key) })
    expect((await waiting).result).toBe('The person answered: Gone')
    await ui.unmount()
  })

  test('a closed test starts from its row, and its waiting step shows under the title without opening it', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Login', steps: ['Log in'] }, { title: 'Logout', steps: ['Log out'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    expect(await ui.find({ key: 'test-2-start', text: '▶ start' })).toBeDefined()
    await ui.press({ key: 'test-2-start' })
    expect(submitted.at(-1)).toContain('Test 2: Logout')
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 2: Logout', description: 'Test 2' } as never)
    if (await ui.find({ type: 'Text', text: 'Log out' })) await ui.press({ key: 'test-2-row' })
    expect(await ui.find({ key: 'test-2-start' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'running' })).toBeDefined()
    const rows = await ui.findAll({ type: 'Button', text: /^[▸▾]/ })
    expect(rows.map(b => b.key)).toEqual(['test-2-row', 'test-1-row'])

    const waiting = $.tool.call({ tool: 'mcp__breadcrumbs__await_user', id: '2', step: 1, instruction: 'Did the session end?', options: ['Yes', 'No'] })
    let yes
    for (let i = 0; i < 50 && !yes; i++) yes = await ui.find({ type: 'Button', text: 'Yes' })
    if (await ui.find({ type: 'Text', text: 'Log out' })) await ui.press({ key: 'test-2-row' })
    expect(await ui.find({ type: 'Button', text: 'Yes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Log out' })).toBeUndefined()
    await ui.press({ key: String(yes?.key) })
    expect((await waiting).result).toBe('The person answered: Yes')
    await ui.unmount()
  })

  test('stop ends a running tester at once: its step returns, and every later call but a cleanup kill is refused', async ($, on) => {
    sent.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Login', steps: ['Log in'] }, { title: 'Logout', steps: ['Log out'] }] })
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 1: Login', description: 'Test 1' } as never)
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const waiting = $.tool.call({ tool: 'mcp__breadcrumbs__await_user', agentId: 'agent-1', id: '1', step: 1, instruction: 'Log in' } as never)
    for (let i = 0; i < 50 && !(await ui.find({ type: 'Button', text: 'Done' })); i++);
    expect(await ui.find({ key: 'test-1-stop', text: '■ stop' })).toBeDefined()
    await ui.press({ key: 'test-1-stop' })
    expect(String((await waiting).result)).toContain('The person stopped this test.')

    const read = await $.tool.call({ tool: 'Read', agentId: 'agent-1', file_path: '/code/feat-sync/a.ts' } as never)
    expect(read.deny).toContain('The person stopped this test.')
    const kill = await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'kill 4242' } as never)
    expect(kill.deny).toBeUndefined()
    // The hand-back is how the tester reports and ends; refusing it left a stopped tester retrying forever.
    const handback = await $.tool.call({ tool: 'SubagentHandback', agentId: 'agent-1', message: 'Stopped before any step ran.' } as never)
    expect(handback.deny).toBeUndefined()
    expect(await ui.find({ key: 'test-1-start', text: '▶ restart' })).toBeDefined()

    expect(await ui.find({ key: 'test-1-stop' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /tester: Stopped before any step ran\./ })).toBeDefined()
    await $.turn.complete({ answer: 'Stopped before any step ran.', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' })
    const after = await $.tool.call({ tool: 'Bash', agentId: 'agent-1', command: 'ls' } as never)
    expect(after.deny).toBeUndefined()

    submitted.length = 0
    await ui.press({ key: 'test-1-start' })
    expect(submitted.at(-1)).toContain('Earlier runs of this test (history only; this is a fresh run, so start the steps):\n- you: ■ stopped the tester')

    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 2: Logout', description: 'Test 2' } as never)
    await ui.press({ key: 'test-2-row' })
    await ui.press({ key: 'test-2-pass' })
    expect(sent.at(-1)).toContain('The person marked this test passed.')
    expect(await ui.find({ key: 'test-2-row', text: /✓ 2/ })).toBeDefined()
    expect((await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', agentId: 'agent-1', id: '2', status: 'failed' } as never)).deny).toContain('marked this test passed')
    await ui.unmount()
  })

  test('a long command in a step is shown whole and copies with one press', async ($, on) => {
    const copied: string[] = []
    world(on)
    on('ui.copy', ($, e) => (copied.push(e.text), { value: { isCopied: true } }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const command = 'cd ~/repos/plugins/breadcrumbs && claude --plugin-dir plugins/breadcrumbs --plugin-dir plugins/breadcrumbs-launcher'
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Dev session', steps: [`In a new terminal run: ${command}`] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const waiting = $.tool.call({ tool: 'mcp__breadcrumbs__await_user', id: '1', step: 1, steps: [`Open a new terminal and run \`${command}\``, 'Paste: `/tests`'] })
    let copy
    for (let i = 0; i < 50 && !copy; i++) copy = await ui.find({ type: 'Button', text: '⧉ copy' })
    expect(await ui.find({ type: 'Text', text: `Open a new terminal and run \`${command}\`` })).toBeDefined()
    await ui.press({ key: String(copy?.key) })
    expect(copied).toEqual([command])
    await ui.press({ key: String(copy?.key).replace('step-0', 'step-1') })
    expect(copied).toEqual([command, '/tests'])

    await ui.press({ key: String((await ui.find({ type: 'Button', text: 'Done' }))?.key) })
    await waiting
    // The waiting step opened the test, so its own steps are drawn with their copy buttons too.
    await ui.press({ key: 'test-1-step-0-copy-0' })
    expect(copied.at(-1)).toBe(command)
    await ui.unmount()
  })

  test('a tester stops to ask the planner, and the reply comes back for the main agent to send to that tester', async ($, on) => {
    sent.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Search in Addu', steps: ['Search: airport'] }] })
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 1: Search in Addu', description: 'Test 1' })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const asked = await $.tool.call({ tool: 'mcp__breadcrumbs__ask_planner', id: '1', question: 'Every search returns []; is the Addu index synced?' })
    expect(asked.result).toContain('"[tester asks · manual test 1 · Search in Addu] Every search returns []; is the Addu index synced?"')
    expect(await ui.find({ type: 'Text', text: 'asking Claude' })).toBeDefined()

    await $.turn.complete({ answer: '[tester asks · manual test 1 · Search in Addu] Every search returns []', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'agent-1' })
    expect(await ui.find({ key: 'test-1-row', text: /● 1/ })).toBeDefined()

    const replied = await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', id: '1', reply: 'Synced it; search again', steps: ['Search: Gan airport'] })
    expect(replied.result).toContain('call SendMessage with to "agent-1" and exactly this message:\n\nThe planner answered: Synced it; search again\n\nSteps are now:\n1. Search: Gan airport')
    expect(sent).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'asking Claude' })).toBeUndefined()

    const resumed = await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', agentId: 'agent-1', status: 'passed', note: 'Resumed and passed' })
    expect(resumed.result).toBe('Updated test 1.')

    const late = await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', id: '1', reply: 'Anything else?' })
    expect(late.result).toContain('not waiting on a question')
    await ui.unmount()
  })

  test('a test needs a trigger, waits on the tests it needs, and is blocked when one fails', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const tests = [
      { title: 'Driver goes online', steps: ['Go online'], expect: 'Offers arrive', trigger: 'goOnline() posts /driver/status' },
      { title: 'Cash trip', steps: ['Book a ride'], expect: 'Receipt shows cash', needs: ['1'], assumes: ['One ride per driver at a time'] },
    ]
    const denied = await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests })
    expect(denied.deny).toContain('Give tests 2 a trigger')

    tests[1] = { ...tests[1], trigger: 'ride_ended from completeRide() in rides.ts, driver app only' } as (typeof tests)[number]
    expect((await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests })).deny).toBeUndefined()
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await ui.find({ type: 'Text', text: /after 1/ })).toBeDefined()
    await ui.press({ key: 'test-2-row' })
    expect(await ui.find({ key: 'test-2-start' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /assumes: One ride per driver/ })).toBeDefined()

    await ui.press({ key: 'test-1-row' })
    await ui.press({ key: 'test-1-start' })
    expect(submitted[0]).toContain('Trigger: goOnline() posts /driver/status')
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', id: '1', status: 'failed', note: 'No offers' })
    expect(await ui.find({ key: 'test-2-row', text: /⊘ 2 Cash trip/ })).toBeDefined()
    await ui.press({ key: 'test-2-row' })
    expect(await ui.find({ type: 'Text', text: /needs test 1, which failed/ })).toBeDefined()
    await ui.unmount()
  })

  test('testers run on the default tester model unless the plan picks one for a test', async ($, on) => {
    spawnedModels.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Quick check' }, { title: 'Subtle race', model: 'opus' }] })
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 1: Quick check', description: 'Test 1' })
    await $.agent.spawn({ subagentType: 'breadcrumbs:tester', prompt: 'Test 2: Subtle race', description: 'Test 2', model: 'haiku' })
    expect(spawnedModels).toEqual(['sonnet', 'opus'])
  })

  test('the planner\'s brief reaches the tester and can be revised between tests', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({
      tool: 'mcp__breadcrumbs__test_plan',
      brief: 'Driver build 53cb767a on the OnePlus.',
      tests: [{ title: 'Cancel clears chat', steps: ['Cancel it'] }, { title: 'Complete clears chat', steps: ['Complete it'] }],
    })
    const revised = await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', brief: 'Driver build 53cb767a. Operator-panel completion sends no push.' })
    expect(revised.result).toBe('Updated the brief.')
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_update', id: '2', status: 'blocked', expect: 'Needs the driver app to complete' })

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    await ui.press({ key: 'test-2-row' })
    expect(await ui.find({ type: 'Text', text: /expect: Needs the driver app to complete/ })).toBeDefined()
    await ui.press({ key: 'test-1-row' })
    await ui.press({ key: 'test-1-start' })
    expect(submitted[0]).toContain('Test 1: Cancel clears chat\n\nBrief from the planner:\nDriver build 53cb767a. Operator-panel completion sends no push.')
    await ui.unmount()
  })

  test('a finished turn sets the task, decisions and last reply from the side pass', async ($, on) => {
    const reply = JSON.stringify({
      task: 'Fix websocket reconnect loop',
      isNewTask: false,
      decisions: ['Capped backoff at 30s'],
      attempts: [{ text: 'Patch A with a mutex', isOk: false }],
      done: ['Pushed main to crockalet/breadcrumbs'],
      note: null,
    })
    const { files, clock } = world(on, reply)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })

    await $.prompt.submit({ text: 'fix the reconnect loop', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Patched the race and added a test. Approve the PR description?', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Fix websocket reconnect loop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fix the reconnect loop/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Patched the race/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 dead end/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Pushed main to crockalet/breadcrumbs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 uncommitted · ↑1 unpushed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /❯/ })).toBeUndefined()

    const context = [...files.entries()].find(([p]) => p.endsWith('/context.md'))
    expect(context?.[1]).toContain('# Fix websocket reconnect loop')
    expect(context?.[1]).toContain('- ✗ Patch A with a mutex')
  })

  test('a long turn fills the pane while it runs, and its passes share one done row', async ($, on) => {
    const { clock } = world(on)
    const asked: string[] = []
    const replies = [
      { task: 'Fix websocket reconnect loop', decisions: ['Capped backoff at 30s'], done: { title: 'Patched socket.ts', items: [] } },
      { task: 'Fix websocket reconnect loop', decisions: ['Capped backoff at 30s'], done: { title: 'Fixed the reconnect race', items: ['Patched socket.ts', 'Added a reconnect test'] } },
    ]
    replyTo = prompt => (asked.push(prompt), JSON.stringify(replies[asked.length - 1] ?? {}))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'fix the reconnect loop', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'fix the reconnect loop', turnId: 't1' })

    await step($, 'Found it: two timers both reconnect after a drop. '.repeat(8))
    await clock.settle()
    expect(asked).toEqual([])
    await clock.advance(25_000)
    await step($, 'Patching socket.ts now.')
    await clock.settle()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('still working on this turn')

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Fix websocket reconnect loop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Patching socket\.ts now/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Patched socket.ts' })).toBeDefined()
    await ui.unmount()

    await $.turn.complete({ answer: 'Fixed the race and added a test.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('<assistant_reply>\nFixed the race and added a test.')
    expect(asked[1]).not.toContain('Found it')

    const after = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await after.find({ type: 'Button', text: '▸ Fixed the reconnect race' })).toBeDefined()
    expect(await after.find({ type: 'Text', text: 'Done · 1' })).toBeDefined()
    expect(await after.find({ type: 'Text', text: /^1 decided/ })).toBeDefined()
    await after.unmount()
  })

  test('/clear starts the pane and its folder over under the new session id', async ($, on) => {
    const { files } = world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Before clear', markdown: 'Old.' })

    sessionId = 'fff999eee888'
    await $.classic.SessionStart({ source: 'clear', transcript_path: '/t/new.jsonl' })
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'After clear', markdown: 'New.' })

    const note = [...files.keys()].find(p => p.endsWith('/01-after-clear.md')) ?? ''
    expect(note).toMatch(/-fff999\/01-after-clear\.md$/)
    expect(files.get(note)).toContain('session: fff999eee888')
    expect([...files.keys()].some(p => p.endsWith('-fff999/state.json'))).toBe(true)
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Button', text: /Before clear/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: /After clear/ })).toBeDefined()
    await ui.unmount()
  })

  test('a turn\'s results show as one done title that expands to the list', async ($, on) => {
    const reply = JSON.stringify({
      task: 'Add the secrets mod',
      done: { title: 'Added the secrets mod', items: ['Created plugins/secrets/hooks/register.tsx', 'Listed secrets in marketplace.json'] },
    })
    const { files, clock } = world(on, reply)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'add a secrets mod', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Added it.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    const row = await ui.find({ type: 'Button', text: '▸ Added the secrets mod' })
    expect(row).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /register\.tsx/ })).toBeUndefined()
    await ui.press({ key: String(row?.key) })
    expect(await ui.find({ type: 'Text', text: 'Created plugins/secrets/hooks/register.tsx' })).toBeDefined()

    const context = [...files.entries()].find(([p]) => p.endsWith('/context.md'))?.[1]
    expect(context).toContain('- Added the secrets mod\n  - Created plugins/secrets/hooks/register.tsx')
    await ui.unmount()
  })

  test('open questions are read from Claude\'s lines, options and assumption included', async () => {
    const reply = [
      'Patched the race.',
      'Open question: Which cache TTL? [5m | 1h] (assuming 5m)',
      '- **Open question:** Rename the flag to `isLive`?',
      '**Open questions:**',
      'Open questions remain about the rollout.',
      '**Open question**: Ship behind a flag?',
      '```',
      'Open question: not this one, it is code',
      '```',
      'Is this a question? It is not an open one.',
    ].join('\n')
    expect(openQuestions(reply)).toEqual([
      { question: 'Which cache TTL?', context: '', options: ['5m', '1h'], optionNotes: ['', ''], assumption: '5m' },
      { question: 'Rename the flag to `isLive`?', context: '', options: [], optionNotes: [], assumption: '' },
      { question: 'Ship behind a flag?', context: '', options: [], optionNotes: [], assumption: '' },
    ])
  })

  test('a question asked mid-turn shows at once, and its answer rides on Claude\'s next tool result instead of a turn', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.turn.start({ text: 'speed up the cache', turnId: 't1' })
    await step($, 'Starting on the cache.\nOpen question: Which cache TTL? [5m | 1h] (assuming 5m)')

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Which cache TTL?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'going with 5m' })).toBeDefined()
    await ui.press({ key: 'ask-0-opt-1' })
    expect(submitted).toEqual([])
    expect(await ui.find({ type: 'Text', text: /Which cache TTL\? — 1h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /after its next step/ })).toBeDefined()
    expect(await ui.find({ key: 'send-now' })).toBeUndefined()

    const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    expect(ran.context).toEqual(['The user answered your open question "Which cache TTL?" in the breadcrumbs pane: 1h'])
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /— 1h/ })).toBeUndefined()

    // The final reply repeating the line doesn't ask it again.
    await step($, 'Done, using 1h.\nOpen question: Which cache TTL? [5m | 1h] (assuming 5m)')
    expect(await ui.find({ type: 'Text', text: 'Which cache TTL?' })).toBeUndefined()
    expect(submitted).toEqual([])
    await ui.unmount()
  })

  test('an answer given while Claude is idle goes with the next prompt, or now with send now', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await step($, 'Open question: Who should review it?\nOpen question: Bump the major version? [Yes | No] (assuming no)')
    await $.turn.complete({ answer: 'Shipped.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    await ui.input({ key: 'ask-0-input', text: 'Sam' })
    expect(submitted).toEqual([])
    expect(await ui.find({ type: 'Text', text: /with your next prompt/ })).toBeDefined()
    const next = await $.prompt.submit({ text: 'also update the changelog', wait: false, origin: { kind: 'composer' } })
    expect(next.context).toEqual(['The user answered your open question "Who should review it?" in the breadcrumbs pane: Sam'])

    // A prompt doesn't clear what is still open.
    await ui.press({ key: 'ask-0-opt-0' })
    await ui.press({ key: 'send-now' })
    expect(submitted.at(-1)).toBe('The user answered your open question "Bump the major version?" in the breadcrumbs pane: Yes')
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
    await ui.unmount()
  })

  test('a question Claude went ahead on can be left as it is', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await step($, 'Open question: Keep the old endpoint for a release? (assuming yes)')
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    await ui.press({ key: 'ask-0-dismiss' })
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
    expect(submitted).toEqual([])
    await ui.unmount()
  })

  test('the side pass files an explanation from the reply itself, without its open questions', async ($, on) => {
    const { files, clock } = world(on, JSON.stringify({ task: 'Explain the reconnect', note: { title: 'How reconnect works', markdown: null } }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'how does reconnect work?', wait: false, origin: { kind: 'composer' } })
    const answer = 'Reconnect backs off **exponentially**, capped at 30s.\n\nOpen question: Cap it at 60s instead? (assuming 30s)'
    await $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const note = [...files.entries()].find(([p]) => p.endsWith('01-how-reconnect-works.md'))?.[1] ?? ''
    expect(note).toContain('Reconnect backs off **exponentially**, capped at 30s.')
    expect(note).not.toContain('Open question')
  })

  test('a note Claude posts mid-turn doesn\'t stop the reply\'s explanation being filed', async ($, on) => {
    const { files, clock } = world(on, JSON.stringify({ task: 'Fix reconnect', note: { title: 'Why reconnect raced', markdown: null } }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'fix reconnect and tell me why it raced', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Heads-up: prod config', markdown: 'Staging points at the prod queue.' })
    await $.turn.complete({ answer: 'Two timers both reconnected, so the second one raced the first.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const notes = [...files.keys()].filter(p => /\/\d\d-[^/]+\.md$/.test(p)).map(p => p.split('/').pop())
    expect(notes).toEqual(['01-heads-up-prod-config.md', '02-why-reconnect-raced.md'])
  })

  test('a reply that asks nothing leaves nothing under needs you', async ($, on) => {
    const { clock } = world(on, JSON.stringify({ task: 'Ship it', needsYou: [{ question: 'Add a submit button?', options: ['Yes', 'No'] }] }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'add a submit button', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Added the submit button and pushed it.', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Ship it' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Needs you' })).toBeUndefined()
  })

  test('a session with history but no breadcrumbs is backfilled from its transcript', async ($, on) => {
    const { clock } = world(on, JSON.stringify({ task: 'Add dark mode to settings', done: ['Added a theme toggle to SettingsScreen.tsx'] }))
    on('session.messages', () => ({
      value: [
        { role: 'user', text: '<command-caveat>ignore me</command-caveat>', toolUses: [] },
        { role: 'user', text: 'add dark mode to the settings screen', toolUses: [] },
        {
          role: 'assistant',
          text: 'Adding a toggle.',
          toolUses: [{ tool_use_id: 'u1', tool: 'Edit', input: { file_path: '/code/feat-sync/SettingsScreen.tsx' } }],
        },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'ok', isError: false }] },
        { role: 'assistant', text: 'Dark mode toggle added.', toolUses: [] },
      ],
    }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await clock.settle()

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Add dark mode to settings' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /add dark mode to the settings screen/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ignore me/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Dark mode toggle added/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /^▸ Added a theme toggle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file edited/ })).toBeDefined()
  })

  test('tests saved with a session come back on resume, without a tester or waiting step', async ($, on) => {
    mock.store(on, { 'dir:abc123def456': '/old' })
    const { files } = world(on, '{}', true)
    const test = (id: string, status: string, agentId: string | null) => ({ id, title: `Test ${id}`, steps: [], expect: '', watch: '', status, agentId, log: [] })
    const tests = { tests: [test('1', 'passed', null), test('2', 'running', 'gone')], waits: [{ id: 'w', testId: '2', step: 1, instruction: 'Tap', at: NOW, answer: null }], unreported: [] }
    const old = { tasks: [{ title: 'Old task', at: NOW }], prompts: [], notes: [], session: 'abc123def456', worktree: '/code/feat-sync', updatedAt: NOW }
    files.set('/old/state.json', JSON.stringify(old))
    files.set('/old/tests.json', JSON.stringify(tests))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await ui.find({ key: 'test-1-row', text: /✓ 1 Test 1/ })).toBeDefined()
    expect(await ui.find({ key: 'test-2-row', text: /· 2 Test 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /waiting on you/ })).toBeUndefined()
  })

  test('tests come back on resume even when the breadcrumbs state survived', async ($, on) => {
    mock.store(on, { 'dir:abc123def456': '/old' })
    const { files } = world(on, '{}', true)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__save_note', title: 'Kept', markdown: 'Still here.' })
    const test = { id: '4', title: 'Survives a restart', steps: [], expect: '', watch: '', status: 'todo', agentId: null, log: [] }
    files.set('/old/tests.json', JSON.stringify({ tests: [test], waits: [], unreported: [] }))
    // A turn ending with an empty live list must not touch the saved one.
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer' })
    expect(files.get('/old/tests.json')).toContain('Survives a restart')

    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await ui.find({ key: 'test-4-row', text: /Survives a restart/ })).toBeDefined()
  })

  test('a session resumed under a new id finds its folder by its transcript', async ($, on) => {
    const { files, clock } = world(on)
    const mine = '2026-10-05-run-the-tests-abc000'
    const other = '2026-10-05-something-else-xyz000'
    const saved = (title: string, transcript: string) =>
      JSON.stringify({ tasks: [{ title, at: NOW }], prompts: [], notes: [], session: 'old', worktree: '/code/feat-sync', updatedAt: NOW, transcript })
    files.set(`${ROOT}/${mine}/state.json`, saved('Run the tests', '/t/first.jsonl'))
    files.set(`${ROOT}/${other}/state.json`, saved('Something else', '/t/other.jsonl'))
    const test = { id: '4', title: 'Survives a restart', steps: [], expect: '', watch: '', status: 'passed', agentId: null, log: [] }
    files.set(`${ROOT}/${mine}/tests.json`, JSON.stringify({ tests: [test], waits: [], unreported: [] }))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source: 'resume', transcript_path: '/t/first.jsonl' })
    await clock.settle()

    const tests = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })
    expect(await tests.find({ key: 'test-4-row', text: /✓ 4 Survives a restart/ })).toBeDefined()
    const crumbs = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await crumbs.find({ type: 'Text', text: 'Run the tests' })).toBeDefined()
  })

  test('state written by an older version still draws', async ($, on) => {
    mock.store(on, { 'dir:abc123def456': '/old' })
    const { files } = world(on, '{}', true)
    const old = { tasks: [{ title: 'Old task', at: NOW }], prompts: [], activity: null, lastSaid: null, notes: [], decided: [], tried: [], needsYou: ['Delete the dev copy?'], session: 'abc123def456', worktree: '/code/feat-sync', updatedAt: NOW }
    files.set('/old/state.json', JSON.stringify(old))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'Old task' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Delete the dev copy?' })).toBeDefined()
    expect(await ui.find({ key: 'ask-0-input' })).toBeDefined()
  })

  test('a test_plan row shows a count, not the whole plan, and its result keeps the first sentence', async ($, on) => {
    world(on)
    const drawn: unknown[] = []
    const BLANK = { type: 'Text' as const, props: {}, children: [] }
    on('ui.render', { component: 'ToolUse' }, ($, e) => (drawn.push(e.props.input), BLANK))
    on('ui.render', { component: 'ToolResult' }, ($, e) => (drawn.push(e.props.output), BLANK))
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    const tool = 'mcp__breadcrumbs__test_plan'
    const tests = [{ title: 'One', steps: ['a'] }, { title: 'Two' }]
    const base = { surface: 'terminal', requestId: 't1' } as const
    const row = { tool_use_id: 't1', tool, isRunning: false, isErrored: false, isInterrupted: false }
    await $.ui.render({ ...base, component: 'ToolUse', props: { ...row, input: { tests } } })
    await $.ui.render({ ...base, component: 'ToolUse', props: { ...row, tool: 'Bash', input: { command: 'ls' } } })
    const update = { id: '1', reply: `Expected: Calculator can't export. Replace step 2 with these and keep going.`, steps: ['a', 'b'], expect: 'Display shows 42' }
    await $.ui.render({ ...base, component: 'ToolUse', props: { ...row, tool: 'mcp__breadcrumbs__test_update', input: update } })
    const output = [{ type: 'text', text: 'Listed 2 test(s) in the tests pane (/home/dev/.agents/tests.md). Tell the user.' }]
    await $.ui.render({ ...base, component: 'ToolResult', props: { tool_use_id: 't1', tool, isErrored: false, output } })
    expect(drawn).toEqual([
      { tests: '2 tests' },
      { command: 'ls' },
      { id: '1', reply: "Expected: Calculator can't export. Replace step 2 with thes…", changed: 'steps, expect' },
      [{ type: 'text', text: 'Listed 2 test(s) in the tests pane (/home/dev/.agents/tests.md).' }],
    ])
  })
})
