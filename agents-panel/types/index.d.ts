export type AgentScope = 'project' | 'user'

export type AgentDef = {
  name: string
  model: string
  description: string
  // The effort the file asks for, as written; absent when it takes the session's.
  effort?: string
  color?: string
  scope: AgentScope
  path: string
}

export type RunState = 'running' | 'done' | 'failed'

export type AgentRun = {
  agentId: string
  type: string
  // The task as the spawn described it (a few words).
  description?: string
  // What the agent is doing now: its latest tool, with one telling argument.
  tool?: string
  // Read from the engine while the agent is listed, kept once it ends.
  // The model id of its last request, else the one it was spawned on.
  model?: string
  // The effort its last request carried, a level or a budget; absent where
  // none was sent or it takes the session's.
  effort?: string | number
  // Tokens its next request starts from: the last request's input, cached
  // or not, and its output.
  context?: number
  // The model's context window, what `context` is a share of.
  window?: number
  // Every token its requests went through: input, cache reads and writes, output.
  tokens?: number
  startedAt: number
  endedAt?: number
  state: RunState
}

declare module 'claude-code' {
  interface PluginState {
    'agents-panel': {
      defs: Shaped<AgentDef[]>
      runs: Shaped<AgentRun[]>
      now: number
      frame: number
      // The share of its window each run's bar shows now, by agent id: it
      // eases toward the measured share instead of jumping to it.
      fills: Record<string, number>
    }
  }
}
