export type ContextRow = { name: string; tokens: number }

// The window as the last breakdown counted it.
export type ContextSnapshot = {
  total: number
  window: number
  // Tokens at which auto-compaction runs; absent when it is off.
  threshold?: number
  rows: ContextRow[]
}

// The tokens the session's model requests went through, counted by the mod.
export type SessionSpent = {
  // The session's start as session.usage gives it: whose tally this is.
  startedAt: number
  // Input, cache reads and writes and output of every counted request.
  tokens: number
  // When counting began: about `startedAt`, or later when the mod came late.
  since: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: Shaped<ContextSnapshot | null>
      spent: Shaped<SessionSpent | null>
      isHidden: boolean
      isLegendHidden: boolean
    }
  }
}
