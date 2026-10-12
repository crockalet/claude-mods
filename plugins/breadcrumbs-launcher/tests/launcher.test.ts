import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 11, 9, 0)
const DIR = '/home/dev/.agents/notes/.launch/abc123'

const world = (on: On) => {
  const files = new Map<string, string>()
  const spawned: { subagentType?: string; prompt: string; description?: string }[] = []
  const removed: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/dev' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abc123' }))
  on('fs.write', ($, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'rm') for (const path of e.argv.slice(2)) (files.delete(path), removed.push(path))
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('agent.spawn', ($, e) => (spawned.push({ subagentType: e.subagentType, prompt: e.prompt, description: e.description }), { model: 'sonnet', agentId: 'agent-1' }))

  return { files, spawned, removed, clock }
}

describe('breadcrumbs-launcher', () => {
  test('stamps ready, then starts a tester breadcrumbs asked for and takes the request', async ($, on) => {
    const { files, spawned, clock } = world(on)
    await $.session.start({ cwd: '/code/app', surface: null, isInteractive: false })
    expect(files.get(`${DIR}/ready`)).toBe(String(NOW))

    files.set(`${DIR}/1-1.json`, JSON.stringify({ subagentType: 'breadcrumbs:tester', description: 'Test 1: Login', prompt: 'Test 1: Login\n\nSteps:\n1. Open the app' }))
    await clock.advance(1000)
    // The kit resolves no agent type it has no definition for, so only what the tester is told is checked here.
    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({ description: 'Test 1: Login', prompt: 'Test 1: Login\n\nSteps:\n1. Open the app' })
    expect(files.has(`${DIR}/1-1.json`)).toBe(false)

    await clock.advance(1000)
    expect(spawned).toHaveLength(1)
  })

  test('starts nothing but breadcrumbs\' tester', async ($, on) => {
    const { files, spawned, clock } = world(on)
    await $.session.start({ cwd: '/code/app', surface: null, isInteractive: false })
    files.set(`${DIR}/2-x.json`, JSON.stringify({ subagentType: 'general-purpose', prompt: 'rm -rf everything' }))
    await clock.advance(1000)
    expect(spawned).toEqual([])
    expect(files.has(`${DIR}/2-x.json`)).toBe(false)
  })
})
