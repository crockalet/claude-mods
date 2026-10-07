export type Note = {
  id: string
  title: string
  file: string
  at: number
  isPinned: boolean
}

export type Task = { title: string; at: number }

export type Attempt = { text: string; isOk: boolean }

export type Ask = { question: string; context: string; options: string[]; optionNotes: string[] }

export type Repo = {
  root: string
  branch: string
  changed: number
  ahead: number
  behind: number
  hasUpstream: boolean
}

export type Stamped = { text: string; at: number }

// One per turn: a one-line title, with what changed listed under it.
export type Done = { title: string; items: string[]; at: number }

export type Crumbs = {
  tasks: Task[]
  prompts: Stamped[]
  activity: string | null
  lastSaid: Stamped | null
  notes: Note[]
  decided: string[]
  tried: Attempt[]
  needsYou: Ask[]
  done: Done[]
  edited: string[]
  touched: string[]
  repos: Repo[]
  asking: string | null
}

export type Where = {
  repo: string
  branch: string
  worktree: string
}

export type View = {
  openNote: string | null
  isShowingPrompts: boolean
  isShowingMore: boolean
  isShowingStatus: boolean
  openDone: number | null
  picked: Record<string, string>
  typed: Record<string, string>
  details: Record<string, string>
  expanded: string | null
}

export type TestStatus = 'todo' | 'running' | 'passed' | 'failed' | 'blocked' | 'retest'

export type Entry = { from: 'you' | 'tester' | 'claude'; text: string; at: number }

export type ManualTest = {
  id: string
  title: string
  steps: string[]
  expect: string
  watch: string
  status: TestStatus
  agentId: string | null
  log: Entry[]
}

export type Wait = {
  id: string
  testId: string | null
  step: number | null
  instruction: string
  // Absent on waits from before these fields existed.
  steps?: string[]
  options?: string[]
  at: number
  answer: string | null
}

export type TestRun = { brief: string; tests: ManualTest[]; waits: Wait[]; unreported: string[] }

export type TestsView = { expanded: string | null; typed: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    breadcrumbs: {
      crumbs: Crumbs
      where: Where | null
      view: View
      pending: string | null
      tests: TestRun
      testsView: TestsView
    }
  }
}
