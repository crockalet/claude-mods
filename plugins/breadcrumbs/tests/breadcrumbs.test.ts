import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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

const world = (on: On, reply = '{}', hasStore = false) => {
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
  on('session.id', () => ({ value: 'abc123def456' }))
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
  on('model.complete', () => ({
    value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  on('turn.complete', () => ({ text: '' }))
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
      expect(await ui.find({ type: 'Markdown', text: /Two timers/ })).toBeDefined()
      await ui.press({ key: 'close-note' })
      expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
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

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    const row = await ui.find({ type: 'Button', text: /Tables/ })
    await ui.press({ key: row?.key ?? '' })
    const body = await ui.find({ type: 'Markdown', text: /Claude lays out/ })
    const text = String(body?.props.text ?? '')
    expect(text).toContain('- Claude lays out the test plan\n  - *Mod API piece*: `$.tool.register` → a test_plan tool')
    expect(text).not.toContain('| Need |')
    expect(text).toContain('| a | b |')
    await ui.unmount()
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

  test('a step waits in the pane until Done and returns what the person typed', async ($, on) => {
    submitted.length = 0
    world(on)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'mcp__breadcrumbs__test_plan', tests: [{ title: 'Push while backgrounded', steps: ['Background the app'] }] })
    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...TESTS })

    const waiting = $.tool.call({ tool: 'mcp__breadcrumbs__await_user', id: '1', step: 1, instruction: 'Background the app' })
    let card
    for (let i = 0; i < 50 && !card; i++) card = await ui.find({ type: 'Button', text: 'Done' })
    expect(await ui.find({ type: 'Text', text: /Waiting on you · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⏳ 1' })).toBeDefined()
    await ui.input({ key: String(card?.key).replace(/-done$/, '-input'), text: 'banner showed', kind: 'change' })
    await ui.press({ key: String(card?.key) })
    expect((await waiting).result).toBe('The person answered: Done. banner showed')
    expect(await ui.find({ type: 'Text', text: /Waiting on you/ })).toBeUndefined()

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
      needsYou: [{ question: 'Approve the PR description?', options: ['Yes, approve it as written', 'No'] }],
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
    expect(await ui.find({ type: 'Markdown', text: /Patched the race/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 dead end/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Approve the PR description?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Pushed main to crockalet/breadcrumbs' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 uncommitted · ↑1 unpushed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /❯/ })).toBeUndefined()

    const context = [...files.entries()].find(([p]) => p.endsWith('/context.md'))
    expect(context?.[1]).toContain('# Fix websocket reconnect loop')
    expect(context?.[1]).toContain('- ✗ Patch A with a mutex')
    expect(context?.[1]).toContain('- [ ] Approve the PR description?')

    await ui.press({ key: 'ask-0-opt-0' })
    expect(submitted.at(-1)).toBe('Re: "Approve the PR description?" — Yes, approve it as written')
    expect(await ui.find({ type: 'Text', text: 'Approve the PR description?' })).toBeUndefined()
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

  test('several questions collect answers and send them together', async ($, on) => {
    submitted.length = 0
    const reply = JSON.stringify({
      task: 'Ship the release',
      needsYou: [
        { question: 'Bump the major version?', options: ['Yes', 'No'] },
        { question: 'Who should review it?', options: [] },
      ],
    })
    const { clock } = world(on, reply)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'ship it', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Ready to ship. Bump the major version? Who should review it?', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    submitted.length = 0

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    await ui.press({ key: 'ask-0-opt-1' })
    expect(submitted).toEqual([])
    expect(await ui.find({ key: 'ask-0-opt-1', text: '✓ No' })).toBeDefined()
    await ui.input({ key: 'ask-1-input', text: 'Sam', kind: 'change' })
    await ui.press({ key: 'send-answers' })

    expect(submitted).toEqual(['Answers:\n- "Bump the major version?" — No\n- "Who should review it?" — Sam'])
    expect(await ui.find({ type: 'Text', text: 'Bump the major version?' })).toBeUndefined()
  })

  test('an opened question shows its context and full options, and sends with extra details', async ($, on) => {
    submitted.length = 0
    const long = 'No, assume trip fares include tips and move on to the dashboard'
    const reply = JSON.stringify({
      task: 'Reconcile payouts',
      needsYou: [
        {
          question: 'Run the megatron query to check payout_amount?',
          context: 'Payouts look high; the query tells us whether tips are counted twice.',
          options: [
            { label: "Yes, I'll run it", description: 'You run it and paste the result back' },
            { label: long, description: 'Skip the check and proceed' },
          ],
        },
      ],
    })
    const { clock } = world(on, reply)
    await $.session.start({ cwd: '/code/feat-sync', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'check payouts', wait: false, origin: { kind: 'composer' } })
    await $.turn.complete({ answer: 'Two ways to go. Run the megatron query?', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    submitted.length = 0

    const ui = await $.ui.mount({ plugin: 'breadcrumbs', surface: 'terminal', ...PANE })
    expect(await ui.find({ key: 'ask-0-opt-1', text: long })).toBeUndefined()
    await ui.press({ key: 'ask-0-more' })
    expect(await ui.find({ type: 'Text', text: /tips are counted twice/ })).toBeDefined()
    expect(await ui.find({ key: 'ask-0-opt-1', text: long })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'You run it and paste the result back' })).toBeDefined()

    await ui.press({ key: 'ask-0-opt-0' })
    expect(submitted).toEqual([])
    await ui.input({ key: 'ask-0-details', text: 'use the prod replica', kind: 'change' })
    await ui.press({ key: 'send-answers' })
    expect(submitted).toEqual([`Re: "Run the megatron query to check payout_amount?" — Yes, I'll run it (details: use the prod replica)`])
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
    expect(await ui.find({ type: 'Markdown', text: /Dark mode toggle added/ })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: /Waiting on you/ })).toBeUndefined()
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
