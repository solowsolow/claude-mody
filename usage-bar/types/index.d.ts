export type UsageWindow = { percent: number; resetsAt?: number }

export type Usage = {
  ctxTokens?: number
  ctxPercent?: number
  five?: UsageWindow
  week?: UsageWindow
}

// `unknown`: no request seen yet, so whether the cache is warm cannot be said.
export type CacheState = 'unknown' | 'warm' | 'ending' | 'cold'

// The settled cache state and the color the bar draws it in, mid-fade or settled.
export type Dot = { state: CacheState; tint: string }

export type LimitKey = 'five' | 'week'

// A window that just crossed 50% or 80%: its percent blinks while `isOn`.
export type Flash = { level: number; at: number; isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      usage: Shaped<Usage>
      cacheAt: number
      isWorking: boolean
      now: number
      isHidden: boolean
      isCompacting: boolean
      compactAt: number
      ctxEstimate: number
      dot: Shaped<Dot>
      flash: Shaped<Partial<Record<LimitKey, Flash>>>
    }
  }
}
