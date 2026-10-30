export type ContextRow = { name: string; tokens: number }

// The window as the last breakdown counted it.
export type ContextSnapshot = {
  total: number
  window: number
  // Tokens at which auto-compaction runs; absent when it is off.
  threshold?: number
  rows: ContextRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: Shaped<ContextSnapshot | null>
      isHidden: boolean
      isLegendHidden: boolean
    }
  }
}
