export type Note = {
  id: string
  title: string
  file: string
  at: number
  isPinned: boolean
}

export type Task = { title: string; at: number }

export type Attempt = { text: string; isOk: boolean }

export type Stamped = { text: string; at: number }

export type Crumbs = {
  tasks: Task[]
  prompts: Stamped[]
  activity: string | null
  lastSaid: Stamped | null
  notes: Note[]
  decided: string[]
  tried: Attempt[]
  needsYou: string[]
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
}

declare module 'claude-code' {
  interface PluginState {
    breadcrumbs: { crumbs: Crumbs; where: Where | null; view: View; pending: string | null }
  }
}
