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

export type Crumbs = {
  tasks: Task[]
  prompts: Stamped[]
  activity: string | null
  lastSaid: Stamped | null
  notes: Note[]
  decided: string[]
  tried: Attempt[]
  needsYou: Ask[]
  done: Stamped[]
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
  picked: Record<string, string>
  typed: Record<string, string>
  details: Record<string, string>
  expanded: string | null
}

declare module 'claude-code' {
  interface PluginState {
    breadcrumbs: { crumbs: Crumbs; where: Where | null; view: View; pending: string | null }
  }
}
