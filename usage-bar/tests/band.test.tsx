import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-29T15:00:00Z')
const MIN = 60_000

function band(bodyColumns: number, isWorking = false) {
  return {
    plugin: 'usage-bar',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as const
}

function engine(
  on: On,
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[],
  stored: Record<string, unknown> = {},
  compact: { isOn: boolean; at: number; tokens?: number } = { isOn: true, at: 967_000 },
) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, stored)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('command.register', () => ({ value: { command: 'usage-bar' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', (_, e) => {
    const tokens = compact.tokens ?? 72_400
    const breakdown = e?.breakdown
      ? { isAutoCompactEnabled: compact.isOn, autoCompactThreshold: compact.isOn ? compact.at : undefined }
      : undefined
    return {
      value: { startedAt: T0, context: { tokens, window: 1_000_000, percent: 36, breakdown }, rateLimits },
    } as never
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The engine draws nothing above the prompt of its own.
  // The engine's own slot, as a live band hands it beneath the last mod.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  return clock
}

const LIMITS = [
  { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(T0 + 40 * MIN).toISOString() },
  { kind: 'seven_day', percentUsed: 7 },
]

async function endTurn($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]) {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

async function texts(ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string } | undefined> }, patterns: RegExp[]) {
  return Promise.all(patterns.map(async p => (await ui.find({ type: 'Text', text: p }))?.text))
}

test('the full bar reads as in the screenshot, on terminal and desktop', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await endTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(100), surface })
    expect(await texts(ui, [/^ cache warm $/, /^60m$/, /^72k$/, /^34%$/, /resets/, /^7%$/])).toEqual([
      ' cache warm ',
      '60m',
      '72k',
      '34%',
      ' · resets 00:40',
      '7%',
    ])
    await ui.unmount()
  }
})

test('the cache goes cold an hour after the last turn', async ($, on) => {
  const clock = engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await endTurn($)
  await clock.advance(61 * MIN)

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe(' cache cold')
  await ui.unmount()
})

test('a narrow column drops the countdown, then the week', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // 34 cells: at the footnote size the week still fits in 40.
  const ui = await $.ui.mount({ ...band(34), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^week $/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^34%$/ }))?.text).toBe('34%')
  await ui.unmount()
})

test('a 5-minute TTL counts down from 5m', { options: { cacheTtl: '5' } }, async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await endTurn($)

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^\d+m$/ }))?.text).toBe('5m')
  await ui.unmount()
})

test('off a subscription the limits are left out', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^5h $/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^72k$/ }))?.text).toBe('72k')
  expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe(' cache —')
  await ui.unmount()
})

test('a reload recalls the last request from the store', async ($, on) => {
  engine(on, LIMITS, { cacheAt: { 'sess-1': T0 - 10 * MIN } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect(await texts(ui, [/^ cache warm $/, /^\d+m$/])).toEqual([' cache warm ', '50m'])
  await ui.unmount()
})

test('desktop draws no frame of its own; the terminal keeps one', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [surface, frames] of [['desktop', 0], ['terminal', 1]] as const) {
    const ui = await $.ui.mount({ ...band(100), surface })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.borderStyle !== undefined)).toHaveLength(frames)
    await ui.unmount()
  }
})

test('the cache color fades from amber to grey as it goes cold', async ($, on) => {
  const clock = engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await endTurn($)
  // The tick at 60:00 finds the cache cold and starts the fade there.
  await clock.advance(60 * MIN)

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  const tint = async () => (await ui.find({ type: 'Text', text: /^●$/ }))?.props.color
  const seen = [await tint()]
  for (const step of [60, 60, 60, 60, 60, 60, 60, 60]) {
    await clock.advance(step)
    seen.push(await tint())
  }
  expect(seen[0]).toBe('#D9A441')
  expect(seen.at(-1)).toBe('#8A8A8A')
  // Every frame between is its own color, and the change slows as it lands.
  expect(new Set(seen).size).toBe(seen.length)
  expect((await ui.find({ type: 'Text', text: /cache/ }))?.text).toBe(' cache cold')
  await ui.unmount()
})

test('crossing 50% blinks the percent twice, then it settles', async ($, on) => {
  const clock = engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const crossed = [{ kind: 'five_hour', percentUsed: 52, resetsAt: LIMITS[0]!.resetsAt }, LIMITS[1]!]
  await $.session.measure({
    context: { tokens: 72_400, window: 200_000, percent: 36 },
    rateLimits: crossed,
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  const tint = async () => (await ui.find({ type: 'Text', text: /^52%$/ }))?.props.backgroundColor
  const seen = [await tint()]
  for (const step of [250, 250, 700]) {
    await clock.advance(step)
    seen.push(await tint())
  }
  expect(seen).toEqual(['rgba(217,164,65,0.28)', undefined, 'rgba(217,164,65,0.28)', undefined])
  await ui.unmount()
})

test('the /compact button compacts once and says how it went', async ($, on) => {
  engine(on, LIMITS)
  let calls = 0
  const toasts: string[] = []
  on('session.compact', () => (calls++, { skip: 'nothing to compact yet' }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...band(100), surface })
    const button = await ui.find({ key: 'compact' })
    expect(button?.text).toBe('→←')
    // No label of our own: it comes from the icon, so the icon is what is drawn.
    expect(button?.props.label).toBe('→←')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(calls).toBe(1)
  expect(toasts).toEqual(['Kompaktowanie pominięte: nothing to compact yet'])
  expect((await ui.find({ key: 'compact' }))?.text).toBe('→←')
  await ui.unmount()
})

test('a ~68-cell desktop band keeps the countdown the terminal drops', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await endTurn($)

  // What the screenshots bound the band to: ≥ 62 cells, < 74.
  for (const columns of [62, 68, 73]) {
    const ui = await $.ui.mount({ ...band(columns), surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /resets/ }))?.text).toBe(' · resets 00:40')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...band(68), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
  await ui.unmount()
})

test('the dot is a size down from the words, on the row axis', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  const dot = await ui.find({ type: 'Text', text: /^●$/ })
  expect(dot?.props.size).toBe('caption')
  const words = await ui.find({ type: 'Text', text: /cache/ })
  expect(words?.props.size).toBe('footnote')
  const row = (await ui.findAll({ type: 'Box' })).find(b => b.key === 'cache')
  expect(row?.props.alignItems).toBe('center')
  await ui.unmount()
})

test('the context shows how far auto-compaction is, coloured as it nears', async ($, on) => {
  engine(on, LIMITS, {}, { isOn: true, at: 967_000, tokens: 396_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(140), surface: 'desktop' })
  const far = await ui.find({ type: 'Text', text: /compact in/ })
  expect(far?.text).toBe(' · compact in 571k')
  expect(far?.props.color).toBe('#8A8A8A')
  await ui.unmount()
})

for (const [tokens, distance, color, name] of [
  [900_000, ' · compact in 67k', '#D9A441', 'amber inside the last 10%'],
  [950_000, ' · compact in 17k', '#DD6670', 'red inside the last 3%'],
] as const) {
  test(`near the threshold the distance turns ${name}`, async ($, on) => {
    engine(on, LIMITS, {}, { isOn: true, at: 967_000, tokens })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ ...band(140), surface: 'desktop' })
    const near = await ui.find({ type: 'Text', text: /compact in/ })
    expect(near?.text).toBe(distance)
    expect(near?.props.color).toBe(color)
    await ui.unmount()
  })
}

test('with auto-compaction off the distance is left out', async ($, on) => {
  engine(on, LIMITS, {}, { isOn: false, at: 0 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(140), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /compact in/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^72k$/ }))?.text).toBe('72k')
  await ui.unmount()
})

test('the band reads a step down on desktop; the terminal has one size', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [surface, size] of [['desktop', 'footnote'], ['terminal', undefined]] as const) {
    const ui = await $.ui.mount({ ...band(140), surface })
    const texts = (await ui.findAll({ type: 'Text' })).filter(t => t.text !== '●')
    expect(new Set(texts.map(t => t.props.size))).toEqual(new Set([size]))
    await ui.unmount()
  }
})

// 55 cells: room for all but one of the two asides, so exactly one gives way.
test('far from the threshold the distance gives way before the countdown', async ($, on) => {
  engine(on, LIMITS, {}, { isOn: true, at: 967_000, tokens: 396_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(55), surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /compact in/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /resets/ }))?.text).toBe(' · resets 00:40')
  await ui.unmount()
})

test('near the threshold the distance outlasts the countdown', async ($, on) => {
  engine(on, LIMITS, {}, { isOn: true, at: 967_000, tokens: 950_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(55), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /compact in/ }))?.text).toBe(' · compact in 17k')
  expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
  await ui.unmount()
})

test('the button stays on the row of figures', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(58), surface: 'desktop' })
  const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.props.justifyContent === 'space-between')
  expect(rows).toHaveLength(1)
  expect(rows[0]?.props.flexWrap).toBe('nowrap')
  await ui.unmount()
})

test('desktop insets the figures a little down and in; the terminal does not', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [surface, top, left] of [['desktop', 0.1, 0.5], ['terminal', undefined, undefined]] as const) {
    const ui = await $.ui.mount({ ...band(100), surface })
    const figures = (await ui.findAll({ type: 'Box' })).find(b => b.props.overflow === 'hidden')
    expect(figures?.props.paddingTop).toBe(top)
    expect(figures?.props.paddingLeft).toBe(left)
    await ui.unmount()
  }
})

test('the engine\'s empty slot beneath is kept, with no gap beside it', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'usage-band')?.props.gap).toBe(0)
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})
