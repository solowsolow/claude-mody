import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionCompacted, SessionRateLimit, SessionUsage } from 'claude-code'

import type { CacheState, Dot, Flash, LimitKey, Usage, UsageWindow } from '../types'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const usage = atom({ plugin: 'usage-bar', key: 'usage' } as const, {}, { shape: 'usage-1' })
// When the main loop last talked to the API: the prompt cache's TTL runs from here.
const cacheAt = atom({ plugin: 'usage-bar', key: 'cacheAt' } as const, 0)
const isWorking = atom({ plugin: 'usage-bar', key: 'isWorking' } as const, false)
const now = atom({ plugin: 'usage-bar', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'usage-bar', key: 'isHidden' } as const, false)
const dot = atom({ plugin: 'usage-bar', key: 'dot' } as const, { state: 'unknown', tint: '#8A8A8A' }, { shape: 'dot-2' })
// Tokens at which auto-compaction runs; 0 while unknown or switched off.
const compactAt = atom({ plugin: 'usage-bar', key: 'compactAt' } as const, 0)
const isCompacting = atom({ plugin: 'usage-bar', key: 'isCompacting' } as const, false)
// The window's fill as /context estimates it locally; 0 while unread. Drawn
// only while the last response's figure is missing: right after compaction,
// until the next response is answered.
const ctxEstimate = atom({ plugin: 'usage-bar', key: 'ctxEstimate' } as const, 0)
// The fill shown when the last compaction landed; 0 once a response reported
// a new one. A measurement still carrying it is the figure from before.
const staleCtx = atom({ plugin: 'usage-bar', key: 'staleCtx' } as const, 0)
const flash = atom({ plugin: 'usage-bar', key: 'flash' } as const, {}, { shape: 'flash-1' })

// Countdowns show minutes, so a quarter-minute tick keeps them honest.
const TICK_MS = 15_000
const MINUTE = 60_000
// on 0–220 ms, off to 420, on to 1100, then off: two blinks, the second held.
const BLINK: readonly [number, boolean][] = [
  [220, false],
  [420, true],
  [1100, false],
]
// $.store keeps the last request time per session, so a reload or resume knows it.
const STORE_KEY = 'cacheAt'
const STORE_KEEP = 20

// Literal mid-tones rather than theme keys: they read on dark and light, and a
// color fade needs numbers to interpolate between.
const GREEN = '#5DB36A'
const AMBER = '#D9A441'
const RED = '#DD6670'
const GREY = '#8A8A8A'
const BLUE = '#7AA2D6'
const RESETS = '#B39DDB'
const LEVEL_HEX = [GREEN, AMBER, RED]
const CACHE_HEX: Record<CacheState, string> = { unknown: GREY, warm: GREEN, ending: AMBER, cold: GREY }
// The cache color's change: 8 frames of 60 ms, easing out (quadratic: a cubic
// lands by frame 5 and leaves the last frames identical).
const FADE_STEPS = 8
const FADE_STEP_MS = 60
// Cells one proportional desktop glyph takes, on average, at the band's
// footnote size: 0.75 measured at body, scaled by the step down (estimate).
const GLYPH_CELLS = 0.7
const LEVEL_TINT = ['', 'rgba(217,164,65,0.28)', 'rgba(221,102,112,0.30)']

// ---------------------------------------------------------------- figures

function toWindow(limits: SessionRateLimit[], kind: string): UsageWindow | undefined {
  const limit = limits.find(l => l.kind === kind)
  if (!limit) return undefined
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN
  return { percent: limit.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined }
}

function snapshot(figures: Pick<SessionUsage, 'context' | 'rateLimits'>): Usage {
  return {
    ctxTokens: figures.context.tokens,
    ctxPercent: figures.context.percent,
    five: toWindow(figures.rateLimits, 'five_hour'),
    week: toWindow(figures.rateLimits, 'seven_day'),
  }
}

// Keeps a window's last known reset time when a later reading leaves it out.
function keepResets(before: Usage, after: Usage, at: number): Usage {
  const kept = { ...after }
  for (const key of ['five', 'week'] as const) {
    const was = before[key]?.resetsAt
    const is = after[key]
    if (is && is.resetsAt === undefined && was !== undefined && was > at) kept[key] = { ...is, resetsAt: was }
  }
  return kept
}

function level(percent: number | undefined): number {
  return percent === undefined ? 0 : percent >= 80 ? 2 : percent >= 50 ? 1 : 0
}

function cacheState(lastAt: number, working: boolean, at: number, ttlMs: number): CacheState {
  if (working) return 'warm'
  if (lastAt === 0) return 'unknown'
  const left = lastAt + ttlMs - at
  if (left <= 0) return 'cold'
  return left <= Math.min(5 * MINUTE, ttlMs / 5) ? 'ending' : 'warm'
}

// ---------------------------------------------------------------- state changes

async function stamp($: Engine): Promise<number> {
  const at = await $.clock.now()
  await update($, now, () => at)
  return at
}

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2]
    .map(i => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t))
    .map(v => v.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase()
}

// Bumped by each fade, so a newer one silences the frames of an older one.
let fading = 0

function fade($: Engine, from: string, to: string): void {
  const token = ++fading
  for (let i = 1; i <= FADE_STEPS; i++) {
    const t = 1 - (1 - i / FADE_STEPS) ** 2
    $.clock.after(i * FADE_STEP_MS, () => {
      if (token === fading) void update($, dot, (current: Dot) => ({ ...current, tint: mix(from, to, t) }))
    })
  }
}

// The cache state is settled here, outside drawing, so each change is seen
// once and its color fades from wherever the last fade left it.
async function settleDot($: Engine, ttlMs: number): Promise<void> {
  const state = cacheState(await read($, cacheAt), await read($, isWorking), await read($, now), ttlMs)
  const current = await read($, dot)
  if (current.state === state) return
  await update($, dot, (d: Dot) => ({ ...d, state }))
  fade($, current.tint, CACHE_HEX[state])
}

async function rememberRequest($: Engine, at: number): Promise<void> {
  await update($, cacheAt, () => at)
  const id = await $.session.id()
  const kept = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, number>
  const next = Object.entries({ ...kept, [id]: at })
    .sort((a, b) => b[1] - a[1])
    .slice(0, STORE_KEEP)
  await $.store.set(STORE_KEY, Object.fromEntries(next))
}

// The threshold changes with the model, so it is read once a turn, from the
// locally estimated breakdown (no API request), not at every measurement; the
// estimated fill rides along.
async function readBreakdown($: Engine): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    const at = b?.isAutoCompactEnabled ? b.autoCompactThreshold ?? 0 : 0
    await update($, compactAt, () => at)
    await update($, ctxEstimate, () => b?.totalTokens ?? 0)
  } catch {
    // No session bound yet: the next turn reads it.
  }
}

async function recallRequest($: Engine): Promise<number> {
  const kept = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, number>
  return kept[await $.session.id()] ?? 0
}

function blink($: Engine, key: LimitKey, at: number): void {
  for (const [delay, isOn] of BLINK) {
    $.clock.after(delay, () => {
      // A later crossing owns the flash from then on.
      void update($, flash, current => {
        const mine = current[key]
        if (!mine || mine.at !== at) return current
        if (!isOn && delay === BLINK[BLINK.length - 1]![0]) {
          const { [key]: _, ...rest } = current
          return rest
        }
        return { ...current, [key]: { ...mine, isOn } }
      })
    })
  }
}

// ---------------------------------------------------------------- formatting

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// Remaining time as hh:mm, the way the window's own countdown reads.
function countdown(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE))
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function pctColor(percent: number): string {
  return LEVEL_HEX[level(percent)]!
}

function pct(percent: number): string {
  return `${Math.round(percent)}%`
}

// Whether a tree is the engine's own slot and nothing more: what the engine
// hands beneath the last mod in the band (type "engine", no children; a test
// stands an empty Box there). It is kept, as the engine may draw in it, but
// no gap goes next to it: a gap beside an empty slot doubled the space above
// usage-bar's row (34 px against 17), read from the band's own tree.
type Node = { type?: string; children?: unknown[] }

function isEngineSlot(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return node === undefined || node === null || node === ''
  const el = node as Node
  if (el.type === 'engine') return (el.children ?? []).length === 0
  return el.type === 'Box' && (el.children ?? []).every(isEngineSlot)
}

// How $.session.compact refuses in a session with no prompt of the engine's
// own (the desktop app, the SDK): there compaction runs inside a turn.
const HEADLESS = /headless|inside a turn/i

export function isHeadlessRefusal(message: string): boolean {
  return HEADLESS.test(message)
}

// Set at session start: no surface and nobody at the engine's prompt is a
// session the SDK hosts, where /compact is the only way to compact.
let isHeadless = false

// Compacts and says how it went in a toast; never rejects. The desktop app and
// the SDK host a session without the engine's own prompt, where compaction
// runs inside a turn: the /compact command is that turn. Run as a command; a
// prompt "/compact" is refused, as a plugin's text beginning with a slash
// would run a command as the user.
async function runCompact($: Engine): Promise<void> {
  const before = landed
  const shown = (await read($, usage)).ctxTokens
  const viaCommand = () =>
    $.command
      .run({ command: 'compact' })
      .then(done =>
        landed === before
          ? $.ui.toast(done.text?.trim() ? `Kompaktowanie: ${done.text.trim()}` : 'Kompaktowanie uruchomione.')
          : undefined,
      )
      .catch((again: unknown) =>
        $.ui.toast(`Kompaktowanie nie powiodło się: ${again instanceof Error ? again.message : String(again)}`),
      )
  try {
    if (isHeadless) {
      await viaCommand()
    } else {
      const done = await $.session.compact()
      if (done.skip !== undefined) await $.ui.toast(`Kompaktowanie pominięte: ${done.skip}`)
      // Its own call may not pass this mod's session.compact hook: told here then.
      else if (landed === before) await settleCompacted($, shown, done)
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    if (isHeadlessRefusal(why)) await viaCommand()
    else await $.ui.toast(`Kompaktowanie nie powiodło się: ${why}`)
  }
  await readBreakdown($)
}

// Compactions of the main window that landed this load: the button's own
// toast stands in only when none did while it waited.
let landed = 0

// What the summarizer's request cost: generated, paid in full (uncached and
// cache-written), read from the cache. No usage: the summary was computed
// ahead of time or a hook's, or the response reported none.
function compactedText(done: SessionCompacted): string {
  const { tokensBefore: from, tokensAfter: to, usage: u } = done
  const size = from === undefined ? '' : to === undefined ? ` z ${tokens(from)}` : ` ${tokens(from)} → ${tokens(to)}`
  const cost = u
    ? `koszt: ${tokens(u.output_tokens)} wyjścia, ${tokens(u.input_tokens + u.cache_creation_input_tokens)} wejścia, ${tokens(u.cache_read_input_tokens)} z cache`
    : 'bez danych o koszcie'
  return `Skompaktowano${size} · ${cost}`
}

// A compaction raises no measurement of its own, so the last response's fill
// would stay drawn until the next one: dropped here, the estimate stands in.
async function settleCompacted($: Engine, shown: number | undefined, done: SessionCompacted): Promise<void> {
  landed++
  await update($, staleCtx, () => shown ?? 0)
  await update($, usage, u => ({ ...u, ctxTokens: undefined, ctxPercent: undefined }))
  await $.ui.toast(compactedText(done))
  await readBreakdown($)
}

// ---------------------------------------------------------------- module

export const register: Register = (on, options) => {
  const ttlMs = Number(options.cacheTtl ?? '60') * MINUTE

  on('session.start', async ($, e, next) => {
    isHeadless = e.surface === null && e.isInteractive === false
    await $.command.register({
      name: 'usage-bar',
      description: 'Pokaż albo schowaj pasek cache / kontekstu / limitów nad promptem',
    })
    const figures = await $.session.usage()
    const at = await $.clock.now()
    await update($, usage, before => keepResets(before, snapshot(figures), at))
    const recalled = await recallRequest($)
    if (recalled > (await read($, cacheAt))) await update($, cacheAt, () => recalled)
    await stamp($)
    await settleDot($, ttlMs)
    await readBreakdown($)
    $.clock.every(TICK_MS, () => void stamp($).then(() => settleDot($, ttlMs)))

    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    await update($, isHidden, value => !value)
    const hidden = await read($, isHidden)

    return { text: hidden ? 'Pasek użycia schowany.' : 'Pasek użycia widoczny.' }
  })

  // Raised whenever the context fill, a rate-limit window or the cost moves.
  on('session.measure', async ($, e, next) => {
    const before = await read($, usage)
    const stale = await read($, staleCtx)
    const fresh = stale > 0 && e.context.tokens === stale ? { ...e, context: { window: e.context.window } } : e
    if (stale > 0 && fresh === e && e.context.tokens !== undefined) await update($, staleCtx, () => 0)
    const after = keepResets(before, snapshot(fresh), await $.clock.now())
    await update($, usage, () => after)
    if (after.ctxTokens === undefined) await readBreakdown($)

    for (const key of ['five', 'week'] as const) {
      const crossed = level(after[key]?.percent)
      if (crossed > level(before[key]?.percent)) {
        const at = await $.clock.now()
        const lit: Flash = { level: crossed, at, isOn: true }
        await update($, flash, current => ({ ...current, [key]: lit }))
        blink($, key, at)
      }
    }

    return next(e)
  })

  // Whatever starts it: the button, a typed /compact, the threshold. A
  // precompute changes nothing yet, a subagent's leaves the main window be.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e)
    const shown = (await read($, usage)).ctxTokens
    const done = next(e)
    void done.then(r => (r.skip === undefined ? settleCompacted($, shown, r) : undefined)).catch(() => {})
    return done
  })

  // Only the main loop's requests keep the main conversation's cache warm.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await update($, isWorking, () => true)
      await rememberRequest($, await stamp($))
      await settleDot($, ttlMs)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, isWorking, () => false)
      await rememberRequest($, await stamp($))
      await settleDot($, ttlMs)
      await readBreakdown($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const isTerminal = e.surface === 'terminal'
    const { Box, Button, Text } = $.ui.resolve(e)
    const figures = await read($, usage)
    const at = await read($, now)
    const lastAt = await read($, cacheAt)
    const marker = await read($, dot)
    const lit = await read($, flash)
    const busy = await read($, isCompacting)
    const threshold = await read($, compactAt)
    const estimate = await read($, ctxEstimate)
    const ctxTokens = figures.ctxTokens ?? (estimate > 0 ? estimate : undefined)
    // The band reads a step down from the transcript; the terminal has one size.
    const fs = isTerminal ? undefined : ('footnote' as const)

    // The words follow the props live; the color is the settled state's, fading.
    const state = e.props.isWorking ? 'warm' : cacheState(lastAt, false, at, ttlMs)
    const left = e.props.isWorking ? ttlMs : lastAt + ttlMs - at
    const color = marker.tint
    const cacheWords = state === 'unknown' ? 'cache —' : state === 'cold' ? 'cache cold' : 'cache warm '
    const minutes = state === 'warm' || state === 'ending' ? `${Math.ceil(left / MINUTE)}m` : ''

    // What gives way when the row is short, measured in the characters drawn:
    // first the countdown, then the week, then the context. The /compact
    // button keeps its place. A terminal character is one cell; a desktop
    // glyph is proportional, about 3/4 of a cell (measured: 46 characters in
    // ~348 px of a ~694 px band laid out as ~68 cells).
    const unit = isTerminal ? 1 : GLYPH_CELLS
    // Desktop insets, in cells (~10 px across). The row centres the figures on
    // the 28 px button, so a top inset moves the text down by half of it:
    // 0.1 cell (~2 px) turns the measured 13/15 px above/below into 14/14.
    // The left one takes the dot from 9 px off the card's edge to ~14 px.
    const insetTop = isTerminal ? undefined : 0.1
    const insetLeft = isTerminal ? undefined : 0.5
    const icon = busy ? '⋯' : '→←'
    const room = (e.props.bodyColumns - 2 - (insetLeft ?? 0)) / unit - (icon.length + 4)
    const SEP = 5
    const five = figures.five
    const week = figures.week
    const ctxText = ctxTokens !== undefined ? `ctx ${tokens(ctxTokens)}` : undefined
    const resetsText = five?.resetsAt !== undefined ? ` · resets ${countdown(five.resetsAt - at)}` : undefined
    const toCompact = threshold > 0 && ctxTokens !== undefined ? threshold - ctxTokens : undefined
    const compactText = toCompact !== undefined ? ` · compact in ${tokens(Math.max(0, toCompact))}` : undefined
    const show = {
      ctx: ctxText !== undefined,
      compact: compactText !== undefined,
      resets: resetsText !== undefined,
      week: week !== undefined,
    }
    const need = () =>
      2 + cacheWords.length + minutes.length +
      (show.ctx ? SEP + ctxText!.length + (show.compact ? compactText!.length : 0) : 0) +
      (five ? SEP + 3 + pct(five.percent).length + (show.resets ? resetsText!.length : 0) : 0) +
      (show.week && week ? SEP + 5 + pct(week.percent).length : 0)
    // Amber inside the last 10% of the way to auto-compaction, red inside 3%.
    const compactColor =
      toCompact === undefined ? GREY : toCompact <= threshold * 0.03 ? RED : toCompact <= threshold * 0.1 ? AMBER : GREY
    // Far from the threshold the distance is the least worth its room; near it,
    // it outranks the countdown.
    const order = compactColor === GREY
      ? (['compact', 'resets', 'week', 'ctx'] as const)
      : (['resets', 'compact', 'week', 'ctx'] as const)
    for (const drop of order) if (need() > room) show[drop] = false

    const sep = (key: string) => (
      <Text key={key} dimColor size={fs}>
        {'  |  '}
      </Text>
    )

    const percent = (key: LimitKey, value: number) => {
      const blinking = lit[key]?.isOn ? lit[key] : undefined
      return (
        <Text
          color={pctColor(value)}
          tabular
          size={fs}
          inverse={isTerminal && blinking !== undefined}
          backgroundColor={!isTerminal && blinking ? LEVEL_TINT[blinking.level] : undefined}
        >
          {pct(value)}
        </Text>
      )
    }

    const parts = [
      // The dot is one glyph a size down (~8 px, the x-height of the words),
      // centred on the row's axis rather than sat on a smaller baseline. The
      // space stays with the words, so the gap does not shrink with the dot.
      <Box key="cache" flexDirection="row" alignItems="center">
        <Text color={color} size="caption">●</Text>
        <Text color={color} size={fs}>{` ${cacheWords}`}</Text>
        {minutes !== '' && <Text color={color} tabular size={fs}>{minutes}</Text>}
      </Box>,
    ]

    if (show.ctx && ctxTokens !== undefined) {
      parts.push(sep('s-ctx'))
      parts.push(
        <Box key="ctx" flexDirection="row">
          <Text dimColor size={fs}>ctx </Text>
          <Text color={(figures.ctxPercent ?? 0) >= 80 ? RED : BLUE} tabular size={fs}>{tokens(ctxTokens)}</Text>
          {show.compact && <Text color={compactColor} tabular size={fs}>{compactText}</Text>}
        </Box>,
      )
    }

    if (five) {
      parts.push(sep('s-five'))
      parts.push(
        <Box key="five" flexDirection="row">
          <Text dimColor size={fs}>5h </Text>
          {percent('five', five.percent)}
          {show.resets && <Text color={RESETS} tabular wrap="truncate-end" size={fs}>{resetsText}</Text>}
        </Box>,
      )
    }

    if (show.week && week) {
      parts.push(sep('s-week'))
      parts.push(
        <Box key="week" flexDirection="row">
          <Text dimColor size={fs}>week </Text>
          {percent('week', week.percent)}
        </Box>,
      )
    }

    // The press only starts it: a compaction outlasts a hook's 10 s budget
    // (23 s measured in the desktop app), so the outcome comes as a toast.
    const compact = async () => {
      if (await read($, isCompacting)) return
      await update($, isCompacting, () => true)
      void runCompact($).finally(() => update($, isCompacting, () => false))
    }

    const row = (
      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" gap="sm">
        <Box
          flexDirection="row"
          flexWrap="nowrap"
          alignItems="center"
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
          paddingTop={insetTop}
          paddingLeft={insetLeft}
        >
          {parts}
        </Box>
        {/* An icon in place of the word. No label: the desktop draws a label in
            place of the children, so the icon would never show. */}
        <Button key="compact" plain={busy || undefined} onPress={compact}>
          <Text size={fs}>{icon}</Text>
        </Button>
      </Box>
    )

    // The desktop seats the band in a card of its own; a border here would be a
    // card in a card. The terminal draws no such card, so it keeps the frame.
    const mine = isTerminal ? (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {row}
      </Box>
    ) : (
      row
    )

    // Whatever else draws here (another mod's card) stays, above this row:
    // the row is the band's last line, closest to the prompt, whichever
    // plugin's hook runs first.
    const below = await next(e)
    return below ? (
      <Box key="usage-band" flexDirection="column" gap={isEngineSlot(below) ? 0 : 'sm'}>
        {below}
        {mine}
      </Box>
    ) : (
      mine
    )
  })
}
