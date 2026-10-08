import { describe, expect, test } from 'claude-code/testing'
import { richLines } from '../hooks/rich'

const shown = (md: string, width: number) => richLines(md, width).map(l => l.map(s => s.text).join(''))

describe('rich markdown', () => {
  test('wraps paragraphs to the width and styles inline marks with theme keys', () => {
    const lines = richLines('Some **bold** and `code` in a sentence that runs past the edge', 24)
    expect(lines.every(l => l.reduce((n, s) => n + s.text.length, 0) <= 24)).toBe(true)
    const spans = lines.flat()
    expect(spans.find(s => s.text === 'bold')?.style.bold).toBe(true)
    expect(spans.find(s => s.text === 'code')?.style.color).toBe('permission')
  })

  test('draws tables aligned, lists with markers and code behind a bar', () => {
    expect(shown('| a | b |\n|---|--:|\n| x | 10 |', 40)).toEqual([' a │  b', '───┼────', ' x │ 10'])
    expect(shown('- one\n  - two\n- [x] done', 40)).toEqual(['• one', '  • two', '✓ done'])
    expect(shown('```ts\nconst a = 1\n```', 40)).toEqual(['▎ ts', '▎ const a = 1'])
  })

  test('links keep their target', () => {
    expect(richLines('see [docs](https://x.dev)', 40).flat().find(s => s.text === 'docs')?.href).toBe('https://x.dev')
  })
})
