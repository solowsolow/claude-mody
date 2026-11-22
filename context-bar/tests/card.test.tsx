import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

// A stand-in for usage-bar's row, whose button is taller than a line of text.
const BUTTON_ROW = '<wiersz z przyciskiem>'

const row = (name: string, tokens: number, kind = 'used') => ({ name, tokens, kind, color: 'text', isDeferred: kind === 'deferred' })

// The screenshot's figures: 90k of 1M, compaction at 987k.
const ROWS = [
  row('System prompt', 4200),
  row('System tools', 17_000),
  row('MCP tools', 52_000),
  row('Custom agents', 3400),
  row('Memory files', 8600),
  row('Skills', 5100),
  row('Messages', 0),
  row('MCP tools (deferred)', 634_000, 'deferred'),
  row('Free space', 896_700, 'free'),
  row('Autocompact buffer', 13_000, 'buffer'),
]

// The clock's start; a session starts then unless a test moves it.
const T0 = Date.parse('2026-10-29T15:00:00Z')
let startedAt = T0

function engine(on: On, total: number | (() => number) = 90_300, beneath?: string, stored: Record<string, unknown> = {}) {
  startedAt = T0
  const clock = mock.clock(on, { now: T0 })
  // The store as a plain object the test reads back: what the mod wrote, and deleted.
  on('store.get', (_, e) => ({ value: stored[e.key] }) as never)
  on('store.set', (_, e) => ((stored[e.key] = e.value), { value: undefined }) as never)
  on('store.delete', (_, e) => (delete stored[e.key], { value: undefined }) as never)
  on('store.keys', () => ({ value: Object.keys(stored) }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'context-bar' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => {
    const now = typeof total === 'number' ? total : total()
    return {
    value: {
      startedAt,
      context: {
        tokens: now,
        window: 1_000_000,
        breakdown: {
          totalTokens: now,
          rawMaxTokens: 1_000_000,
          isAutoCompactEnabled: true,
          autoCompactThreshold: 987_000,
          categories: ROWS,
        },
      },
      rateLimits: [],
    },
  } as never
  })
  // The engine draws nothing above the prompt; a test may stand another mod there.
  on('ui.render', ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (beneath === BUTTON_ROW) {
      // As usage-bar draws its row: text, then the compact button.
      return (
        <Box flexDirection="column">
          {/* What the engine may hand beneath: a Box that draws nothing. */}
          <Box />
          <Box flexDirection="row">
            <Text>cache warm</Text>
            <Button key="compact" onPress={() => undefined}>
              <Text>→←</Text>
            </Button>
          </Box>
        </Box>
      )
    }
    // Nothing else in the band: the engine's own slot, as a live band hands it.
    return beneath ? <Text>{beneath}</Text> : ({ type: 'engine', ref: 0 } as never)
  })
  return clock
}

test('the header reads like the screenshot, on terminal and desktop', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /kontekst$/ }))?.text).toBe('◆ kontekst')
    expect((await ui.find({ type: 'Text', text: /z 1M/ }))?.text).toBe('90k z 1M · kompaktuje przy 987k')
    const pill = await ui.find({ type: 'Text', text: /^ 9% $/ })
    expect(pill?.props.backgroundColor).toBe('#5DB36A')
    await ui.unmount()
  }
})

test('the pill turns amber past half the window', async ($, on) => {
  engine(on, 550_000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^ 55% $/ }))?.props.backgroundColor).toBe('#D9A441')
  await ui.unmount()
})

test('the bar is in proportion to the window, with a mark at the threshold', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const boxes = await ui.findAll({ type: 'Box' })
  const grow = (key: string) => {
    const g = boxes.find(b => b.key === key)?.props.flexGrow
    return typeof g === 'number' ? Math.round(g * 1000) / 1000 : g
  }
  expect(grow('seg-MCP tools')).toBe(520)
  expect(grow('seg-System prompt')).toBe(42)
  // Messages at 0 tokens get no segment; free space runs to the mark.
  expect(boxes.some(b => b.key === 'seg-Messages')).toBe(false)
  const used = 4200 + 17_000 + 52_000 + 3400 + 8600 + 5100
  expect(grow('to-mark')).toBe((987_000 - used) / 100)
  expect(grow('mark')).toBe(30)
  expect(boxes.find(b => b.key === 'mark')?.props.backgroundColor).toBe('#D9A441')
  // The weights are basis points of the window and add up to all of it.
  const total = boxes.filter(b => typeof b.props.flexGrow === 'number').reduce((sum, b) => sum + (b.props.flexGrow as number), 0)
  expect(Math.round(total)).toBe(10_000)
  await ui.unmount()
})

test('the bar is half a cell on desktop and a full cell in the terminal', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const [surface, height] of [['desktop', 0.5], ['terminal', 1]] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.find(b => b.key === 'bar')?.props.height).toBe(height)
    expect(boxes.find(b => b.key === 'seg-MCP tools')?.props.height).toBe(height)
    await ui.unmount()
  }
})

test('the desktop card ends on the right edge, on the compact button axis', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const card = (await ui.findAll({ type: 'Box' })).find(b => b.key === 'context-card')
  expect(card?.props.paddingLeft).toBe(0.5)
  expect(card?.props.paddingRight).toBe(0)
  await ui.unmount()
})

test('the legend is a grid that reads across, with as many columns as fit', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const columnsAt = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns } })
    const boxes = await ui.findAll({ type: 'Box' })
    const cols = boxes.filter(b => typeof b.key === 'string' && b.key.startsWith('leg-col-'))
    const order = boxes
      .filter(b => typeof b.key === 'string' && b.key.startsWith('leg-') && !b.key.startsWith('leg-col-'))
      .map(b => b.key)
    await ui.unmount()
    return { count: cols.length, order }
  }

  // Eight entries: the widest window takes four columns, a narrow one two.
  const wide = await columnsAt(120)
  expect(wide.count).toBe(4)
  // Column 0 holds entries 0 and 4, so the first row reads prompt, tools,
  // MCP, agents, and the second begins with memory files.
  expect(wide.order.slice(0, 2)).toEqual(['leg-System prompt', 'leg-Memory files'])
  expect((await columnsAt(45)).count).toBe(2)
  expect((await columnsAt(20)).count).toBe(1)
})

test('the legend is in Polish and leaves out deferred schemas and the buffer', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  for (const label of ['prompt systemowy ', 'narzędzia ', 'narzędzia MCP ', 'agenci ', 'pliki pamięci ', 'skille ', 'wiadomości ', 'wolne ']) {
    expect(texts).toContain(label)
  }
  expect(texts).toContain('52k ')
  expect(texts).toContain('910k ')
  expect(texts.some(t => /deferred|buffer/i.test(t))).toBe(false)
  await ui.unmount()
})

test('the card stands above whatever else draws in the band', async ($, on) => {
  engine(on, 90_300, 'wiersz usage-bar')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const title = texts.indexOf('◆ kontekst')
  expect(title).toBeGreaterThanOrEqual(0)
  expect(title).toBeLessThan(texts.indexOf('wiersz usage-bar'))
  await ui.unmount()
})

test('/context-bar hides the card and leaves the rest of the band', async ($, on) => {
  engine(on, 90_300, 'wiersz usage-bar')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const shown = await $.command.run({ command: 'context-bar', args: '' } as never)
  expect(shown.text).toBe('Karta kontekstu schowana.')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /kontekst$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /usage-bar/ }))?.text).toBe('wiersz usage-bar')
  await ui.unmount()
})

test('the chevron folds the legend, and the fold outlives the session', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const legendShown = async () => (await ui.findAll({ type: 'Text' })).some(t => t.text === 'wolne ')
  const chevron = async () => (await ui.findAll({ type: 'Text' })).find(t => /^[▼▶]/.test(t.text))?.text
  expect(await legendShown()).toBe(true)
  expect(await chevron()).toBe('▼')

  await ui.press({ key: 'legend-toggle' })
  expect(await legendShown()).toBe(false)
  expect(await chevron()).toBe('▶\uFE0E')
  // The bar and the header stay.
  expect((await ui.findAll({ type: 'Box' })).some(b => b.key === 'bar')).toBe(true)
  await ui.unmount()

  // A new session reads the fold back from the store, not from this one's state.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const next = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await next.findAll({ type: 'Text' })).some(t => t.text === 'wolne ')).toBe(false)
  await next.press({ key: 'legend-toggle' })
  expect((await next.findAll({ type: 'Text' })).some(t => t.text === 'wolne ')).toBe(true)
  await next.unmount()
})

test('a session starts with the legend as the last one left it', async ($, on) => {
  engine(on, 90_300, undefined, { legendHidden: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'wolne ')).toBe(false)
  await ui.unmount()
})

test('/context-bar legenda folds the legend and leaves the card', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const folded = await $.command.run({ command: 'context-bar', args: 'legenda' } as never)
  expect(folded.text).toBe('Legenda zwinięta.')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /kontekst$/ }))?.text).toBe('◆ kontekst')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'wolne ')).toBe(false)
  await ui.unmount()
  expect((await $.command.run({ command: 'context-bar', args: 'legenda' } as never)).text).toBe('Legenda rozwinięta.')
})

test('the legend is set like usage-bar: labels dim, nothing bold but the pill', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(t => t.text === 'narzędzia MCP ')?.props.dimColor).toBe(true)
  expect(texts.find(t => t.text === '52k ')?.props.size).toBe('footnote')
  const bold = texts.filter(t => t.props.weight === 'semibold').map(t => t.text)
  expect(bold).toEqual([' 9% '])
  await ui.unmount()
})

test('the engine\'s empty slot beneath is kept, with no gap beside it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'context-band')?.props.gap).toBe(0)
  await ui.unmount()
})

test('a row beneath, a button in it or not, is parted by one gap', async ($, on) => {
  engine(on, 90_300, BUTTON_ROW)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'context-band')?.props.gap).toBe('sm')
  await ui.unmount()
})

// No turn ends and no measurement comes after a compaction: the card read
// 210k, the figure from before, while the window held far less.
test('a compaction redraws the card with the window after it', async ($, on) => {
  let total = 210_463
  engine(on, () => total)
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  on('session.compact', () => ({ messages: summary, tokensBefore: 210_463, tokensAfter: 69_878 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const header = async () => (await ui.find({ type: 'Text', text: /z 1M/ }))?.text
  expect(await header()).toBe('210k z 1M · kompaktuje przy 987k')

  total = 186_000
  await $.session.compact({ trigger: 'manual', messages: summary } as never)
  for (let i = 0; i < 50 && (await header())?.startsWith('210k'); i++);
  expect(await header()).toBe('186k z 1M · kompaktuje przy 987k')

  // A subagent's compaction is not the main window's.
  total = 120_000
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: summary } as never)
  for (let i = 0; i < 10; i++) await header()
  expect(await header()).toBe('186k z 1M · kompaktuje przy 987k')
  await ui.unmount()
})

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const used = (input: number, read: number, write: number, output: number): Usage => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  output_tokens: output,
})

// What the engine's next model response reports; a test sets it before a step.
let stepUsage: Usage | null = null

function answers(on: On) {
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: stepUsage && { ...stepUsage, model: 'm' } } as never
  })
}

// One model request of a loop through the hooks, read to its end.
async function step($: { turn: { step: unknown } }, usage: Usage | null, agentId?: string): Promise<unknown> {
  stepUsage = usage
  const stream = ($.turn.step as (e: unknown) => AsyncGenerator<unknown, unknown>)({ turnId: 't', index: 0, model: 'm', messageCount: 2, agentId })
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

test('the header counts every token the session went through: its requests, its subagents\', its compactions\'', async ($, on) => {
  const stored: Record<string, unknown> = {}
  engine(on, 90_300, undefined, stored)
  answers(on)
  const summary: SessionMessage[] = [{ role: 'user', text: 'podsumowanie', toolUses: [] }]
  on('session.compact', () => ({ messages: summary, usage: used(500, 0, 0, 1500) }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const spentText = async () => (await ui.find({ type: 'Text', text: /zużyto/ }))?.text
  // Nothing counted yet: nothing said.
  expect(await spentText()).toBeUndefined()

  // The main loop's request, a subagent's, one with no usage and a compaction.
  expect(await step($, used(2000, 30_000, 1000, 500))).toMatchObject({ stopReason: 'end_turn' })
  await step($, used(1000, 8000, 0, 2000), 'a1')
  await step($, null)
  await $.session.compact({ trigger: 'auto', messages: summary } as never)
  for (let i = 0; i < 20 && (await spentText()) !== 'zużyto w sesji 47k'; i++);

  // 33.5k + 11k + 2k = 46.5k, shown rounded
  expect(await spentText()).toBe('zużyto w sesji 47k')
  expect((await ui.find({ type: 'Text', text: /zużyto/ }))?.props.dimColor).toBe(true)
  expect(stored[`spent-${T0}`]).toEqual({ startedAt: T0, tokens: 46_500, since: T0 })
  stepUsage = null
  await ui.unmount()
})

test('a reload or a resumed session carries on with the stored tally; /clear starts a new one', async ($, on) => {
  const old = T0 - 40 * 24 * 60 * 60_000
  const stored: Record<string, unknown> = {
    [`spent-${T0}`]: { startedAt: T0, tokens: 2_400_000, since: T0 },
    // A session over a month old: pruned as this one starts.
    [`spent-${old}`]: { startedAt: old, tokens: 9, since: old },
  }
  const clock = engine(on, 90_300, undefined, stored)
  answers(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(Object.keys(stored).sort()).toEqual([`spent-${T0}`])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const spentText = async () => (await ui.find({ type: 'Text', text: /zużyto/ }))?.text
  expect(await spentText()).toBe('zużyto w sesji 2.4M')

  await step($, used(0, 95_000, 0, 5000))
  for (let i = 0; i < 20 && (await spentText()) !== 'zużyto w sesji 2.5M'; i++);
  expect(await spentText()).toBe('zużyto w sesji 2.5M')

  // /clear: the session's clock starts over, and so does the tally.
  await clock.advance(60_000)
  startedAt = T0 + 60_000
  await step($, used(1000, 0, 0, 200))
  for (let i = 0; i < 20 && (await spentText()) !== 'zużyto w sesji 1.2k'; i++);
  expect(await spentText()).toBe('zużyto w sesji 1.2k')
  expect(stored[`spent-${T0}`]).toEqual({ startedAt: T0, tokens: 2_500_000, since: T0 })
  stepUsage = null
  await ui.unmount()
})

test('a tally the mod began late says how long it covers', async ($, on) => {
  const clock = engine(on)
  answers(on)
  // The session ran an hour before the mod came.
  startedAt = T0 - 60 * 60_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(25 * 60_000)
  await step($, used(1000, 10_000, 0, 1000))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  let text: string | undefined
  for (let i = 0; i < 20 && !(text = (await ui.find({ type: 'Text', text: /zużyto/ }))?.text); i++);
  expect(text).toBe('zużyto 12k od 25 min')
  stepUsage = null
  await ui.unmount()
})
