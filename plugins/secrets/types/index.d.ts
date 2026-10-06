export type SecretAsk = { id: string; name: string; why: string; at: number }

export type SecretApproval = { id: string; names: string[]; command: string; agentId: string | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    secrets: {
      // Values live only in files under dir; state keeps what a hot reload needs to find them.
      dir: string | null
      names: string[]
      asks: SecretAsk[]
      approvals: SecretApproval[]
      // Names whose Bash commands skip the approval band until forgotten, replaced or the session ends.
      allowed: string[]
    }
  }
}
