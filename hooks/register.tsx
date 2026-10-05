import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, Crumbs, Note, View, Where } from '../types'
import { contextMarkdown } from './markdown'
import type { Saved } from './markdown'
import { ago, asks, basename, clip, day, head, parseObject, slug, stamp, strings, toolLabel } from './text'

const PANE = 'breadcrumbs'
const SAVE_NOTE = 'mcp__breadcrumbs__save_note'
const EMPTY: Crumbs = {
  tasks: [],
  prompts: [],
  activity: null,
  lastSaid: null,
  notes: [],
  decided: [],
  tried: [],
  needsYou: [],
  asking: null,
}

const crumbs = atom({ plugin: 'breadcrumbs', key: 'crumbs' } as const, EMPTY)
const where = atom({ plugin: 'breadcrumbs', key: 'where' } as const, null)
const view = atom({ plugin: 'breadcrumbs', key: 'view' } as const, {
  openNote: null,
  isShowingPrompts: false,
  isShowingMore: false,
} satisfies View)
const pending = atom({ plugin: 'breadcrumbs', key: 'pending' } as const, null)

const NOTE_GUIDANCE = [
  'The user keeps a "breadcrumbs" pane open beside this session.',
  `When the user asks for an explanation, a summary, a walkthrough or a comparison, write it with the ${SAVE_NOTE} tool`,
  '(a short title and the full markdown body) instead of only in your reply, then reply with one line saying it is saved in the breadcrumbs pane.',
  'Keep doing any task the same message asked for. Do not save notes for status updates or for answers of a sentence or two.',
].join(' ')

type $ = EngineInterface

const notesRoot = async ($: $): Promise<string> =>
  `${(await $.env.get('HOME')) ?? '~'}/.agents/notes`

const locate = async ($: $): Promise<Where> => {
  const cwd = await $.session.cwd()
  const git = async (...args: string[]) => {
    try {
      const run = await $.process.run(['git', ...args], { cwd, timeoutMs: 3000 })

      return run.exitCode === 0 ? run.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  const repo = await $.session.repo()
  const worktree = (await git('rev-parse', '--show-toplevel')) || cwd

  return {
    repo: repo ? basename(repo.root) : basename(worktree),
    branch: await git('branch', '--show-current'),
    worktree,
  }
}

const worktreeDir = (root: string, where: Where) =>
  `${root}/${where.repo}/${basename(where.worktree)}`

const readSaved = async ($: $, dir: string): Promise<Saved | null> => {
  try {
    return JSON.parse(await $.fs.read(`${dir}/state.json`)) as Saved
  } catch {
    return null
  }
}

const writeIndex = async ($: $, wtDir: string) => {
  let entries
  try {
    entries = await $.fs.list(wtDir)
  } catch {
    return
  }
  const rows: { at: number; line: string }[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const saved = await readSaved($, `${wtDir}/${entry.name}`)
    if (!saved) continue
    const task = clip(saved.tasks[0]?.title ?? 'No task yet', 70)
    const notes = saved.notes.length === 1 ? '1 note' : `${saved.notes.length} notes`
    const waiting = asks(saved.needsYou).length > 0 ? ' · needs you' : ''
    rows.push({
      at: saved.updatedAt,
      line: `- ${task}${waiting} · ${notes} · ${stamp(saved.updatedAt)} → [${entry.name}/](${entry.name}/context.md)`,
    })
  }
  if (rows.length === 0) return
  rows.sort((a, b) => b.at - a.at)
  await $.fs.write(`${wtDir}/index.md`, `# ${basename(wtDir)}\n\n${rows.map(r => r.line).join('\n')}\n`)
}

const persist = async ($: $, dir: string, saved: Saved, where: Where, status: string) => {
  await $.fs.write(`${dir}/state.json`, JSON.stringify(saved, null, 2))
  await $.fs.write(`${dir}/context.md`, contextMarkdown(saved, where, status))
  await writeIndex($, dir.slice(0, dir.lastIndexOf('/')))
}

type CleanPlan = {
  archive: { from: string; to: string }[]
  remove: string[]
  touched: string[]
}

type CleanOptions = { now: number; retentionDays: number; archiveDays: number; isArchiving: boolean; keep: string }

const DAY = 86_400_000

const dirs = async ($: $, path: string) => {
  try {
    return (await $.fs.list(path)).filter(e => e.kind === 'dir' && !e.name.startsWith('.'))
  } catch {
    return []
  }
}

const planClean = async ($: $, root: string, o: CleanOptions): Promise<CleanPlan> => {
  const plan: CleanPlan = { archive: [], remove: [], touched: [] }
  for (const repo of await dirs($, root)) {
    if (repo.name.startsWith('_')) continue
    for (const wt of await dirs($, `${root}/${repo.name}`)) {
      if (wt.name.startsWith('_')) continue
      const wtDir = `${root}/${repo.name}/${wt.name}`
      for (const session of await dirs($, wtDir)) {
        const dir = `${wtDir}/${session.name}`
        if (dir === o.keep) continue
        const saved = await readSaved($, dir)
        const updatedAt = saved?.updatedAt ?? (await $.fs.stat(dir)).mtimeMs
        const isGone = saved !== null && !(await $.fs.exists(saved.worktree))
        const isOld = o.now - updatedAt > o.retentionDays * DAY
        if (!isGone && !isOld) continue
        if (o.isArchiving) {
          plan.archive.push({ from: dir, to: `${root}/_archive/${repo.name}/${wt.name}--${session.name}` })
        } else {
          plan.remove.push(dir)
        }
        if (!plan.touched.includes(wtDir)) plan.touched.push(wtDir)
      }
    }
  }
  for (const repo of await dirs($, `${root}/_archive`)) {
    for (const entry of await dirs($, `${root}/_archive/${repo.name}`)) {
      const dir = `${root}/_archive/${repo.name}/${entry.name}`
      let archivedAt: number
      try {
        archivedAt = Number(await $.fs.read(`${dir}/.archived-at`))
      } catch {
        archivedAt = (await $.fs.stat(dir)).mtimeMs
      }
      if (o.now - archivedAt > o.archiveDays * DAY) plan.remove.push(dir)
    }
  }

  return plan
}

const applyClean = async ($: $, root: string, plan: CleanPlan, now: number) => {
  // Every path came from listing `root`, but a bad join must never reach rm.
  const isInside = (p: string) => p.startsWith(`${root}/`) && !p.includes('/../')
  for (const { from, to } of plan.archive) {
    if (!isInside(from) || !isInside(to)) continue
    await $.process.run(['mkdir', '-p', to.slice(0, to.lastIndexOf('/'))])
    const moved = await $.process.run(['mv', from, to])
    if (moved.exitCode === 0) await $.fs.write(`${to}/.archived-at`, String(now))
  }
  for (const dir of plan.remove) {
    if (isInside(dir)) await $.process.run(['rm', '-rf', dir])
  }
  for (const wtDir of plan.touched) {
    if ((await dirs($, wtDir)).length === 0) {
      await $.process.run(['rm', '-rf', wtDir])
    } else {
      await writeIndex($, wtDir)
    }
  }
}

const cfg = { model: 'haiku', retentionDays: 30, archiveDays: 60, isArchiving: true }

let sessionId = ''
let dir: string | null = null
let turnTools: string[] = []
let hasSavedNote = false

const ensureDir = async ($: $, title: string): Promise<string> => {
  if (dir) return dir
  const place = (await read($, where)) ?? (await locate($))
  const now = await $.clock.now()
  dir = `${worktreeDir(await notesRoot($), place)}/${day(now)}-${slug(title, 32)}-${sessionId.slice(0, 6)}`
  await $.store.set(`dir:${sessionId}`, dir)

  return dir
}

const save = async ($: $, status: string) => {
  const state = await read($, crumbs)
  const place = await read($, where)
  if (!place || (state.tasks.length === 0 && state.notes.length === 0)) return
  const target = await ensureDir($, state.tasks[0]?.title ?? 'session')
  const saved: Saved = { ...state, session: sessionId, worktree: place.worktree, updatedAt: await $.clock.now() }
  await persist($, target, saved, place, status)
}

const clean = async ($: $) => {
  const root = await notesRoot($)
  const now = await $.clock.now()
  const plan = await planClean($, root, { ...cfg, now, keep: dir ?? '' })

  return { root, now, plan }
}

type Turn = { answer: string; hasSavedNote: boolean; tools: string[] }

const sidePass = async ($: $, { answer, hasSavedNote, tools }: Turn) => {
  const state = await read($, crumbs)
  const prompt = state.prompts.at(-1)?.text ?? ''
  const request = [
    'You keep a running log of a coding session for a developer who switches between many sessions.',
    'Read the latest exchange and answer with one JSON object and nothing else:',
    '{"task": string, "isNewTask": boolean, "decisions": string[], "attempts": [{"text": string, "isOk": boolean}], "needsYou": [{"question": string, "options": string[]}], "note": {"title": string, "markdown": string} | null}',
    '- task: the overall goal of the whole session in under 60 characters, imperative ("Fix websocket reconnect loop"), judged from all the recent prompts, not just this turn\'s step. Keep the current task\'s wording unless it is wrong.',
    '- isNewTask: true only when the user clearly moved on to a different goal, not a follow-up.',
    '- decisions: design or approach choices the assistant made on its own this turn where another option was reasonable and the user did not specify it ("Capped backoff at 30s instead of 60s"). Not actions taken, checks run or instructions given to the user. At most 3, under 90 characters each. Usually empty.',
    '- needsYou: what the reply leaves for the user to answer or decide: explicit questions, approvals, choices between options. Each question is short, under 80 characters ("Approve the PR description?"). options: 2 to 4 short answer labels when the question has discrete choices ("Yes", "No", or the named options), else []. Empty list when the reply asks nothing.',
    '- attempts: approaches tried this turn, isOk false when one failed or was abandoned (at most 3). Empty when none.',
    '- note: only when the user asked for an explanation or summary, the reply contains it at a paragraph or more (not a one-line answer), and it was not saved already. markdown is that explanation, kept close to the reply\'s own words. Otherwise null.',
    '',
    `Current task: ${state.tasks[0]?.title ?? '(none yet)'}`,
    `Earlier prompts, oldest first: ${state.prompts.slice(0, -1).map(p => JSON.stringify(clip(p.text, 200))).join(' | ') || 'none'}`,
    `Already saved a note this turn: ${hasSavedNote}`,
    `Tools used this turn: ${tools.slice(0, 30).join('; ') || 'none'}`,
    '',
    '<user_prompt>',
    clip(prompt, 4000),
    '</user_prompt>',
    '<assistant_reply>',
    answer.slice(0, 12000),
    '</assistant_reply>',
  ].join('\n')

  const reply = await $.model.complete({ model: cfg.model, prompt: request, maxTokens: 4000, effort: 'low', timeoutMs: 60_000 })
  if (!reply.isAnswered) {
    $.ui.log(`side pass skipped (${reply.reason})`)
    return
  }
  const out = parseObject(reply.text)
  if (!out) {
    $.ui.log(`side pass: unparseable reply (${clip(reply.text, 120)})`, { to: 'debug' })
    return
  }

  const now = await $.clock.now()
  const task = typeof out.task === 'string' ? clip(out.task, 70) : ''
  const attempts = Array.isArray(out.attempts)
    ? out.attempts
        .filter((a): a is { text: string; isOk?: unknown } => typeof a?.text === 'string')
        .slice(0, 3)
        .map(a => ({ text: clip(a.text, 100), isOk: a.isOk !== false }))
    : []
  await update($, crumbs, c => {
    let tasks = c.tasks
    if (task && (tasks.length === 0 || out.isNewTask === true)) {
      tasks = [{ title: task, at: now }, ...tasks].slice(0, 6)
    } else if (task && tasks[0]) {
      tasks = [{ ...tasks[0], title: task }, ...tasks.slice(1)]
    }

    return {
      ...c,
      tasks,
      decided: [...c.decided, ...strings(out.decisions, 3, 90)].slice(-20),
      tried: [...c.tried, ...attempts].slice(-20),
      needsYou: asks(out.needsYou),
    }
  })

  const note = out.note as { title?: unknown; markdown?: unknown } | null
  if (!hasSavedNote && note && typeof note.title === 'string' && typeof note.markdown === 'string' && note.markdown.trim()) {
    await saveNote($, note.title, note.markdown)
  }
}

// Pending lives in session state, so a reload (which drops timers) can pick the pass back up.
const runPending = async ($: $) => {
  try {
    const raw = await read($, pending)
    if (raw === null) return
    await update($, pending, () => null)
    await sidePass($, JSON.parse(raw) as Turn)
    await save($, 'idle')
  } catch (error) {
    // A timer callback's rejection is otherwise swallowed without a trace.
    $.ui.log(`side pass failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const saveNote = async ($: $, title: string, markdown: string): Promise<Note> => {
  const state = await read($, crumbs)
  const target = await ensureDir($, state.tasks[0]?.title ?? title)
  const now = await $.clock.now()
  const number = String(state.notes.length + 1).padStart(2, '0')
  const file = `${target}/${number}-${slug(title)}.md`
  await $.fs.write(file, `---\ntitle: ${title.replace(/\n/g, ' ')}\ntask: ${state.tasks[0]?.title ?? ''}\nsession: ${sessionId}\n---\n\n# ${title}\n\n${markdown.trim()}\n`)
  const note: Note = { id: `${now}-${number}`, title: clip(title, 80), file, at: now, isPinned: false }
  await update($, crumbs, c => ({ ...c, notes: [...c.notes, note] }))
  await save($, 'working')

  return note
}

const pin = async ($: $, note: Note) => {
  const place = await read($, where)
  if (!place) return
  const text = await $.fs.read(note.file)
  await $.fs.write(`${await notesRoot($)}/${place.repo}/_pinned/${basename(note.file)}`, text)
  await update($, crumbs, c => ({ ...c, notes: c.notes.map(n => (n.id === note.id ? { ...n, isPinned: true } : n)) }))
  await save($, 'working')
  $.ui.toast(`Pinned "${note.title}"`)
}

const dropAsk = ($: $, question: string) =>
  update($, crumbs, c => ({ ...c, needsYou: c.needsYou.filter(a => a.question !== question) }))

const answerAsk = async ($: $, ask: Ask, option: string) => {
  await dropAsk($, ask.question)
  // Queued by the engine until the session is idle, so pressing mid-turn is safe.
  await $.prompt.submit({ text: `Re: "${ask.question}" — ${option}`, asUser: true })
}

const draftAsk = async ($: $, ask: Ask) => {
  await $.prompt.fill({ text: `Re: "${ask.question}" — `, mode: 'insert' })
  $.ui.toast('Finish your answer in the prompt box')
}

export const register: Register = (on, options) => {
  cfg.model = String(options.model ?? 'haiku')
  cfg.retentionDays = Number(options.retentionDays ?? 30)
  cfg.archiveDays = Number(options.archiveDays ?? 60)
  cfg.isArchiving = options.archive !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionId = await $.session.id()
    const place = await locate($)
    await update($, where, () => place)

    const known = await $.store.get(`dir:${sessionId}`)
    dir = typeof known === 'string' ? known : null
    const current = await read($, crumbs)
    if (dir && current.tasks.length === 0 && current.notes.length === 0) {
      const saved = await readSaved($, dir)
      if (saved) {
        const { session: _s, worktree: _w, updatedAt: _u, ...restored } = saved
        await update($, crumbs, () => ({ ...EMPTY, ...restored, needsYou: asks(restored.needsYou), activity: null, asking: null }))
      }
    }

    await $.command.register({
      name: 'whereami',
      description: 'Show or hide the breadcrumbs pane; `/whereami clean` tidies old session notes',
    })
    await $.tool.register({
      name: 'save_note',
      description:
        'Save an explanation, summary or walkthrough the user asked for as a markdown note in their breadcrumbs pane, so it does not get buried in the transcript.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title, under 60 characters' },
          markdown: { type: 'string', description: 'The full explanation in markdown' },
        },
        required: ['title', 'markdown'],
      },
    })

    if (e.isInteractive && options.panel !== 'command') void $.ui.open({ id: PANE, title: 'breadcrumbs' })
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    // A hot reload drops the old module's timers, including a pass it just queued; poll so this copy picks it up.
    $.clock.every(15_000, () => runPending($))

    const now = await $.clock.now()
    const lastClean = Number((await $.store.get('lastClean')) ?? 0)
    if (now - lastClean > 86_400_000) {
      await $.store.set('lastClean', now)
      $.clock.after(5000, async () => {
        const { root, plan } = await clean($)
        await applyClean($, root, plan, now)
        const count = plan.archive.length + plan.remove.length
        if (count > 0) $.ui.log(`breadcrumbs: tidied ${count} old session folder(s)`, { to: 'debug' })
      })
    }

    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { sections: [...composed.sections, { id: 'breadcrumbs:notes', text: NOTE_GUIDANCE, scope: 'session' }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || (e.origin.kind === 'plugin' && e.origin.name === 'breadcrumbs')
    if (isPerson && e.text.trim() && !e.text.trimStart().startsWith('/')) {
      const now = await $.clock.now()
      // A new prompt usually answers what was pending; the next side pass re-asks anything still open.
      await update($, crumbs, c => ({ ...c, needsYou: [], prompts: [...c.prompts, { text: e.text.trim(), at: now }].slice(-5) }))
      if (e.turnId === undefined) {
        turnTools = []
        hasSavedNote = false
      }
    }

    return next(e)
  })

  on('tool.call', { tool: SAVE_NOTE }, async ($, e) => {
    const title = typeof e.title === 'string' ? e.title : 'Note'
    const markdown = typeof e.markdown === 'string' ? e.markdown : ''
    if (!markdown.trim()) return { deny: 'save_note needs a non-empty markdown body.' }
    hasSavedNote = true
    const note = await saveNote($, title, markdown)

    return { result: `Saved "${note.title}" to the breadcrumbs pane (${note.file}). Tell the user in one line where to find it.` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || String(e.tool) === SAVE_NOTE) return next(e)
    const label = toolLabel(String(e.tool), e as Record<string, unknown>)
    turnTools.push(label)
    if (e.tool !== 'AskUserQuestion') {
      await update($, crumbs, c => ({ ...c, activity: label }))
      return next(e)
    }
    const question = e.questions[0]?.question ?? 'A question for you'
    await update($, crumbs, c => ({ ...c, activity: 'Waiting on you', asking: clip(question, 120) }))
    try {
      return await next(e)
    } finally {
      await update($, crumbs, c => ({ ...c, activity: null, asking: null }))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const now = await $.clock.now()
    const answer = e.answer.trim()
    await update($, crumbs, c => ({
      ...c,
      activity: null,
      lastSaid: answer ? { text: head(answer, 600), at: now } : c.lastSaid,
    }))
    if (answer && !e.isAborted) {
      const turn: Turn = { answer, hasSavedNote, tools: turnTools }
      await update($, pending, () => JSON.stringify(turn))
      // Off the turn's dispatch, so the next prompt never waits on the side pass.
      $.clock.after(0, () => runPending($))
    } else {
      await save($, 'idle')
    }

    return done
  })

  on('command.run', { command: 'whereami' }, async ($, e) => {
    if (e.args.trim() === 'clean') {
      const { root, now, plan } = await clean($)
      const count = plan.archive.length + plan.remove.length
      if (count === 0) return { text: 'Nothing to clean up.' }
      const lines = [
        ...plan.archive.map(a => `archive ${a.from.slice(root.length + 1)}`),
        ...plan.remove.map(r => `delete  ${r.slice(root.length + 1)}`),
      ]
      const answer = await $.ui.ask(`Clean up ${count} session folder(s)?\n${lines.slice(0, 12).join('\n')}`, ['Clean up', 'Cancel'])
      if (answer !== 'Clean up') return { text: 'Left the notes as they were.' }
      await applyClean($, root, plan, now)

      return { text: `Cleaned up ${count} session folder(s) under ${root}.` }
    }

    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Breadcrumbs pane hidden.' }
    }
    await $.ui.open({ id: PANE, title: 'breadcrumbs' })

    return { text: 'Breadcrumbs pane shown.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const c = await read($, crumbs)
    const place: Where | null = await read($, where)
    const v = await read($, view)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    const set = (patch: Partial<View>) => () => update($, view, old => ({ ...old, ...patch }))

    const task = c.tasks[0]
    const prompt = c.prompts.at(-1)
    const earlier = c.prompts.slice(0, -1).reverse()
    const notes = [...c.notes].reverse().slice(0, 8)
    const open = c.notes.find(n => n.id === v.openNote)
    let openText = ''
    if (open) {
      try {
        openText = (await $.fs.read(open.file)).replace(/^---\n[\s\S]*?\n---\n+/, '')
      } catch {
        openText = '_This note file is gone._'
      }
    }
    const deadEnds = c.tried.filter(t => !t.isOk).length

    return (
      <Box flexDirection="column" gap={1}>
        {place && (
          <Text dimColor wrap="truncate-end">
            {place.branch ? `${place.repo} · ${place.branch}` : place.repo}
          </Text>
        )}

        <Box flexDirection="column">
          <Box>
            <Text color="claude">● </Text>
            <Text bold={task !== undefined} dimColor={task === undefined}>
              {task ? task.title : 'Waiting for the first prompt…'}
            </Text>
          </Box>
          {c.tasks.length > 1 && (
            <Text dimColor wrap="truncate-end">
              {'  ⎿ before: '}
              {c.tasks.slice(1).map(t => t.title).join(' · ')}
            </Text>
          )}
        </Box>

        {(c.asking || c.needsYou.length > 0) && (
          <Box flexDirection="column">
            <Text color="warning">Needs you</Text>
            {c.asking && (
              <Box flexDirection="column">
                <Box>
                  <Text color="warning">{'● '}</Text>
                  <Text bold>{c.asking}</Text>
                </Box>
                <Text dimColor>{'  answer in the dialog below'}</Text>
              </Box>
            )}
            {c.needsYou.map((ask, i) => (
              <Box key={`ask-${i}`} flexDirection="column">
                <Box>
                  <Text color="warning">{'◆ '}</Text>
                  <Text>{ask.question}</Text>
                </Box>
                <Box marginLeft={2} columnGap={1} flexWrap="wrap">
                  {ask.options.map((option, j) => (
                    <Button key={`ask-${i}-opt-${j}`} label={option} onPress={() => answerAsk($, ask, option)} />
                  ))}
                  <Button key={`ask-${i}-reply`} plain dimColor label="reply…" onPress={() => draftAsk($, ask)} />
                  <Button key={`ask-${i}-dismiss`} plain dimColor label="dismiss" onPress={() => dropAsk($, ask.question)} />
                </Box>
              </Box>
            ))}
          </Box>
        )}

        {prompt && (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text dimColor>You asked · {ago(prompt.at, now)}</Text>
              {earlier.length > 0 && (
                <Button key="prompts" plain dimColor label={v.isShowingPrompts ? 'less' : 'earlier'} onPress={set({ isShowingPrompts: !v.isShowingPrompts })} />
              )}
            </Box>
            <Box>
              <Text dimColor>{'❯ '}</Text>
              <Text>{clip(prompt.text, width * 4)}</Text>
            </Box>
            {v.isShowingPrompts &&
              earlier.map(p => (
                <Text dimColor wrap="truncate-end">
                  {'  '}
                  {ago(p.at, now)} · {clip(p.text, width * 2)}
                </Text>
              ))}
          </Box>
        )}

        {(c.activity || c.lastSaid) && (
          <Box flexDirection="column">
            <Text dimColor>Claude{c.lastSaid && !c.activity ? ` · ${ago(c.lastSaid.at, now)}` : ''}</Text>
            {c.activity && (
              <Box>
                <Text color="claude">● </Text>
                <Text wrap="truncate-end">{c.activity}</Text>
              </Box>
            )}
            {c.lastSaid && (
              <Box>
                <Text dimColor>{'⎿ '}</Text>
                <Box flexShrink={1}>
                  <Markdown key="last-said" dimColor text={head(c.lastSaid.text, width * 4)} />
                </Box>
              </Box>
            )}
          </Box>
        )}

        {notes.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Notes · {c.notes.length}</Text>
            {notes.map(n => (
              <Box key={`row-${n.id}`} justifyContent="space-between">
                <Button
                  key={`note-${n.id}`}
                  plain
                  label={`${n.id === v.openNote ? '▾' : '▸'} ${clip(n.title, width - 10)}${n.isPinned ? ' ★' : ''}`}
                  onPress={set({ openNote: n.id === v.openNote ? null : n.id })}
                />
                <Text dimColor>{ago(n.at, now)}</Text>
              </Box>
            ))}
            {open && (
              <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                <Markdown key="note-body" text={openText} />
                <Box gap={2}>
                  {!open.isPinned && <Button key="pin" label="Pin" onPress={() => pin($, open)} />}
                  <Button key="close-note" label="Close" onPress={set({ openNote: null })} />
                </Box>
              </Box>
            )}
          </Box>
        )}

        {(c.decided.length > 0 || c.tried.length > 0) && (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text dimColor>
                {c.decided.length} decided · {c.tried.length} tried
                {deadEnds > 0 ? ` · ${deadEnds} dead end${deadEnds > 1 ? 's' : ''}` : ''}
              </Text>
              <Button key="more" plain dimColor label={v.isShowingMore ? 'less' : 'more'} onPress={set({ isShowingMore: !v.isShowingMore })} />
            </Box>
            {v.isShowingMore && (
              <Box flexDirection="column">
                {c.decided.slice(-6).map(d => (
                  <Box>
                    <Text color="suggestion">{'· '}</Text>
                    <Text>{d}</Text>
                  </Box>
                ))}
                {c.tried.slice(-6).map(t => (
                  <Box>
                    <Text color={t.isOk ? 'success' : 'error'}>{t.isOk ? '✓ ' : '✗ '}</Text>
                    <Text dimColor={!t.isOk}>{t.text}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
