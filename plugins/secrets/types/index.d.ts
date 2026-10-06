export type SecretAsk = { id: string; name: string; why: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    secrets: {
      // Values live only in files under dir; state keeps what a hot reload needs to find them.
      dir: string | null
      names: string[]
      asks: SecretAsk[]
    }
  }
}
