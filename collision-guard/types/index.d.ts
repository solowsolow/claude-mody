// What one session publishes about itself in ~/.claude/collision-guard/<session>.json.
export type SessionTrace = {
  session: string
  project: string
  beat: number
  edits: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'collision-guard': {
      // This session's own edits, path → when; what its trace file publishes.
      mine: Shaped<Record<string, number>>
      // Files the person let this session edit despite a collision.
      allowed: Shaped<string[]>
    }
  }
}
