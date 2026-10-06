import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The test runtime has timers; its types don't declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const TOOL = 'mcp__secrets__request_secret'
const DIR = '/var/folders/xy/T/tmp.Q7rk2Lm9'
const VALUE = 'ghp_s3cr3tValue42'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const world = (on: On, stdout = '') => {
  const files = new Map<string, string>()
  const commands: string[] = []
  const prompts: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 6, 9, 0) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__secrets__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  // Stands for the engine's empty band.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('process.run', async ($, e) => {
    const [cmd, ...args] = e.argv
    let out = ''
    let code = 0
    // A real `sleep 1` yields; an instant one would let the wait spin without ever yielding.
    if (cmd === 'sleep') await new Promise<void>(resolve => setTimeout(resolve, 5))
    if (cmd === 'mktemp') out = `${DIR}\n`
    if (cmd === 'sh') files.set(args[3] ?? '', e.init?.stdin ?? '')
    if (cmd === 'cat') {
      const text = files.get(args[0] ?? '')
      if (text === undefined) code = 1
      else out = text
    }
    if (cmd === 'rm') for (const p of args.filter(a => !a.startsWith('-'))) for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
    return { value: { exitCode: code, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    commands.push(e.command)
    return { result: { stdout: stdout || `ran: ${e.command}`, stderr: '', interrupted: false } } as never
  })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text, context: e.context }
  })

  return { files, commands, prompts, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/code/app', surface: null, isInteractive: true })

const slash = ($: Engine, args: string) =>
  $.command.run({ command: 'secrets', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

// Asks for a secret through the tool and answers it in the band.
const provide = async ($: Engine, name: string, value: string | null) => {
  const ui = await $.ui.mount({ plugin: 'secrets', surface: 'terminal', ...BAND })
  const call = $.tool.call({ tool: TOOL, name, why: 'to call the GitHub API' })
  let field
  for (let i = 0; i < 50 && !field; i++) field = await ui.find({ type: 'Input' })
  expect(await ui.find({ type: 'Text', text: /to call the GitHub API/ })).toBeDefined()
  if (value === null) await ui.press({ key: `${String(field?.key)}-cancel` })
  else await ui.input({ key: String(field?.key), text: value })
  const done = await call
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()

  return done
}

const CURL = 'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user'

// The engine's verdict beneath the plugin, set per test.
const verdictOf = (on: On) => {
  const state = { decision: 'ask' as 'allow' | 'ask' | 'deny' }
  on('tool.check', () => ({ decision: state.decision }))
  return state
}

const check = ($: Engine, command: string, agentId?: string) =>
  $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: 'tu', ...(agentId ? { agentId } : {}) } as never)

// Raises a check and answers its approval in the band with one of its buttons.
const answer = async ($: Engine, command: string, button: 'once' | 'session' | 'deny', agentId?: string) => {
  const ui = await $.ui.mount({ plugin: 'secrets', surface: 'terminal', ...BAND })
  const checking = check($, command, agentId)
  let found
  for (let i = 0; i < 50 && !found; i++) found = await ui.find({ type: 'Button', text: 'Deny' })
  const head = await ui.find({ type: 'Text', text: /wants to use/ })
  expect(await ui.find({ type: 'Text', text: /curl -H/ })).toBeDefined()
  await ui.press({ key: String(found?.key).replace(/-deny$/, `-${button}`) })
  const verdict = await checking
  await ui.unmount()

  return { verdict, head: String(head?.text ?? '') }
}

describe('secrets', () => {
  test('the tool result names the secret and never carries its value', async ($, on) => {
    const { files } = world(on)
    await start($)
    const done = await provide($, 'GITHUB_TOKEN', `  ${VALUE}\n`)
    expect(done.result).toBe('GITHUB_TOKEN is set. Use $GITHUB_TOKEN in Bash commands; its value is injected and redacted from output. Never try to print or read it.')
    expect(JSON.stringify(done)).not.toContain(VALUE)
    expect(files.get(`${DIR}/GITHUB_TOKEN`)).toBe(VALUE)

    const listed = await slash($, '')
    expect(listed.text).toContain('GITHUB_TOKEN')
    expect(listed.text).not.toContain(VALUE)
  })

  test('a Bash command using $NAME gets an export of the file, not the value', async ($, on) => {
    const { commands } = world(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: token ${GITHUB_TOKEN}" https://api.github.com/user' })
    await $.tool.call({ tool: 'Bash', command: 'echo $GITHUB_TOKENS' })
    expect(commands[0]).toBe(`export GITHUB_TOKEN="$(cat '${DIR}/GITHUB_TOKEN')"; curl -H "Authorization: token \${GITHUB_TOKEN}" https://api.github.com/user`)
    expect(commands[1]).toBe('echo $GITHUB_TOKENS')
    expect(commands.join('\n')).not.toContain(VALUE)
  })

  test('a tool result holding the value is redacted', async ($, on) => {
    world(on, `token=${VALUE}`)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    const ran = await $.tool.call({ tool: 'Bash', command: 'echo token=$GITHUB_TOKEN' })
    expect(JSON.stringify(ran)).not.toContain(VALUE)
    expect(JSON.stringify(ran.result)).toContain('token=«secret:GITHUB_TOKEN»')
    expect(ran.ref).toBeUndefined()
  })

  test('a prompt holding the value is redacted', async ($, on) => {
    const { prompts } = world(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    await $.prompt.submit({ text: `oops here it is ${VALUE}`, wait: false, origin: { kind: 'composer' } })
    expect(prompts).toEqual(['oops here it is «secret:GITHUB_TOKEN»'])
  })

  test('a value pasted or typed into the prompt box is scrubbed as it lands', async ($, on) => {
    world(on)
    on('prompt.edit', ($, e) => {
      const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
      return { text, cursor: e.start + e.inputText.length }
    })
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    const edit = (text: string, inputText: string) =>
      ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string; cursor: number }> }).edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })

    const pasted = await edit('use ', `${VALUE} now`)
    expect(pasted.text).toBe('use «secret:GITHUB_TOKEN» now')
    expect(pasted.cursor).toBe(pasted.text.length)

    // The last key completes the value: only the resulting draft holds it whole.
    const typed = await edit(`x ${VALUE.slice(0, -1)} y`, VALUE.slice(-1))
    expect(typed.text).not.toContain(VALUE)
    const before = `x ${VALUE.slice(0, -1)}`
    const last = await ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string; cursor: number }> }).edit({ origin: { kind: 'composer' }, text: `${before} y`, cursor: before.length, start: before.length, end: before.length, inputText: VALUE.slice(-1) })
    expect(last.text).toBe('x «secret:GITHUB_TOKEN» y')
    expect(last.cursor).toBe('x «secret:GITHUB_TOKEN»'.length)
  })

  test('rows are scrubbed before the transcript keeps them', async ($, on) => {
    world(on)
    const kept: unknown[] = []
    // The kit has no store beneath session.append, so the call rejects after this records what reached the bottom.
    on('session.append', ($, e) => {
      kept.push(e.message)
      return { message: e.message, uuid: e.uuid }
    })
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    const append = (row: unknown) => $.session.append(row as never).catch(() => undefined)
    await append({
      message: { type: 'user', role: 'user', content: [{ type: 'text', text: `token ${VALUE}` }] },
      door: 'prompt',
      origin: { kind: 'composer' },
      uuid: 'row-1',
    })
    await append({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `out ${VALUE}` }] }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: 'row-2',
    })
    expect(kept).toHaveLength(2)
    expect(JSON.stringify(kept)).not.toContain(VALUE)
    expect(JSON.stringify(kept)).toContain('token «secret:GITHUB_TOKEN»')
    expect(JSON.stringify(kept)).toContain('out «secret:GITHUB_TOKEN»')
    expect(JSON.stringify(kept)).toContain('"tool_use_id":"t1"')
  })

  test('a subagent is told how to use the secrets the person provided', async ($, on) => {
    world(on)
    const prompts: string[] = []
    on('agent.spawn', ($, e) => {
      prompts.push(e.prompt)
      return { model: 'sonnet', agentId: 'a1' }
    })
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'List my repos', description: 'repos', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false } as never)
    expect(prompts[0]).toContain('List my repos\n\nWhen a task needs a secret')
    expect(prompts[0]).toContain('The person provided GITHUB_TOKEN through the secrets mod this session; use $GITHUB_TOKEN in Bash.')
    expect(prompts[0]).not.toContain(VALUE)
  })

  test('an ask on a command using a secret goes to the band; each button decides', async ($, on) => {
    world(on)
    verdictOf(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)

    const once = await answer($, CURL, 'once', 'agent-1')
    expect(once.verdict.decision).toBe('allow')
    expect(once.head).toContain('A subagent wants to use $GITHUB_TOKEN')
    const denied = await answer($, `export GITHUB_TOKEN="$(cat '${DIR}/GITHUB_TOKEN')"; ${CURL}`, 'deny')
    expect(denied.verdict).toMatchObject({ decision: 'deny', reason: 'The person denied using $GITHUB_TOKEN for this command.' })
    expect(denied.head).toContain('Claude wants to use')

    const session = await answer($, CURL, 'session')
    expect(session.verdict.decision).toBe('allow')
    expect((await slash($, '')).text).toContain('Allowed without asking this session: GITHUB_TOKEN.')
    // No band this time: a pending check would hang here.
    expect((await check($, CURL, 'agent-2')).decision).toBe('allow')

    await slash($, 'forget GITHUB_TOKEN')
    await provide($, 'GITHUB_TOKEN', VALUE)
    expect((await answer($, CURL, 'deny')).verdict.decision).toBe('deny')
  })

  test('allow and deny verdicts, and commands without a secret, pass through', async ($, on) => {
    world(on)
    const verdict = verdictOf(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    expect((await check($, 'ls -la')).decision).toBe('ask')
    verdict.decision = 'deny'
    expect((await check($, CURL)).decision).toBe('deny')
    verdict.decision = 'allow'
    expect((await check($, CURL)).decision).toBe('allow')
  })

  test('an approval nobody answers is denied after 10 minutes', async ($, on) => {
    const { clock } = world(on)
    verdictOf(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    const ui = await $.ui.mount({ plugin: 'secrets', surface: 'terminal', ...BAND })
    const checking = check($, CURL)
    let found
    for (let i = 0; i < 50 && !found; i++) found = await ui.find({ type: 'Button', text: 'Deny' })
    await clock.advance(10 * 60_000 + 1)
    const verdict = await checking
    expect(verdict.decision).toBe('deny')
    expect(await ui.find({ type: 'Button', text: 'Deny' })).toBeUndefined()
    await ui.unmount()
  })

  test('cancel tells Claude the person declined and stores nothing', async ($, on) => {
    const { files } = world(on)
    await start($)
    const done = await provide($, 'NPM_TOKEN', null)
    expect(done.result).toContain('declined to provide NPM_TOKEN')
    expect(files.size).toBe(0)
    expect((await slash($, '')).text).toContain('No secrets set')
  })

  test('a bad name is refused before anything is shown', async ($, on) => {
    world(on)
    await start($)
    const done = await $.tool.call({ tool: TOOL, name: 'github-token', why: 'x' })
    expect(done.deny).toContain('env-style name')
  })

  test('a call naming the secrets dir is denied; forget and clear remove values', async ($, on) => {
    const { commands, files } = world(on)
    await start($)
    await provide($, 'GITHUB_TOKEN', VALUE)
    await provide($, 'NPM_TOKEN', 'npm_abcdef')
    const peek = await $.tool.call({ tool: 'Bash', command: 'cat /private/var/folders/xy/T/tmp.Q7rk2Lm9/GITHUB_TOKEN' })
    expect(peek.deny).toContain('$NAME')
    expect(commands).toEqual([])

    expect((await slash($, 'forget NPM_TOKEN')).text).toBe('Removed NPM_TOKEN.')
    expect(files.has(`${DIR}/NPM_TOKEN`)).toBe(false)
    await $.tool.call({ tool: 'Bash', command: 'echo $NPM_TOKEN' })
    expect(commands.at(-1)).toBe('echo $NPM_TOKEN')
    await slash($, 'clear')
    expect(files.size).toBe(0)
  })
})
