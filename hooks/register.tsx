import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Ask, Crumbs, Note, Repo, View, Where } from '../types'
import { contextMarkdown, repoState } from './markdown'
import { normalize } from './state'
import type { Saved } from './markdown'
import { ago, asks, basename, cdTarget, clip, day, head, parseObject, parseStatus, slug, stamp, strings, toolLabel } from './text'

const PANE = 'breadcrumbs'
const SAVE_NOTE = 'mcp__breadcrumbs__save_note'

const crumbs = atom({ plugin: 'breadcrumbs', key: 'crumbs' } as const, normalize({}))
const where = atom({ plugin: 'breadcrumbs', key: 'where' } as const, null)
const VIEW: View = {
  openNote: null,
  isShowingPrompts: false,
  isShowingMore: false,
  isShowingStatus: false,
  picked: {},
  typed: {},
  details: {},
  expanded: null,
}
const view = atom({ plugin: 'breadcrumbs', key: 'view' } as const, VIEW)
const pending = atom({ plugin: 'breadcrumbs', key: 'pending' } as const, null)

const NOTE_GUIDANCE = [
  'The user keeps a "breadcrumbs" pane open beside this session.',
  `When the user asks for an explanation, a summary, a walkthrough or a comparison, write it with the ${SAVE_NOTE} tool`,
  '(a short title and the full markdown body) instead of only in your reply, then reply with one line saying it is saved in the breadcrumbs pane.',
  'Keep doing any task the same message asked for. Do not save notes for status updates or for answers of a sentence or two.',
].join(' ')

type $ = EngineInterface

// Session state outlives reloads, so it can predate fields added since; every access goes through normalize.
const readCrumbs = async ($: $): Promise<Crumbs> => normalize(await read($, crumbs))

const mutate = ($: $, fn: (c: Crumbs) => Crumbs) => update($, crumbs, c => fn(normalize(c)))

const notesRoot = async ($: $): Promise<string> =>
  `${(await $.env.get('HOME')) ?? '~'}/.agents/notes`

const git = async ($: $, cwd: string, ...args: string[]): Promise<string | null> => {
  try {
    const run = await $.process.run(['git', ...args], { cwd, timeoutMs: 3000 })

    return run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

const locate = async ($: $): Promise<Where> => {
  const cwd = await $.session.cwd()
  const repo = await $.session.repo()
  const worktree = (await git($, cwd, 'rev-parse', '--show-toplevel'))?.trim() || cwd

  return {
    repo: repo ? basename(repo.root) : basename(worktree),
    branch: (await git($, cwd, 'branch', '--show-current'))?.trim() ?? '',
    worktree,
  }
}

const refreshRepos = async ($: $) => {
  const c = await readCrumbs($)
  const place = await read($, where)
  const places = new Set([...c.touched, ...c.edited.map(f => f.slice(0, f.lastIndexOf('/')))])
  if (place) places.add(place.worktree)
  const roots = new Set<string>()
  for (const dir of places) {
    const root = (await git($, dir, 'rev-parse', '--show-toplevel'))?.trim()
    if (root) roots.add(root)
  }
  const repos: Repo[] = []
  for (const root of roots) {
    const status = await git($, root, 'status', '--porcelain=v1', '-b')
    if (status !== null) repos.push({ root, ...parseStatus(status) })
  }
  await mutate($, old => ({ ...old, repos }))
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
  const state = await readCrumbs($)
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

// `transcript` set means a one-off catch-up over a session that predates the mod.
type Turn = { answer: string; hasSavedNote: boolean; tools: string[]; transcript?: string }

const sidePass = async ($: $, { answer, hasSavedNote, tools, transcript }: Turn) => {
  const cap = transcript ? 6 : 3
  const state = await readCrumbs($)
  const prompt = state.prompts.at(-1)?.text ?? ''
  const request = [
    'You keep a running log of a coding session for a developer who switches between many sessions.',
    transcript
      ? 'Read this transcript of the session so far and answer with one JSON object and nothing else. It is a catch-up: read "this turn" below as "the session so far", allow up to 6 decisions, attempts and done items, and take needsYou only from the last assistant message.'
      : 'Read the latest exchange and answer with one JSON object and nothing else:',
    '{"task": string, "isNewTask": boolean, "decisions": string[], "attempts": [{"text": string, "isOk": boolean}], "needsYou": [{"question": string, "context": string, "options": [{"label": string, "description": string}]}], "done": string[], "note": {"title": string, "markdown": string} | null}',
    '- task: the overall goal of the whole session in under 60 characters, imperative ("Fix websocket reconnect loop"), judged from all the recent prompts, not just this turn\'s step. Keep the current task\'s wording unless it is wrong or too narrow: when the prompts show the current task is one step of a bigger goal, widen it to that goal ("Verify the restart" becomes "Build the breadcrumbs mod").',
    '- isNewTask: true only when the user clearly moved on to a different goal, not a follow-up.',
    '- decisions: design or approach choices the assistant made on its own this turn where another option was reasonable and the user did not specify it ("Capped backoff at 30s instead of 60s"). Not actions taken, checks run or instructions given to the user. At most 3, under 90 characters each. Usually empty.',
    '- done: concrete results of this turn, from the assistant reply and tools used, that changed something outside the conversation, past tense, naming what changed ("Pushed main to crockalet/breadcrumbs", "Installed breadcrumbs plugin (user scope)", "Fixed reconnect race in socket.ts"). Not reads, checks, explanations or plans. At most 3, under 90 characters each. Usually empty.',
    '- needsYou: what the assistant reply itself asks the user to answer or decide (never questions inferred from the earlier prompts or the task): explicit questions, approvals, choices between options. Each question is short, under 80 characters ("Approve the PR description?"). context: one or two sentences from the reply that someone needs to answer well (what is at stake, what each choice leads to). options: 2 to 4 when the question has discrete choices, each a short label ("Yes, I\'ll run it") and a one-line description of what that choice means, else []. Empty list when the reply asks nothing.',
    '- attempts: approaches tried this turn, isOk false when one failed or was abandoned (at most 3). Empty when none.',
    '- note: only when the user asked for an explanation or summary, the reply contains it at a paragraph or more (not a one-line answer), and it was not saved already. markdown is that explanation, kept close to the reply\'s own words. Otherwise null.',
    '',
    `Current task: ${state.tasks[0]?.title ?? '(none yet)'}`,
    `Earlier prompts, oldest first (context for the task only; already handled): ${state.prompts.slice(0, -1).map(p => JSON.stringify(clip(p.text, 200))).join(' | ') || 'none'}`,
    `Already saved a note this turn: ${hasSavedNote}`,
    `Tools used this turn: ${tools.slice(0, 30).join('; ') || 'none'}`,
    '',
    ...(transcript
      ? ['<transcript>', transcript, '</transcript>']
      : ['<user_prompt>', clip(prompt, 4000), '</user_prompt>', '<assistant_reply>', answer.slice(0, 12000), '</assistant_reply>']),
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
        .slice(0, cap)
        .map(a => ({ text: clip(a.text, 100), isOk: a.isOk !== false }))
    : []
  await mutate($, c => {
    let tasks = c.tasks
    if (task && (tasks.length === 0 || out.isNewTask === true)) {
      tasks = [{ title: task, at: now }, ...tasks].slice(0, 6)
    } else if (task && tasks[0]) {
      tasks = [{ ...tasks[0], title: task }, ...tasks.slice(1)]
    }

    return {
      ...c,
      tasks,
      decided: [...c.decided, ...strings(out.decisions, cap, 90)].slice(-20),
      tried: [...c.tried, ...attempts].slice(-20),
      // Haiku sometimes turns the user's own requests into questions; a reply that asks nothing has none.
      needsYou: answer.includes('?') ? asks(out.needsYou) : [],
      done: [...c.done, ...strings(out.done, cap, 90).map(text => ({ text, at: now }))].slice(-30),
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
  const state = await readCrumbs($)
  const target = await ensureDir($, state.tasks[0]?.title ?? title)
  const now = await $.clock.now()
  const number = String(state.notes.length + 1).padStart(2, '0')
  const file = `${target}/${number}-${slug(title)}.md`
  await $.fs.write(file, `---\ntitle: ${title.replace(/\n/g, ' ')}\ntask: ${state.tasks[0]?.title ?? ''}\nsession: ${sessionId}\n---\n\n# ${title}\n\n${markdown.trim()}\n`)
  const note: Note = { id: `${now}-${number}`, title: clip(title, 80), file, at: now, isPinned: false }
  await mutate($, c => ({ ...c, notes: [...c.notes, note] }))
  await save($, 'working')

  return note
}

const pin = async ($: $, note: Note) => {
  const place = await read($, where)
  if (!place) return
  const text = await $.fs.read(note.file)
  await $.fs.write(`${await notesRoot($)}/${place.repo}/_pinned/${basename(note.file)}`, text)
  await mutate($, c => ({ ...c, notes: c.notes.map(n => (n.id === note.id ? { ...n, isPinned: true } : n)) }))
  await save($, 'working')
  $.ui.toast(`Pinned "${note.title}"`)
}

const track = async ($: $, e: Record<string, unknown>) => {
  const file = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : ''
  if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') && file) {
    await mutate($, c => ({ ...c, edited: [...c.edited.filter(f => f !== file), file].slice(-50) }))
  }
  if (e.tool === 'Bash' && typeof e.command === 'string') {
    const dir = cdTarget(e.command, (await $.env.get('HOME')) ?? '')
    if (dir) await mutate($, c => ({ ...c, touched: [...c.touched.filter(d => d !== dir), dir].slice(-20) }))
  }
}

const isTyped = (m: SessionMessage) =>
  m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length && !m.text.trimStart().startsWith('<')

// A session that was running before the mod was installed has history but no breadcrumbs yet.
const backfill = async ($: $) => {
  const current = await readCrumbs($)
  if (current.tasks.length > 0 || current.prompts.length > 0) return
  let rows: readonly SessionMessage[]
  try {
    rows = await $.session.messages()
  } catch {
    return
  }
  if (!rows.some(isTyped)) return

  const now = await $.clock.now()
  const home = (await $.env.get('HOME')) ?? ''
  const edited: string[] = []
  const touched: string[] = []
  const lines: string[] = []
  for (const m of rows) {
    if (isTyped(m)) lines.push(`User: ${clip(m.text, 1500)}`)
    if (m.role !== 'assistant') continue
    if (m.text.trim()) lines.push(`Claude: ${clip(m.text, 2500)}`)
    for (const use of m.toolUses) {
      lines.push(`  [${toolLabel(use.tool, use.input)}]`)
      if (use.isError) continue
      const file = use.input.file_path ?? use.input.notebook_path
      if ((use.tool === 'Edit' || use.tool === 'Write' || use.tool === 'NotebookEdit') && typeof file === 'string') edited.push(file)
      const dir = use.tool === 'Bash' && typeof use.input.command === 'string' ? cdTarget(use.input.command, home) : null
      if (dir) touched.push(dir)
    }
  }
  const lastSaid = [...rows].reverse().find(m => m.role === 'assistant' && m.text.trim())
  await mutate($, c => ({
    ...c,
    prompts: rows.filter(isTyped).slice(-5).map(m => ({ text: m.text.trim(), at: now })),
    lastSaid: lastSaid ? { text: head(lastSaid.text.trim(), 600), at: now } : c.lastSaid,
    edited: [...new Set(edited)].slice(-50),
    touched: [...new Set(touched)].slice(-20),
  }))
  await refreshRepos($)
  await sidePass($, { answer: lastSaid?.text ?? '', hasSavedNote: true, tools: [], transcript: lines.join('\n').slice(-30_000) })
  await save($, 'idle')
}

const dropAsk = ($: $, question: string) =>
  mutate($, c => ({ ...c, needsYou: c.needsYou.filter(a => a.question !== question) }))

const answerAsk = async ($: $, ask: Ask, option: string) => {
  await dropAsk($, ask.question)
  // Queued by the engine until the session is idle, so pressing mid-turn is safe.
  await $.prompt.submit({ text: `Re: "${ask.question}" — ${option}`, asUser: true })
}

const setView = ($: $, fn: (v: View) => View) => update($, view, old => fn({ ...VIEW, ...old }))

const answerOf = (v: View, question: string) => v.typed[question]?.trim() || v.picked[question] || ''

const withDetails = (v: View, question: string, answer: string) => {
  const details = v.details[question]?.trim()
  if (!details) return answer
  return answer ? `${answer} (details: ${details})` : details
}

// With one question a choice is the whole answer; with several, choices collect until Send.
const pickAsk = async ($: $, ask: Ask, option: string) => {
  const { needsYou } = await readCrumbs($)
  const v = { ...VIEW, ...(await read($, view)) }
  // An open question is where details get added, so a choice there waits for Send.
  if (needsYou.length <= 1 && v.expanded !== ask.question) return answerAsk($, ask, withDetails(v, ask.question, option))
  await setView($, v => {
    const picked = { ...v.picked }
    if (picked[ask.question] === option) delete picked[ask.question]
    else picked[ask.question] = option
    return { ...v, picked }
  })
}

const typeAsk = ($: $, ask: Ask, text: string) =>
  setView($, v => ({ ...v, typed: { ...v.typed, [ask.question]: text } }))

const submitTyped = async ($: $, ask: Ask, text: string) => {
  const { needsYou } = await readCrumbs($)
  const v = { ...VIEW, ...(await read($, view)) }
  if (needsYou.length <= 1 && v.expanded !== ask.question && text.trim()) return answerAsk($, ask, withDetails(v, ask.question, text.trim()))
  await typeAsk($, ask, text)
}

const sendAnswers = async ($: $) => {
  const { needsYou } = await readCrumbs($)
  const v = { ...VIEW, ...(await read($, view)) }
  const answered = needsYou
    .map(a => ({ ask: a, answer: withDetails(v, a.question, answerOf(v, a.question)) }))
    .filter(a => a.answer)
  if (answered.length === 0) {
    $.ui.toast('Pick or type an answer first')
    return
  }
  const text =
    answered.length === 1
      ? `Re: "${answered[0]?.ask.question}" — ${answered[0]?.answer}`
      : ['Answers:', ...answered.map(a => `- "${a.ask.question}" — ${a.answer}`)].join('\n')
  const done = new Set(answered.map(a => a.ask.question))
  await mutate($, c => ({ ...c, needsYou: c.needsYou.filter(a => !done.has(a.question)) }))
  await setView($, old => ({ ...old, picked: {}, typed: {}, details: {}, expanded: null }))
  await $.prompt.submit({ text, asUser: true })
}

const detailAsk = ($: $, ask: Ask, text: string) =>
  setView($, v => ({ ...v, details: { ...v.details, [ask.question]: text } }))

const toggleAsk = ($: $, ask: Ask) =>
  setView($, v => ({ ...v, expanded: v.expanded === ask.question ? null : ask.question }))

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
    const current = await readCrumbs($)
    if (dir && current.tasks.length === 0 && current.notes.length === 0) {
      const saved = await readSaved($, dir)
      if (saved) {
        const { session: _s, worktree: _w, updatedAt: _u, ...restored } = saved
        await mutate($, () => ({ ...normalize(restored), activity: null, asking: null }))
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
    $.clock.after(0, () => refreshRepos($))
    $.clock.after(0, () => backfill($))
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
      await mutate($, c => ({ ...c, needsYou: [], prompts: [...c.prompts, { text: e.text.trim(), at: now }].slice(-5) }))
      await setView($, v => ({ ...v, picked: {}, typed: {}, details: {}, expanded: null }))
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
      await mutate($, c => ({ ...c, activity: label }))
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) await track($, e as Record<string, unknown>)
      return ran
    }
    const question = e.questions[0]?.question ?? 'A question for you'
    await mutate($, c => ({ ...c, activity: 'Waiting on you', asking: clip(question, 120) }))
    try {
      return await next(e)
    } finally {
      await mutate($, c => ({ ...c, activity: null, asking: null }))
    }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    await refreshRepos($)
    const now = await $.clock.now()
    const answer = e.answer.trim()
    await mutate($, c => ({
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
    const c = await readCrumbs($)
    const place: Where | null = await read($, where)
    const v = { ...VIEW, ...(await read($, view)) }
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    const set = (patch: Partial<View>) => () => setView($, old => ({ ...old, ...patch }))
    const elements = $.ui.resolve(e)
    const Input = 'Input' in elements ? elements.Input : undefined
    const isMany = c.needsYou.length > 1
    const answeredCount = c.needsYou.filter(a => withDetails(v, a.question, answerOf(v, a.question))).length
    const hasSend = isMany || c.needsYou.some(a => a.question === v.expanded)

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
            {c.needsYou.map((ask, i) => {
              const isOpen = v.expanded === ask.question
              const optionButton = (option: string, j: number, max: number) => {
                const isPicked = v.picked[ask.question] === option
                return (
                  <Button
                    key={`ask-${i}-opt-${j}`}
                    label={`${isPicked ? '✓ ' : ''}${clip(option, max)}`}
                    variant={isPicked ? 'primary' : undefined}
                    onPress={() => pickAsk($, ask, option)}
                  />
                )
              }
              return (
                <Box key={`ask-${i}`} flexDirection="column">
                  <Box>
                    <Text color="warning">{isOpen ? '▾ ' : '◆ '}</Text>
                    <Text bold={isOpen}>{ask.question}</Text>
                  </Box>
                  {isOpen && ask.context && (
                    <Box marginLeft={2}>
                      <Text dimColor>{ask.context}</Text>
                    </Box>
                  )}
                  {isOpen ? (
                    <Box marginLeft={2} flexDirection="column">
                      {ask.options.map((option, j) => (
                        <Box key={`ask-${i}-row-${j}`} flexDirection="column">
                          {optionButton(option, j, 80)}
                          {ask.optionNotes[j] && (
                            <Box marginLeft={2}>
                              <Text dimColor>{ask.optionNotes[j]}</Text>
                            </Box>
                          )}
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    ask.options.length > 0 && (
                      <Box marginLeft={2} columnGap={1} flexWrap="wrap">
                        {ask.options.map((option, j) => optionButton(option, j, 28))}
                      </Box>
                    )
                  )}
                  {Input && (
                    <Box marginLeft={2}>
                      <Input
                        key={`ask-${i}-input`}
                        placeholder={ask.options.length > 0 ? 'or type an answer…' : 'type an answer…'}
                        value={v.typed[ask.question] ?? ''}
                        submitLabel={hasSend ? undefined : 'send'}
                        onInput={text => typeAsk($, ask, text)}
                        onSubmit={text => submitTyped($, ask, text)}
                      />
                    </Box>
                  )}
                  {isOpen && Input && (
                    <Box marginLeft={2}>
                      <Input
                        key={`ask-${i}-details`}
                        placeholder="extra details (optional)…"
                        value={v.details[ask.question] ?? ''}
                        onInput={text => detailAsk($, ask, text)}
                        onSubmit={text => detailAsk($, ask, text)}
                      />
                    </Box>
                  )}
                  <Box marginLeft={2} columnGap={2}>
                    <Button key={`ask-${i}-more`} plain dimColor label={isOpen ? 'less' : 'details'} onPress={() => toggleAsk($, ask)} />
                    {!Input && <Button key={`ask-${i}-reply`} plain dimColor label="reply…" onPress={() => draftAsk($, ask)} />}
                    <Button key={`ask-${i}-dismiss`} plain dimColor label="dismiss" onPress={() => dropAsk($, ask.question)} />
                  </Box>
                </Box>
              )
            })}
            {hasSend && (
              <Box marginTop={1}>
                <Button
                  key="send-answers"
                  variant="primary"
                  dimColor={answeredCount === 0}
                  label={answeredCount > 0 ? `Send ${answeredCount} answer${answeredCount > 1 ? 's' : ''}` : 'Send answers'}
                  onPress={() => sendAnswers($)}
                />
              </Box>
            )}
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
            <Text>{clip(prompt.text, width * 4)}</Text>
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

        {(c.done.length > 0 || c.repos.length > 0 || c.edited.length > 0) && (
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <Text dimColor>Done{c.done.length > 0 ? ` · ${c.done.length}` : ''}</Text>
              {(c.done.length > 3 || c.edited.length > 0) && (
                <Button key="status" plain dimColor label={v.isShowingStatus ? 'less' : 'more'} onPress={set({ isShowingStatus: !v.isShowingStatus })} />
              )}
            </Box>
            {c.done.slice(v.isShowingStatus ? -12 : -3).map(d => (
              <Box>
                <Text color="success">{'✓ '}</Text>
                <Text>{d.text}</Text>
              </Box>
            ))}
            {c.repos.map(r => {
              const state = repoState(r)
              const name = basename(r.root)
              // Clip the branch, not the row, so a long one never wraps or hides the push state.
              const room = Math.max(8, width - name.length - state.length - 8)
              return (
                <Text wrap="truncate-end">
                  <Text dimColor>{'⎇ '}</Text>
                  {name} · {clip(r.branch, room)} ·{' '}
                  <Text color={state === '✓ pushed' ? 'success' : 'warning'}>{state}</Text>
                </Text>
              )
            })}
            {c.edited.length > 0 && (
              <Text dimColor>
                {c.edited.length} file{c.edited.length > 1 ? 's' : ''} edited
              </Text>
            )}
            {v.isShowingStatus &&
              c.edited
                .slice(-12)
                .reverse()
                .map(f => (
                  <Text dimColor wrap="truncate-start">
                    {'  '}
                    {f.replace(/^\/Users\/[^/]+/, '~')}
                  </Text>
                ))}
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
