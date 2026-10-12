import type { EngineInterface, Register } from 'claude-code'

// Breadcrumbs writes spawn requests here and checks `ready` to know this mod runs; see LAUNCH_DIR in its hooks/tests.ts.
const LAUNCH_DIR = '.agents/notes/.launch'
const TESTER = 'breadcrumbs:tester'
const POLL_MS = 1000
const HEARTBEAT_MS = 30_000
const STALE_MS = 7 * 86_400_000

type $ = EngineInterface
type Request = { subagentType?: unknown; description?: unknown; prompt?: unknown }

let dir: string | null = null

const root = async ($: $) => `${(await $.env.get('HOME')) ?? '~'}/${LAUNCH_DIR}`

const stamp = async ($: $) => {
  if (dir) await $.fs.write(`${dir}/ready`, String(await $.clock.now()))
}

// Folders of sessions that ended long ago, which nothing else removes.
const tidy = async ($: $, now: number) => {
  let sessions
  try {
    sessions = await $.fs.list(await root($))
  } catch {
    return
  }
  for (const s of sessions) {
    const path = `${await root($)}/${s.name}`
    if (s.kind !== 'dir' || path === dir) continue
    const at = await $.fs.stat(`${path}/ready`).then(r => r.mtimeMs, () => 0)
    if (now - at > STALE_MS) await $.process.run(['rm', '-rf', path])
  }
}

// Runs from this mod's own timer: a spawn breadcrumbs causes, even through a command, skips every breadcrumbs hook, so the tester's tools would go unanswered.
const poll = async ($: $) => {
  if (!dir) return
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${dir}/${entry.name}`
    let request: Request
    try {
      request = JSON.parse(await $.fs.read(path)) as Request
    } catch {
      continue
    }
    // Taken before spawning, so breadcrumbs' fallback never starts the same tester twice.
    await $.process.run(['rm', '-f', path])
    if (request.subagentType !== TESTER || typeof request.prompt !== 'string') continue
    const description = typeof request.description === 'string' ? request.description : 'Manual test'
    try {
      await $.agent.spawn({ subagentType: TESTER, prompt: request.prompt, description })
    } catch (error) {
      $.ui.log(`breadcrumbs-launcher: could not start "${description}" (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    dir = `${await root($)}/${await $.session.id()}`
    await stamp($)
    $.clock.every(POLL_MS, () => poll($))
    $.clock.every(HEARTBEAT_MS, () => stamp($))
    const now = await $.clock.now()
    $.clock.after(10_000, () => tidy($, now))

    return started
  })
}
