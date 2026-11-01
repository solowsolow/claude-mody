import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { isHeadlessRefusal } from '../hooks/register'

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
      ? {
          isAutoCompactEnabled: compact.isOn,
          autoCompactThreshold: compact.isOn ? compact.at : undefined,
          totalTokens: 187_000,
        }
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

// The press only starts a compaction; its outcome lands a few engine round
// trips later. Each find is one such trip.
async function until(ui: { find: (q: { key: string }) => Promise<unknown> }, isDone: () => boolean) {
  for (let i = 0; i < 50 && !isDone(); i++) await ui.find({ key: 'compact' })
}

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
  await until(ui, () => toasts.length > 0)
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

// As the engine refuses $.session.compact in the desktop app and the SDK,
// copied from the toast it raised there.
const HEADLESS_REFUSAL =
  '$.session.compact: not available in a headless (-p / SDK) session yet: compaction here runs inside a turn (a /compact prompt); catch it and carry on'

test('the engine\'s headless refusal is told apart from any other', () => {
  expect(isHeadlessRefusal(HEADLESS_REFUSAL)).toBe(true)
  expect(isHeadlessRefusal('a turn is running')).toBe(false)
  expect(isHeadlessRefusal('no implementation for session.compact')).toBe(false)
})

test('in a session the SDK hosts, the button runs the /compact command', async ($, on) => {
  engine(on, LIMITS)
  const submitted: string[] = []
  const toasts: string[] = []
  let compactCalls = 0
  on('session.compact', () => (compactCalls++, { skip: 'never asked' }))
  on('command.run', (_, e) => (submitted.push(`/${e.command}`), {}))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await until(ui, () => toasts.length > 0)
  expect(submitted).toEqual(['/compact'])
  expect(compactCalls).toBe(0)
  expect(toasts).toEqual(['Kompaktowanie uruchomione.'])
  // The button is free again for the next press.
  expect((await ui.find({ key: 'compact' }))?.text).toBe('→←')
  await ui.unmount()
})

test('any other refusal is reported, and nothing is run in its place', async ($, on) => {
  engine(on, LIMITS)
  const submitted: string[] = []
  const toasts: string[] = []
  on('command.run', (_, e) => (submitted.push(`/${e.command}`), {}))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // No implementation beneath: the engine rejects, for a reason that is not
  // the headless one.
  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await until(ui, () => toasts.length > 0)
  expect(submitted).toEqual([])
  expect(toasts).toEqual(['Kompaktowanie nie powiodło się: no implementation for session.compact'])
  await ui.unmount()
})

// A /compact runs 20 s and more, past a press hook's 10 s budget: the press
// returns at once, the button waits as ⋯, and the outcome comes later.
test('the press returns before the compaction ends', async ($, on) => {
  engine(on, LIMITS)
  const toasts: string[] = []
  let finish: () => void = () => {}
  on('command.run', () => new Promise(done => (finish = () => done({}))))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect((await ui.find({ key: 'compact' }))?.text).toBe('⋯')
  expect(toasts).toEqual([])

  finish()
  await until(ui, () => toasts.length > 0)
  expect(toasts).toEqual(['Kompaktowanie uruchomione.'])
  await until(ui, () => false)
  expect((await ui.find({ key: 'compact' }))?.text).toBe('→←')
  await ui.unmount()
})

// Right after compaction no response has been answered yet, so the engine has
// no fill to report; the band shows the local estimate instead of nothing.
test('with no response since compaction, ctx shows the estimate', async ($, on) => {
  engine(on, LIMITS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 1_000_000 }, rateLimits: LIMITS, changed: ['context'] })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^187k$/ }))?.text).toBe('187k')
  expect((await ui.find({ type: 'Text', text: /compact in/ }))?.text).toBe(' · compact in 780k')
  await ui.unmount()
})

// A compaction raises no measurement, and the one after its turn may still
// carry the figure from before: the band drops that figure as the compaction
// lands and shows the estimate until a response reports a new one.
test('after a compaction ctx drops the figure from before', async ($, on) => {
  engine(on, LIMITS)
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  on('session.compact', () => ({ messages: summary, tokensAfter: 50_000 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const measure = (tokens: number) =>
    $.session.measure({ context: { tokens, window: 1_000_000, percent: 61 }, rateLimits: LIMITS, changed: ['context'] })
  await measure(606_000)

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^606k$/ }))?.text).toBe('606k')

  await $.session.compact({ trigger: 'manual', messages: summary } as never)
  const shows = (n: string) => async () => (await ui.find({ type: 'Text', text: new RegExp(`^${n}$`) }))?.text
  for (let i = 0; i < 50 && !(await shows('187k')()); i++);
  expect(await shows('187k')()).toBe('187k')

  await measure(606_000)
  expect(await shows('187k')()).toBe('187k')

  await measure(190_000)
  expect(await shows('190k')()).toBe('190k')
  await ui.unmount()
})

// What a compaction took and what it cost, told once it lands, whatever
// started it; the summarizer's request is the cost, read from the cache or not.
test('a compaction says how far it shrank the window and what it cost', async ($, on) => {
  engine(on, LIMITS)
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1_491, cache_read_input_tokens: 604_566, output_tokens: 7_000 }
  let result: object = { messages: summary, tokensBefore: 606_423, tokensAfter: 73_836, usage }
  on('session.compact', () => result as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })

  await $.session.compact({ trigger: 'manual', messages: summary } as never)
  await until(ui, () => toasts.length > 0)
  expect(toasts).toEqual(['Skompaktowano 606k → 74k · koszt: 7k wyjścia, 1k wejścia, 605k z cache'])

  // A summary computed ahead of time, or a hook's, made no request of its own.
  result = { messages: summary, tokensBefore: 639_388, tokensAfter: 73_836 }
  await $.session.compact({ trigger: 'auto', messages: summary } as never)
  await until(ui, () => toasts.length > 1)
  expect(toasts[1]).toBe('Skompaktowano 639k → 74k · bez danych o koszcie')
  await ui.unmount()
})

// The button's own word stands in only when no compaction landed.
test('a press whose compaction landed adds no toast of its own', async ($, on) => {
  engine(on, LIMITS)
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  on('session.compact', () => ({ messages: summary, tokensBefore: 606_423, tokensAfter: 73_836 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await until(ui, () => toasts.length > 0)
  await until(ui, () => false)
  expect(toasts).toEqual(['Skompaktowano 606k → 74k · bez danych o koszcie'])
  await ui.unmount()
})

// Where the SDK hosts the session the button runs /compact, whose compaction
// passes this mod's hook: one toast, the hook's, not the button's too.
test('in a session the SDK hosts, a landed /compact is told once', async ($, on) => {
  engine(on, LIMITS)
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  on('session.compact', () => ({ messages: summary, tokensBefore: 606_423, tokensAfter: 73_836 }))
  on('command.run', async () => {
    await $.session.compact({ trigger: 'manual', messages: summary } as never)
    return {}
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  const ui = await $.ui.mount({ ...band(100), surface: 'desktop' })
  await ui.press({ key: 'compact' })
  await until(ui, () => toasts.length > 0)
  await until(ui, () => false)
  expect(toasts).toEqual(['Skompaktowano 606k → 74k · bez danych o koszcie'])
  await ui.unmount()
})
