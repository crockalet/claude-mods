// Lays markdown out as styled, pre-wrapped lines for the terminal pane, which has no Markdown element of its own worth reading.

export type Style = {
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}
export type Span = { text: string; style: Style; href?: string }
export type Line = Span[]

// Theme keys, not raw colors, so the pane follows whichever theme the person picked.
const S = {
  text: { color: 'text' },
  h1: { color: 'claude', bold: true, underline: true },
  h2: { color: 'claude', bold: true },
  h3: { color: 'suggestion', bold: true },
  h4: { color: 'text', bold: true },
  strong: { bold: true },
  em: { italic: true },
  del: { color: 'inactive', strikethrough: true },
  code: { color: 'permission' },
  link: { color: 'suggestion', underline: true },
  bullet: { color: 'claude' },
  number: { color: 'claude' },
  done: { color: 'success' },
  todo: { color: 'inactive' },
  quote: { color: 'subtle', italic: true },
  bar: { color: 'subtle' },
  rule: { color: 'subtle' },
  th: { color: 'claude', bold: true },
  block: { color: 'text' },
  lang: { color: 'inactive', italic: true },
} satisfies Record<string, Style>

const CODE = {
  comment: { color: 'inactive', italic: true },
  string: { color: 'success' },
  number: { color: 'warning' },
  keyword: { color: 'merged' },
  call: { color: 'suggestion' },
  type: { color: 'claude' },
  operator: { color: 'permission' },
} satisfies Record<string, Style>

// MARK: Blocks

type Align = 'left' | 'center' | 'right'
type Item = { marker: string; task?: boolean; blocks: Block[] }
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; items: Item[] }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] }
  | { kind: 'rule' }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||(?<!\\)\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'))

const startsBlock = (line: string, next: string | undefined) =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  QUOTE.test(line) ||
  ITEM.test(line) ||
  (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))

const indentOf = (line: string) => (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length

export const parse = (markdown: string): Block[] => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]?.[0] === '`' ? '`' : '~'}{${fence[1]?.length ?? 3},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i++
      blocks.push({ kind: 'code', lang: fence[2] ?? '', lines: body })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      i++
      continue
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && (lines[i] ?? '').trim() && QUOTE.test(lines[i] ?? '')) body.push(QUOTE.exec(lines[i++] ?? '')?.[1] ?? '')
      blocks.push({ kind: 'quote', blocks: parse(body.join('\n')) })
      continue
    }
    const next = lines[i + 1]
    if (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-')) {
      const header = cells(line)
      const align = cells(next).map((c): Align => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left'))
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim()) rows.push(cells(lines[i++] ?? ''))
      blocks.push({ kind: 'table', header, align, rows })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const base = indentOf(line)
      const ordered = /\d/.test(item[2] ?? '')
      const items: Item[] = []
      while (i < lines.length) {
        const head = ITEM.exec(lines[i] ?? '')
        if (!head || indentOf(lines[i] ?? '') !== base || /\d/.test(head[2] ?? '') !== ordered) break
        const body = [head[3] ?? '']
        const contentIndent = base + (head[2]?.length ?? 1) + 1
        i++
        while (i < lines.length) {
          const l = lines[i] ?? ''
          if (!l.trim()) {
            const after = lines[i + 1] ?? ''
            if (after.trim() && indentOf(after) >= contentIndent) {
              body.push('')
              i++
              continue
            }
            break
          }
          if (indentOf(l) < contentIndent && (ITEM.test(l) || startsBlock(l, lines[i + 1]))) break
          body.push(indentOf(l) >= contentIndent ? l.replace(/\t/g, '    ').slice(contentIndent) : l.trim())
          i++
        }
        const task = /^\[([ xX])\]\s+/.exec(body[0] ?? '')
        if (task) body[0] = (body[0] ?? '').slice(task[0].length)
        items.push({ marker: head[2] ?? '-', task: task ? task[1] !== ' ' : undefined, blocks: parse(body.join('\n')) })
        while (i < lines.length && !(lines[i] ?? '').trim() && ITEM.test(lines[i + 1] ?? '') && indentOf(lines[i + 1] ?? '') === base) i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const text = [line.trim()]
    i++
    while (i < lines.length && (lines[i] ?? '').trim() && !startsBlock(lines[i] ?? '', lines[i + 1])) text.push((lines[i++] ?? '').trim())
    blocks.push({ kind: 'paragraph', text: text.join(' ') })
  }

  return blocks
}

// MARK: Inline

const merge = (a: Style, b: Style): Style => ({ ...a, ...b })

export const inline = (text: string, base: Style): Span[] => {
  const out: Span[] = []
  const push = (t: string, style: Style, href?: string) => {
    if (!t) return
    const last = out.at(-1)
    if (last && !href && !last.href && JSON.stringify(last.style) === JSON.stringify(style)) last.text += t
    else out.push(href ? { text: t, style, href } : { text: t, style })
  }
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    const ch = rest[0] ?? ''
    if (ch === '\\' && /^\\[\\`*_{}[\]()#+\-.!|~<>]/.test(rest)) {
      push(rest[1] ?? '', base)
      i += 2
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`'
      const end = rest.indexOf(run, run.length)
      if (end > 0) {
        push(rest.slice(run.length, end).trim(), merge(base, S.code))
        i += end + run.length
        continue
      }
    }
    const link = /^\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest)
    if (link) {
      for (const s of inline(link[1] ?? '', merge(base, S.link))) push(s.text, s.style, link[2] || undefined)
      i += link[0].length
      continue
    }
    const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest) ?? /^(https?:\/\/[^\s<]*[^\s<.,;:!?)'"])/.exec(rest)
    if (auto && (i === 0 || /[\s(]/.test(text[i - 1] ?? ''))) {
      push(auto[1] ?? '', merge(base, S.link), auto[1])
      i += auto[0].length
      continue
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest)
    if (strike) {
      for (const s of inline(strike[1] ?? '', merge(base, S.del))) push(s.text, s.style, s.href)
      i += strike[0].length
      continue
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong && (ch === '*' || !/\w/.test(text[i - 1] ?? ''))) {
      for (const s of inline(strong[2] ?? '', merge(base, S.strong))) push(s.text, s.style, s.href)
      i += strong[0].length
      continue
    }
    const em = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest)
    if (em && (ch === '*' || !/\w/.test(text[i - 1] ?? ''))) {
      for (const s of inline(em[2] ?? '', merge(base, S.em))) push(s.text, s.style, s.href)
      i += em[0].length
      continue
    }
    const plain = /^[^\\`[<h~*_]+/.exec(rest)?.[0] ?? ch
    push(plain, base)
    i += plain.length
  }

  return out
}

// MARK: Wrapping

const width = (spans: Span[]) => spans.reduce((n, s) => n + s.text.length, 0)

const pad = (n: number, style: Style = {}): Span => ({ text: ' '.repeat(Math.max(0, n)), style })

// Greedy word wrap across spans; `first` and `rest` prefix the first and later lines and count toward `max`.
export const wrap = (spans: Span[], max: number, first: Span[] = [], rest: Span[] = first): Line[] => {
  const lines: Line[] = []
  let line: Line = [...first]
  let used = width(first)
  let room = Math.max(4, max - used)
  const flush = () => {
    const last = line.at(-1)
    if (last) last.text = last.text.replace(/ +$/, '')
    lines.push(line)
    line = [...rest]
    used = width(rest)
    room = Math.max(4, max - used)
  }
  const add = (text: string, span: Span) => {
    const last = line.at(-1)
    if (last && last.style === span.style && last.href === span.href) last.text += text
    else line.push({ ...span, text })
    used += text.length
  }
  for (const span of spans) {
    for (const token of span.text.match(/\s+|\S+/g) ?? []) {
      if (/^\s/.test(token)) {
        if (used > width(lines.length === 0 ? first : rest) && used < max) add(' ', span)
        continue
      }
      let word = token
      while (word.length > 0) {
        const left = max - used
        if (word.length <= left) {
          add(word, span)
          word = ''
        } else if (word.length > room) {
          if (left <= 0) flush()
          const cut = Math.max(1, max - used)
          add(word.slice(0, cut), span)
          word = word.slice(cut)
          if (word) flush()
        } else {
          flush()
        }
      }
    }
  }
  if (line.length > rest.length || lines.length === 0) flush()

  return lines
}

// MARK: Code

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends ' +
    'false final finally fn for from func function go if impl implements import in interface is lambda let loop match mod mut new nil ' +
    'none null package pass private protected pub public raise return self static struct super switch this throw true try type typeof ' +
    'undefined unless until use val var void when where while with yield local then end fi done esac echo'
  ).split(' '),
)

const TOKEN =
  /(\/\/.*|#(?![!\[]).*|--\s.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b0x[\da-f]+\b|\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([^\w\s"'`]+)|(\s+)/gi

const highlight = (line: string, lang: string): Span[] => {
  const spans: Span[] = []
  const hashComments = /^(sh|bash|zsh|shell|py|python|rb|ruby|ya?ml|toml|conf|ini|dockerfile|make|r)$/i.test(lang)
  for (const m of line.matchAll(TOKEN)) {
    const [text, comment, str, num, call, word, punct] = m
    let style: Style = S.block
    if (comment && (comment.startsWith('//') || hashComments || comment.startsWith('--'))) style = CODE.comment
    else if (str) style = CODE.string
    else if (num) style = CODE.number
    else if (call) style = KEYWORDS.has(call) ? CODE.keyword : CODE.call
    else if (word && KEYWORDS.has(word)) style = CODE.keyword
    else if (word && /^[A-Z]/.test(word)) style = CODE.type
    else if (punct && /[=<>!+\-*/%&|^?:]/.test(punct)) style = CODE.operator
    spans.push({ text, style })
  }

  return spans
}

const codeBlock = (lang: string, body: string[], max: number): Line[] => {
  const bar: Span = { text: '▎ ', style: S.bar }
  const inner = Math.max(4, max - 2)
  const out: Line[] = lang ? [[bar, { text: lang.slice(0, inner), style: S.lang }]] : []
  for (const raw of body.length > 0 ? body : ['']) {
    // Code keeps its indentation, so it is cut into rows rather than word-wrapped.
    let row: Span[] = []
    let used = 0
    const rows: Span[][] = []
    for (const s of highlight(raw.replace(/\t/g, '  '), lang)) {
      let t = s.text
      while (t.length > 0) {
        const take = t.slice(0, inner - used)
        row.push({ ...s, text: take })
        used += take.length
        t = t.slice(take.length)
        if (used >= inner) {
          rows.push(row)
          row = []
          used = 0
        }
      }
    }
    if (row.length > 0 || rows.length === 0) rows.push(row)
    out.push(...rows.map(r => [bar, ...r]))
  }

  return out
}

// MARK: Tables

const fit = (natural: number[], max: number): number[] => {
  const widths = natural.map(n => Math.max(1, n))
  const budget = max - (widths.length - 1) * 3 - 2
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const big = widths.indexOf(Math.max(...widths))
    if ((widths[big] ?? 0) <= 3) break
    widths[big] = (widths[big] ?? 0) - 1
  }

  return widths
}

const table = (header: string[], align: Align[], rows: string[][], max: number): Line[] => {
  const columns = Math.max(header.length, ...rows.map(r => r.length))
  const head = Array.from({ length: columns }, (_, k) => inline(header[k] ?? '', S.th))
  const body = rows.map(r => Array.from({ length: columns }, (_, k) => inline(r[k] ?? '', S.text)))
  const widths = fit(
    Array.from({ length: columns }, (_, k) => Math.max(width(head[k] ?? []), ...body.map(r => width(r[k] ?? [])))),
    max,
  )
  const sep: Span = { text: ' │ ', style: S.bar }
  const row = (cellsOf: Span[][]): Line[] => {
    const wrapped = cellsOf.map((c, k) => wrap(c, widths[k] ?? 1))
    const height = Math.max(1, ...wrapped.map(w => w.length))
    return Array.from({ length: height }, (_, y) => {
      const line: Line = [pad(1)]
      wrapped.forEach((w, k) => {
        if (k > 0) line.push(sep)
        const cell = w[y] ?? []
        const gap = (widths[k] ?? 1) - width(cell)
        const a = align[k] ?? 'left'
        const left = a === 'right' ? gap : a === 'center' ? Math.floor(gap / 2) : 0
        line.push(pad(left), ...cell, pad(gap - left))
      })
      return line
    })
  }
  const rule: Line = [{ text: `─${widths.map(w => '─'.repeat(w)).join('─┼─')}─`, style: S.rule }]

  return [...row(head), rule, ...body.flatMap(row)]
}

// MARK: Layout

const indent = (lines: Line[], first: Span[], rest: Span[]): Line[] => lines.map((l, i) => [...(i === 0 ? first : rest), ...l])

const headingStyle = (level: number): Style => (level === 1 ? S.h1 : level === 2 ? S.h2 : level === 3 ? S.h3 : S.h4)

const layoutBlocks = (blocks: Block[], max: number, base: Style, tight = false): Line[] => {
  const out: Line[] = []
  blocks.forEach((b, n) => {
    if (n > 0 && !tight) out.push([])
    out.push(...layoutBlock(b, max, base))
  })

  return out
}

const layoutBlock = (b: Block, max: number, base: Style): Line[] => {
  switch (b.kind) {
    case 'heading':
      return wrap(
        inline(b.text, headingStyle(b.level)).map(s => ({ ...s, style: { ...s.style, ...headingStyle(b.level) } })),
        max,
        [{ text: `${'#'.repeat(b.level)} `, style: { ...headingStyle(b.level), bold: false, underline: false } }],
        [pad(b.level + 1)],
      )
    case 'paragraph':
      return wrap(inline(b.text, base), max)
    case 'rule':
      return [[{ text: '─'.repeat(max), style: S.rule }]]
    case 'code':
      return codeBlock(b.lang, b.lines, max)
    case 'table':
      return table(b.header, b.align, b.rows, max)
    case 'quote': {
      const bar: Span = { text: '│ ', style: S.bar }
      return indent(layoutBlocks(b.blocks, max - 2, S.quote), [bar], [bar])
    }
    case 'list': {
      const loose = b.items.some(it => it.blocks.length > 1 && it.blocks.some(x => x.kind === 'paragraph') && it.blocks.filter(x => x.kind === 'paragraph').length > 1)
      const out: Line[] = []
      b.items.forEach((it, n) => {
        if (n > 0 && loose) out.push([])
        const marker: Span[] =
          it.task !== undefined
            ? [{ text: it.task ? '✓ ' : '☐ ', style: it.task ? S.done : S.todo }]
            : b.ordered
              ? [{ text: `${it.marker} `, style: S.number }]
              : [{ text: '• ', style: S.bullet }]
        const w = width(marker)
        const itemBase = it.task ? { ...base, ...S.del } : base
        const lines = layoutBlocks(it.blocks, max - w, itemBase, true)
        out.push(...indent(lines.length > 0 ? lines : [[]], marker, [pad(w)]))
      })
      return out
    }
  }
}

/** The lines a markdown text draws as, each at most `max` columns wide. */
export const richLines = (markdown: string, max: number): Line[] => layoutBlocks(parse(markdown), Math.max(12, max), S.text)
