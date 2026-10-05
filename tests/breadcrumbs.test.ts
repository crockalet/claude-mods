import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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

const submitted: string[] = []

const world = (on: On, reply = '{}', hasStore = false) => {
  const files = new Map<string, string>()
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/dev' })
  if (!hasStore) mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__breadcrumbs__${e.name}` } }))
  on('session.id', () => ({ value: 'abc123def456' }))
  on('session.cwd', () => ({ value: '/code/feat-sync' }))
  on('session.repo', () => ({ value: { root: '/code/acme-app', remote: null, internal: false, name: null } }))
  on('process.run', ($, e) => {
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
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('model.complete', () => ({
    value: { isAnswered: true, text: reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
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
    expect(await ui.find({ type: 'Text', text: 'Added a theme toggle to SettingsScreen.tsx' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file edited/ })).toBeDefined()
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
})
