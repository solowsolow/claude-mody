import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const BAND = {
  plugin: 'context-bar',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
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

function engine(on: On, total: number | (() => number) = 90_300, beneath?: string, stored: Record<string, unknown> = {}) {
  mock.clock(on, { now: Date.parse('2026-10-29T15:00:00Z') })
  mock.store(on, stored)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'context-bar' } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => {
    const now = typeof total === 'number' ? total : total()
    return {
    value: {
      startedAt: 0,
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
