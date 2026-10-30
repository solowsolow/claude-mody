// Where a session stands, as the person needs to know it:
// zgoda    a permission prompt waits on them
// pytanie  a question, a plan to approve or an MCP form waits on them
// tura     the turn ended and the session waits for their next message
// praca    it is working; nothing is needed
// spokój   they have it in hand (a command ran, no turn followed)
export type PeerState = 'praca' | 'zgoda' | 'pytanie' | 'tura' | 'spokój'

// This session's own standing, kept so a reload does not forget it.
export type Mine = {
  state: PeerState
  // What exactly waits: "zgoda na Bash", "plan do akceptacji".
  reason?: string
  since: number
  // The first prompt's opening words: what tells two sessions in one folder apart.
  topic?: string
}

// One session's trace, as each writes its own file and the others read it.
export type Peer = {
  session: string
  project: string
  topic?: string
  state: PeerState
  reason?: string
  since: number
  beat: number
  ended?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'radar-sesji': {
      mine: Shaped<Mine>
      peers: Shaped<Peer[]>
      // Cleared from the band: a session and the moment its state began. A
      // new state starts a new moment, so the session comes back.
      dismissed: Shaped<Record<string, number>>
      now: number
      glow: number
    }
  }
}
