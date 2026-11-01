import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { ContextSnapshot } from '../types'

// Change the tag when ContextSnapshot's fields change: it declines what an
// earlier version stored, which outlives a reload.
const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null, { shape: 'snapshot-1' })
const isHidden = atom({ plugin: 'context-bar', key: 'isHidden' } as const, false)
// Folding the legend is a preference, not a moment's choice: it is kept in
// the store across sessions, and mirrored here for the drawing to read.
const isLegendHidden = atom({ plugin: 'context-bar', key: 'isLegendHidden' } as const, false)
const LEGEND_KEY = 'legendHidden'

// A breakdown is a local estimate, cheap but not free: during a turn, at most
// one every this often.
const REFRESH_MS = 10_000

// Rows by the name /context prints, in Polish, with a colour each. A row this
// table does not know keeps its own name and a neutral colour.
const ROWS: Record<string, { label: string; color: string }> = {
  'System prompt': { label: 'prompt systemowy', color: '#6F9FD8' },
  'System tools': { label: 'narzędzia', color: '#6CC3C8' },
  'MCP tools': { label: 'narzędzia MCP', color: '#A78BFA' },
  'MCP server instructions': { label: 'instrukcje MCP', color: '#C4B5FD' },
  'Custom agents': { label: 'agenci', color: '#8BC48A' },
  'Memory files': { label: 'pliki pamięci', color: '#E5C07B' },
  Skills: { label: 'skille', color: '#E8A0BF' },
  Messages: { label: 'wiadomości', color: '#E07A5F' },
}
const OTHER = '#9AA3B2'
const FREE = '#3A3F4B'
const FREE_SWATCH = '#5A6070'
const MARK = '#D9A441'
const LEVEL = ['#5DB36A', '#D9A441', '#DD6670']

// A desktop glyph at footnote size takes about this share of a cell: 6.2 to
// 7.2 px a glyph over a 9 px cell, measured on the card's legend. The
// legend's columns are sized by it.
const GLYPH_CELLS = 0.75
const LEGEND_GAP = 2

// ---------------------------------------------------------------- figures

let lastRead = 0

async function refresh($: Engine, force = false): Promise<void> {
  const at = await $.clock.now()
  if (!force && at - lastRead < REFRESH_MS) return
  lastRead = at
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (!b) return
    const taken: ContextSnapshot = {
      total: b.totalTokens,
      window: b.rawMaxTokens,
      threshold: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
      // Only what occupies the window: free space is drawn as the rest, the
      // compaction buffer as the threshold mark, deferred schemas not at all.
      rows: b.categories.filter(c => c.kind === 'used').map(c => ({ name: c.name, tokens: c.tokens })),
    }
    await update($, snapshot, () => taken)
  } catch {
    // No session bound yet: the next turn reads it.
  }
}

function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function pct(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`
}

async function toggleLegend($: Engine): Promise<boolean> {
  await update($, isLegendHidden, value => !value)
  const hidden = await read($, isLegendHidden)
  await $.store.set(LEGEND_KEY, hidden)
  return hidden
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

// ---------------------------------------------------------------- module

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Pokaż albo schowaj kartę z podziałem kontekstu nad promptem; „legenda” zwija samą legendę',
    })
    const stored = (await $.store.get(LEGEND_KEY)) === true
    await update($, isLegendHidden, () => stored)
    await refresh($, true)

    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    if (e.args.trim() === 'legenda') {
      return { text: (await toggleLegend($)) ? 'Legenda zwinięta.' : 'Legenda rozwinięta.' }
    }
    await update($, isHidden, value => !value)
    const hidden = await read($, isHidden)
    if (!hidden) await refresh($, true)

    return { text: hidden ? 'Karta kontekstu schowana.' : 'Karta kontekstu widoczna.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await refresh($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await refresh($, true)

    return next(e)
  })

  // A compaction ends no turn and brings no measurement, so the card would
  // keep the window from before it. The read waits for the compaction to land
  // but not the hook: a /compact runs longer than a hook's budget.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || e.trigger === 'precompute') return next(e)
    const done = next(e)
    void done.then(r => (r.skip === undefined ? refresh($, true) : undefined)).catch(() => {})
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever else draws here (another mod's band) stays, below the card.
    const below = await next(e)
    const taken = await read($, snapshot)
    if (e.props.hasSurvey || taken === null || (await read($, isHidden))) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const legendHidden = await read($, isLegendHidden)
    const isTerminal = e.surface === 'terminal'
    const fs = isTerminal ? undefined : ('footnote' as const)
    const { total, window, threshold, rows } = taken
    const share = total / window
    const pill = LEVEL[share >= 0.8 ? 2 : share >= 0.5 ? 1 : 0]!
    const colorOf = (name: string) => ROWS[name]?.color ?? OTHER
    const labelOf = (name: string) => ROWS[name]?.label ?? name.toLowerCase()
    const used = rows.reduce((sum, r) => sum + r.tokens, 0)

    // The bar: each row in proportion to the window, then free space up to the
    // compaction threshold, a thin mark there, and the rest. Proportions are
    // flex weights in tokens (width 0, grow by tokens): exact where a whole
    // percentage, all a width takes, would drop the smallest rows. The engine
    // caps a weight at 10000, so tokens become basis points of the window.
    // A full cell outweighs the text on desktop (20 px against 13 px of
    // glyphs); half a cell sits under it as a rule.
    const barHeight = isTerminal ? 1 : 0.5
    const MARK_TOKENS = window * 0.003
    const segment = (key: string, tokensIn: number, color?: string) => (
      <Box key={key} width={0} flexGrow={Math.max(0, (tokensIn / window) * 10_000)} height={barHeight} backgroundColor={color} />
    )
    const toMark = threshold !== undefined && threshold > used ? threshold - used : undefined
    const bar = (
      <Box key="bar" flexDirection="row" height={barHeight} width="100%" backgroundColor={FREE} overflow="hidden">
        {rows.filter(r => r.tokens > 0).map(r => segment(`seg-${r.name}`, r.tokens, colorOf(r.name)))}
        {toMark !== undefined
          ? [
              segment('to-mark', toMark),
              segment('mark', MARK_TOKENS, MARK),
              segment('after-mark', window - used - toMark - MARK_TOKENS),
            ]
          : segment('free', window - used)}
      </Box>
    )

    type Entry = { key: string; swatch: string; label: string; n: number }
    const entries: Entry[] = [
      ...rows.map(r => ({ key: `leg-${r.name}`, swatch: colorOf(r.name), label: labelOf(r.name), n: r.tokens })),
      { key: 'leg-free', swatch: FREE_SWATCH, label: 'wolne', n: Math.max(0, window - total) },
    ]
    // Set as usage-bar sets its row: the same footnote size, labels dim, the
    // figure at full strength and nothing bold, so the two read as one band.
    const item = ({ key, swatch, label, n }: Entry) => (
      <Box key={key} flexDirection="row">
        <Text color={swatch} size={fs}>■ </Text>
        <Text dimColor size={fs}>{label} </Text>
        <Text tabular size={fs}>{tokens(n)} </Text>
        <Text dimColor tabular size={fs}>{pct(n, window)}</Text>
      </Box>
    )

    // The legend is a grid: entry i goes to column i % cols, so it still reads
    // across, and each column is as wide as its widest entry, so the swatches
    // line up down the rows. As many columns as the band's width holds.
    const glyph = isTerminal ? 1 : GLYPH_CELLS
    const cells = (x: Entry) => (`■ ${x.label} ${tokens(x.n)} ${pct(x.n, window)}`.length) * glyph
    const split = (cols: number) => Array.from({ length: cols }, (_, c) => entries.filter((_, i) => i % cols === c))
    const widthOf = (cols: number) =>
      split(cols).reduce((sum, column) => sum + Math.max(...column.map(cells)), 0) + LEGEND_GAP * (cols - 1)
    const room = e.props.bodyColumns - (isTerminal ? 2 : 1)
    const cols = [4, 3, 2].find(c => c <= entries.length && widthOf(c) <= room) ?? 1
    const legend = (
      <Box flexDirection="row" columnGap={LEGEND_GAP}>
        {split(cols).map((column, c) => (
          <Box key={`leg-col-${c}`} flexDirection="column">
            {column.map(item)}
          </Box>
        ))}
      </Box>
    )

    // Desktop: the left inset clears the card's edge like the band beneath it;
    // none on the right, so the pill and the bar end on the compact button's axis.
    const card = (
      <Box
        key="context-card"
        flexDirection="column"
        gap="xs"
        paddingLeft={isTerminal ? 1 : 0.5}
        paddingRight={isTerminal ? 1 : 0}
        paddingTop={isTerminal ? 0 : 0.1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" alignItems="center">
            <Text size={fs}>
              <Text color="#D97757" size={fs}>◆ </Text>
              kontekst
            </Text>
            {/* A disclosure triangle beside the title: ▼ while the legend shows,
                ▶ once folded. A child, not a label: a desktop draws a label in
                its own small font (▾ came out 4 px) and the child at footnote.
                U+FE0E keeps ▶ a glyph where macOS would draw an emoji. No gap:
                the native button's own padding already parts it from the title. */}
            <Button key="legend-toggle" plain dimColor onPress={() => toggleLegend($)}>
              <Text size={fs}>{legendHidden ? '▶︎' : '▼'}</Text>
            </Button>
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text dimColor tabular size={fs}>
              <Text dimColor={false} size={fs}>{tokens(total)}</Text> z {tokens(window)}
              {threshold !== undefined ? ` · kompaktuje przy ${tokens(threshold)}` : ''}
            </Text>
            <Text backgroundColor={pill} color="#14161A" weight="semibold" tabular size={fs}>
              {` ${pct(total, window)} `}
            </Text>
          </Box>
        </Box>
        {bar}
        {!legendHidden && legend}
      </Box>
    )

    return below ? (
      <Box key="context-band" flexDirection="column" gap={isEngineSlot(below) ? 0 : 'sm'}>
        {card}
        {below}
      </Box>
    ) : (
      card
    )
  })
}
