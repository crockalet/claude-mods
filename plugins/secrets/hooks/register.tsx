import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { SecretAsk } from '../types'

type $ = EngineInterface
type Secret = [name: string, value: string]
type Answer = 'set' | 'declined'

const TOOL = 'mcp__secrets__request_secret'
const NAME = /^[A-Z_][A-Z0-9_]*$/
const WAIT_LIMIT_MS = 30 * 60_000
const MIN_REDACT = 4

const dirRef = atom({ plugin: 'secrets', key: 'dir' } as const, null)
const namesRef = atom({ plugin: 'secrets', key: 'names' } as const, [])
const asksRef = atom({ plugin: 'secrets', key: 'asks' } as const, [])

const GUIDANCE = [
  `When a task needs a secret (an API token, a password, a key), call ${TOOL} with an env-style name and a one-line reason`,
  'instead of asking the person to paste it into the chat or to export it in a terminal.',
  'Once it is set, reference it only as $NAME (or ${NAME}) inside Bash commands: the value is injected there and redacted from output.',
  'Never echo, print, encode or write the value anywhere, and never read the file it is stored in.',
  'If a permission check denies a command that uses a secret, report the denial instead of changing settings or permissions.',
].join(' ')

// A hot reload resets module variables; the files under the state's dir are the source of truth.
const values = new Map<string, string>()

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const ensureDir = async ($: $): Promise<string> => {
  const known = await read($, dirRef)
  if (known) return known
  const made = await $.process.run(['mktemp', '-d'])
  const dir = made.stdout.trim()
  if (made.exitCode !== 0 || !dir) throw new Error(`mktemp failed: ${made.stderr.trim()}`)
  await update($, dirRef, () => dir)

  return dir
}

const store = async ($: $, name: string, value: string) => {
  const dir = await ensureDir($)
  // umask before cat, so the file is never readable by others even for a moment.
  const wrote = await $.process.run(['sh', '-c', 'umask 077 && cat > "$1"', 'sh', `${dir}/${name}`], { stdin: value })
  if (wrote.exitCode !== 0) throw new Error(`could not save ${name}: ${wrote.stderr.trim()}`)
  values.set(name, value)
  await update($, namesRef, list => (list.includes(name) ? list : [...list, name]))
}

const forget = async ($: $, names: string[]) => {
  const dir = await read($, dirRef)
  if (dir && names.length > 0) await $.process.run(['rm', '-f', ...names.map(n => `${dir}/${n}`)])
  for (const n of names) values.delete(n)
  await update($, namesRef, list => list.filter(n => !names.includes(n)))
}

const secrets = async ($: $): Promise<Secret[]> => {
  const dir = await read($, dirRef)
  if (!dir) return []
  const found: Secret[] = []
  for (const name of await read($, namesRef)) {
    if (!values.has(name)) {
      const got = await $.process.run(['cat', `${dir}/${name}`])
      if (got.exitCode === 0) values.set(name, got.stdout)
    }
    const value = values.get(name)
    if (value !== undefined) found.push([name, value])
  }

  return found
}

const scrub = (v: unknown, list: Secret[], hits: { n: number }): unknown => {
  if (typeof v === 'string') {
    let out = v
    for (const [name, value] of list) {
      if (!out.includes(value)) continue
      hits.n += 1
      out = out.split(value).join(`«secret:${name}»`)
    }
    return out
  }
  if (Array.isArray(v)) return v.map(x => scrub(x, list, hits))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, list, hits)]))

  return v
}

// Longest first, so a value that contains another is replaced whole.
const redactable = (list: Secret[]) => list.filter(([, v]) => v.length >= MIN_REDACT).sort((a, b) => b[1].length - a[1].length)

const redact = (r: ToolCallResult, list: Secret[]): ToolCallResult => {
  if (r.deny !== undefined || list.length === 0) return r
  const hits = { n: 0 }
  const result = scrub(r.result, list, hits)
  const text = r.text === undefined ? undefined : (scrub(r.text, list, hits) as string)
  const context = r.context?.map(c => scrub(c, list, hits) as string)
  if (hits.n === 0) return r
  if (r.isError) return { deny: text ?? (typeof result === 'string' ? result : JSON.stringify(result)) }

  // Without ref, so core maps the scrubbed result instead of reusing its own messages.
  return context ? { result, context } : { result }
}

const mentions = (command: string, name: string) => new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(command)

// A state read inside the waiting hook does not see the press's write, so the answer travels through the module.
const answers = new Map<string, Answer>()

const decide = async ($: $, id: string, answer: Answer) => {
  answers.set(id, answer)
  await update($, asksRef, list => list.filter(a => a.id !== id))
}

const submit = async ($: $, ask: SecretAsk, typed: string) => {
  const value = typed.trim()
  if (!value) {
    $.ui.toast(`Type a value for ${ask.name} first, or press Cancel`)
    return
  }
  await store($, ask.name, value)
  await decide($, ask.id, 'set')
}

const requestSecret = async ($: $, e: Record<string, unknown>, signal: AbortSignal) => {
  const name = str(e.name).trim()
  if (!NAME.test(name)) return { deny: 'name must be an env-style name such as GITHUB_TOKEN: A-Z, 0-9 and _, not starting with a digit.' }
  const why = str(e.why).replace(/\s+/g, ' ').trim().slice(0, 200)
  const now = await $.clock.now()
  const id = `${now}-${Math.random().toString(36).slice(2, 7)}`
  await update($, asksRef, list => [...list, { id, name, why, at: now }])
  $.ui.toast(`Claude needs ${name}: enter it above the prompt`)

  // Waiting inside the hook counts against its budget; time inside a $ call does not.
  let answer: Answer | undefined
  while (answer === undefined && !signal.aborted && (await $.clock.now()) - now < WAIT_LIMIT_MS) {
    await $.process.run(['sleep', '1'])
    answer = answers.get(id)
  }
  answers.delete(id)
  await update($, asksRef, list => list.filter(a => a.id !== id))

  if (answer === 'set') return { result: `${name} is set. Use $${name} in Bash commands; its value is injected and redacted from output. Never try to print or read it.` }
  if (answer === 'declined') return { result: `The person declined to provide ${name}. Continue without it or ask them how to proceed; do not ask for it to be pasted.` }

  return { result: signal.aborted ? `Interrupted before the person entered ${name}.` : `No value for ${name} after 30 minutes.` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'request_secret',
      description:
        'Ask the person for a secret (API token, password, key) through a private field in their UI. Blocks until they enter it or decline. The value never reaches you: afterwards use it as $NAME in Bash commands.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Env-style variable name, e.g. GITHUB_TOKEN' },
          why: { type: 'string', description: 'One line shown to the person: what it is for' },
        },
        required: ['name', 'why'],
      },
    })
    await $.command.register({
      name: 'secrets',
      description: 'List the secrets set this session; `/secrets forget NAME` or `/secrets clear` removes them',
      argumentHint: '[forget NAME | clear]',
    })

    return started
  })

  on('session.end', async ($, e, next) => {
    const dir = await read($, dirRef)
    if (dir) await $.process.run(['rm', '-rf', dir])
    values.clear()
    await update($, dirRef, () => null)
    await update($, namesRef, () => [])

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'secrets:guidance', text: GUIDANCE, scope: 'session' }] }
  })

  // The earliest point: a queued prompt's raw text reaches the transcript file before prompt.submit can scrub it.
  // prompt.compose carries no agentId, so nothing shows a subagent's system prompt gets the section; its task prompt does.
  on('agent.spawn', async ($, e, next) => {
    const names = await read($, namesRef)
    const provided = names.length > 0 ? ` The person provided ${names.join(', ')} through the secrets mod this session; use ${names.map(n => `$${n}`).join(', ')} in Bash.` : ''

    return next({ ...e, prompt: `${e.prompt}\n\n${GUIDANCE}${provided}` })
  })

  on('prompt.edit', async ($, e, next) => {
    const list = redactable(await secrets($))
    if (list.length === 0) return next(e)
    const hits = { n: 0 }
    const inputText = scrub(e.inputText, list, hits) as string
    const r = await next(hits.n > 0 ? { ...e, inputText } : e)
    // A value typed key by key only shows up whole in the draft it completes.
    const text = scrub(r.text, list, hits) as string
    if (hits.n === 0) return r
    $.ui.toast('secrets: replaced a secret value in your prompt with its name', { timeoutMs: 8000 })
    if (text === r.text) return r
    const cursor = Math.max(0, Math.min(text.length, text.length - (r.text.length - r.cursor)))

    // Decorations were laid over the old text's offsets.
    const { decorations: _, ...box } = r

    return { ...box, text, cursor }
  })

  on('session.append', async ($, e, next) => {
    const list = redactable(await secrets($))
    const hits = { n: 0 }
    const content = list.length > 0 ? (scrub(e.message.content, list, hits) as typeof e.message.content) : e.message.content

    return next(hits.n > 0 ? { ...e, message: { ...e.message, content } } : e)
  })

  on('prompt.submit', async ($, e, next) => {
    const hits = { n: 0 }
    const text = scrub(e.text, redactable(await secrets($)), hits) as string
    if (hits.n === 0) return next(e)
    $.ui.toast('secrets: replaced a secret value in your prompt with its name', { timeoutMs: 8000 })

    return next({ ...e, text })
  })

  // A subagent's call to a plugin tool is answered only by a hook matched on that tool.
  on('tool.call', { tool: TOOL }, async ($, e, next) => requestSecret($, e as Record<string, unknown>, next.signal))

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL) return next(e)
    const dir = await read($, dirRef)
    if (!dir) return next(e)
    const tag = dir.split('/').filter(Boolean).pop() ?? dir
    if (JSON.stringify(e).includes(tag)) {
      return { deny: 'secrets: that path holds secret values. Reference a secret as $NAME in a Bash command instead of reading its file.' }
    }
    const list = await secrets($)
    if (e.tool !== 'Bash') return redact(await next(e), redactable(list))
    const used = list.filter(([name]) => mentions(e.command, name))
    const prefix = used.map(([name]) => `export ${name}="$(cat '${dir}/${name}')"; `).join('')

    return redact(await next(prefix ? { ...e, command: prefix + e.command } : e), redactable(list))
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'secrets: its guard failed, so the call was refused.' }))

  on('command.run', { command: 'secrets' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    const names = await read($, namesRef)
    if (verb === 'clear') {
      await forget($, names)
      return { text: names.length > 0 ? `Removed ${names.join(', ')}.` : 'No secrets were set.' }
    }
    if (verb === 'forget') {
      if (!names.includes(arg)) return { text: `No secret named ${arg || '(none given)'}. Set: ${names.join(', ') || 'none'}.` }
      await forget($, [arg])
      return { text: `Removed ${arg}.` }
    }
    if (names.length === 0) return { text: 'No secrets set this session. Claude asks for one with request_secret.' }

    return { text: `Secrets set this session: ${names.join(', ')}. Values are never shown.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const waiting = await read($, asksRef)
    const ask = waiting[0]
    const elements = $.ui.resolve(e)
    if (!ask || e.props.hasSurvey || !('Input' in elements)) return next(e)
    const { Box, Text, Button, Input } = elements
    const isSet = (await read($, namesRef)).includes(ask.name)
    const hint = e.surface === 'terminal' ? 'ctrl+x tab to type here, Enter to save' : 'Enter to save'

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="warning">● </Text>Claude needs <Text bold>{ask.name}</Text>
          {ask.why ? ` · ${ask.why}` : ''}
        </Text>
        <Text dimColor>
          {hint}. Shown here as plain text; Claude never sees it.{isSet ? ' Replaces the current value.' : ''}
          {waiting.length > 1 ? ` ${waiting.length - 1} more waiting.` : ''}
        </Text>
        <Input key={`secret-${ask.id}`} label={`${ask.name}=`} placeholder="paste the value…" submitLabel="save" autoFocus onSubmit={v => submit($, ask, v)} />
        <Box>
          <Button key={`secret-${ask.id}-cancel`} label="Cancel" onPress={() => decide($, ask.id, 'declined')} />
        </Box>
      </Box>
    )
  })
}
