export const slug =(text: string, max = 40): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'untitled'

export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

// Unlike clip, keeps newlines so a markdown preview still renders as markdown.
export const head = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim())

const isRule = (row: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row) && row.includes('-')

// A table wider than the pane wraps into an unreadable grid, so the preview restacks it as a list.
export const narrowTables = (markdown: string, width: number): string => {
  const lines = markdown.split('\n')
  const out: string[] = []
  let isFenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    if (isFenced || !line.includes('|') || !isRule(lines[i + 1] ?? '')) {
      out.push(line)
      continue
    }
    let end = i + 2
    while (end < lines.length && (lines[end] ?? '').includes('|') && (lines[end] ?? '').trim()) end++
    const header = cells(line)
    const rows = lines.slice(i + 2, end).map(cells)
    const widths = header.map((h, k) => Math.max(h.length, ...rows.map(r => (r[k] ?? '').length)))
    if (widths.reduce((sum, w) => sum + w + 3, 1) <= width) {
      out.push(...lines.slice(i, end))
    } else {
      for (const row of rows) {
        out.push(`- ${row[0] ?? ''}`)
        for (let k = 1; k < header.length; k++) if (row[k]) out.push(`  - *${header[k]}*: ${row[k]}`)
      }
    }
    i = end - 1
  }

  return out.join('\n')
}

export const ago =(at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.round(hours / 24)}d ago`
}

const pad = (n: number) => String(n).padStart(2, '0')

export const day = (at: number): string => {
  const d = new Date(at)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const stamp = (at: number): string => {
  const d = new Date(at)

  return `${day(at)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path

// Models wrap JSON in fences or prose often enough that a strict parse loses turns.
export const parseObject = (text: string): Record<string, unknown> | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))

    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const strings = (value: unknown, max: number, each = 100): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => clip(v, each)).slice(0, max)
    : []

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

// Older state.json files stored needs-you items as bare strings.
type RawAsk = { question: string; context?: unknown; options?: unknown; optionNotes?: unknown }
type RawOption = { label: string; description?: unknown }

const text = (value: unknown, max: number) => (typeof value === 'string' ? clip(value, max) : '')

// Accepts every shape this has had: bare strings, string options, and {label, description} options.
export const asks = (value: unknown): { question: string; context: string; options: string[]; optionNotes: string[] }[] =>
  Array.isArray(value)
    ? value
        .map(v => (typeof v === 'string' ? { question: v } : v))
        .filter((v): v is RawAsk => typeof v?.question === 'string' && v.question.trim() !== '')
        .slice(0, 4)
        .map(v => {
          const notes = Array.isArray(v.optionNotes) ? v.optionNotes : []
          const options = (Array.isArray(v.options) ? v.options : [])
            .map((o, i): RawOption | null =>
              typeof o === 'string' ? { label: o, description: notes[i] } : typeof o?.label === 'string' ? o : null,
            )
            .filter((o): o is RawOption => o !== null && o.label.trim() !== '')
            .slice(0, 4)
          return {
            question: clip(v.question, 160),
            context: text(v.context, 400),
            options: options.map(o => clip(o.label, 80)),
            optionNotes: options.map(o => text(o.description, 160)),
          }
        })
    : []

export const DONE_TITLE = 40

// One turn's results as a done entry; a single result short enough to be the title needs no list under it.
export const doneOf = (title: unknown, items: string[], at: number): { title: string; items: string[]; at: number } | null => {
  const named = typeof title === 'string' ? clip(title, DONE_TITLE) : ''
  const first = items[0]
  if (!named && first === undefined) return null
  if (!named && items.length === 1 && first !== undefined && first.length <= DONE_TITLE) return { title: first, items: [], at }

  return { title: named || clip(first ?? '', DONE_TITLE), items, at }
}

// Older state.json files stored one {text, at} per result.
export const dones = (value: unknown): { title: string; items: string[]; at: number }[] =>
  Array.isArray(value)
    ? value.flatMap(v => {
        const at = typeof v?.at === 'number' ? v.at : 0
        const done = typeof v?.text === 'string' ? doneOf(null, [clip(v.text, 100)], at) : doneOf(v?.title, strings(v?.items, 6, 100), at)
        return done ? [done] : []
      })
    : []

export const parseStatus =(out: string) => {
  const [first = '', ...rest] = out.split('\n')
  const header = first.replace(/^## /, '')
  const [branchPart = '', trackPart = ''] = header.split('...')
  const branch = branchPart.replace(/^No commits yet on /, '').replace(/ \[.*$/, '')

  return {
    branch: branch === 'HEAD (no branch)' ? 'detached' : branch,
    hasUpstream: trackPart !== '',
    ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
    changed: rest.filter(line => line.trim() !== '').length,
  }
}

// `cd <dir> && …` is how most commands reach another repo, so it marks that repo as touched.
export const cdTarget = (command: string, home: string): string | null => {
  const match = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command)
  const raw = match?.[2] ?? match?.[3] ?? match?.[4]
  if (!raw) return null
  const dir = raw.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

  return dir.startsWith('/') ? dir : null
}

export const toolLabel = (tool: string, input: Record<string, unknown>): string => {
  const file = str(input.file_path) || str(input.notebook_path)
  switch (tool) {
    case 'Bash':
      return `Bash: ${clip(str(input.description) || str(input.command), 48)}`
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${tool} ${basename(file)}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${clip(str(input.pattern), 40)}`
    case 'Agent':
      return `Agent: ${clip(str(input.description), 44)}`
    case 'WebFetch':
    case 'WebSearch':
      return `${tool} ${clip(str(input.url) || str(input.query), 40)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool
  }
}
