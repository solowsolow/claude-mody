import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-29T18:00:00Z')
const MIN = 60_000
const DIR = '/home/u/.claude/radar-sesji'
const ME = 'me-00000000'

type Peer = {
  session: string
  project: string
  topic?: string
  state: string
  reason?: string
  since: number
  beat: number
  ended?: boolean
}

// A stand-in for usage-bar's row, whose button is taller than a line of text.
const BUTTON_ROW = '<wiersz z przyciskiem>'

const BAND = {
  plugin: 'radar-sesji',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const PANE = {
  plugin: 'radar-sesji',
  component: 'Pane',
  requestId: 'radar-sesji',
  props: { title: 'Sesje', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// A disk in memory with a modification time per file, and a clock.
function engine(on: On, others: Peer[], beneath?: string, onTool?: () => void, env: Record<string, string> = { HOME: '/home/u' }) {
  const disk = new Map<string, { text: string; mtimeMs: number }>(
    others.map(p => [`${DIR}/${p.session}.json`, { text: JSON.stringify(p), mtimeMs: p.beat }]),
  )
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, env)
  on('session.id', () => ({ value: ME }))
  on('session.root', () => ({ value: '/Users/u/Documents/Claude' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: ME }))
  on('command.register', () => ({ value: { command: 'sesje' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', (_, e) => ({ value: [...disk.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({
    value: [...disk.entries()]
      .filter(([k]) => k.startsWith(`${e.path}/`))
      .map(([k, v]) => ({ name: k.slice(e.path!.length + 1), kind: 'file', size: 1, mtimeMs: v.mtimeMs, isLink: false })),
  }) as never)
  on('fs.read', (_, e) => ({ value: disk.get(e.path)?.text ?? '' }) as never)
  on('fs.write', (_, e) => (disk.set(e.path, { text: e.text, mtimeMs: T0 }), { value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', () => (onTool?.(), { result: {} }) as never)
  on('classic.PermissionRequest', () => ({}) as never)
  on('classic.PermissionDenied', () => ({}) as never)
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
  const mine = () => JSON.parse(disk.get(`${DIR}/${ME}.json`)?.text ?? '{}') as Peer
  const put = (p: Peer) => disk.set(`${DIR}/${p.session}.json`, { text: JSON.stringify(p), mtimeMs: p.beat })
  return { clock, mine, put }
}

const peer = (session: string, state: string, sinceAgo: number, extra: Partial<Peer> = {}): Peer => ({
  session,
  project: '/Users/u/Documents/Claude',
  state,
  since: T0 - sinceAgo * MIN,
  beat: T0 - 10_000,
  ...extra,
})

// The typed tool.call is deeper than the checker follows for an untyped input.
const callTool = ($: { tool: { call: unknown } }, input: Record<string, unknown>) =>
  ($.tool.call as (e: unknown) => Promise<unknown>)(input)

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<Array<{ text: string }>> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

// ---------------------------------------------------------------- own state

test('this session publishes its state as the person and the model act', async ($, on) => {
  const { mine } = engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Opened, nothing asked yet: not working.
  expect(mine().state).toBe('spokój')

  await $.prompt.submit({ text: 'Napraw stronę główną sklepu-online\ni dodaj testy' } as never)
  expect(mine().topic).toBe('Napraw stronę główną sklepu-onl…')

  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as never)
  expect([mine().state, mine().reason]).toEqual(['zgoda', 'zgoda na Bash'])

  // The call that returns was allowed: the prompt is answered.
  await callTool($, { tool: 'Bash', command: 'ls' })
  expect(mine().state).toBe('praca')

  await $.turn.complete({ turnId: 't1', answer: 'gotowe' } as never)
  expect(mine().state).toBe('tura')

  await $.session.end({ reason: 'other' } as never)
  expect(mine().ended).toBe(true)
})

test('a question tool waits on the person for as long as it runs', async ($, on) => {
  let during: Peer | undefined
  const { mine } = engine(on, [], undefined, () => {
    during = mine()
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await callTool($, { tool: 'ExitPlanMode', plan: 'plan' })
  expect([during?.state, during?.reason]).toEqual(['pytanie', 'plan do akceptacji'])
  expect(mine().state).toBe('praca')
})

test('a subagent turn ending does not mark the session as waiting', async ($, on) => {
  const { mine } = engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.turn.start({ text: 'zadanie', turnId: 't0' })
  await $.turn.complete({ turnId: 't1', answer: '', agentId: 'a1' } as never)
  expect(mine().state).toBe('praca')
})

test('a command shows the person has the session in hand', async ($, on) => {
  const { mine } = engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.complete({ turnId: 't1', answer: '' } as never)

  await $.prompt.submit({ text: '/context-bar', command: { name: 'context-bar', args: '' } } as never)
  expect(mine().state).toBe('spokój')
  // A command names no topic.
  expect(mine().topic).toBeUndefined()
})

// ---------------------------------------------------------------- band

test('the band names the waiting sessions, oldest first, and counts finished turns', async ($, on) => {
  engine(on, [
    peer('bbbbbbbb-1', 'pytanie', 1, { topic: 'notatki: nowy wpis', reason: 'pytanie' }),
    peer('aaaaaaaa-1', 'zgoda', 4, { topic: 'strona-firmy deploy', reason: 'zgoda na Bash' }),
    peer('cccccccc-1', 'tura', 10, { topic: 'raport' }),
    peer('dddddddd-1', 'praca', 2, { topic: 'w toku' }),
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = await texts(ui)
    expect(all).toContain(' 2 sesje czekają:  ')
    expect(all.indexOf('strona-firmy deploy')).toBeLessThan(all.indexOf('notatki: nowy wpis'))
    expect(all).toContain(' · zgoda na Bash · 4 min')
    expect(all).toContain(' · pytanie · 1 min')
    expect(all).toContain('+1 po turze')
    expect(all.some(t => t.includes('w toku'))).toBe(false)
    await ui.unmount()
  }
})

test('with only finished turns the band is a quiet grey line', async ($, on) => {
  engine(on, [peer('cccccccc-1', 'tura', 10), peer('eeeeeeee-1', 'tura', 3)])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /po turze/ })
  expect(line?.text).toBe(' 2 sesje po turze')
  expect(line?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe('#8A8F98')
  await ui.unmount()
})

test('nothing waiting: the band leaves the rest as it is', async ($, on) => {
  engine(on, [peer('dddddddd-1', 'praca', 2), peer('ffffffff-1', 'tura', 90)], 'wiersz usage-bar')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await texts(ui)).toEqual(['wiersz usage-bar'])
  await ui.unmount()
})

test('the line stands above whatever else draws in the band', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'zgoda', 4, { reason: 'zgoda na Edit' })], 'wiersz usage-bar')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = await texts(ui)
  expect(all.indexOf(' 1 sesja czeka:  ')).toBeGreaterThanOrEqual(0)
  expect(all.indexOf(' 1 sesja czeka:  ')).toBeLessThan(all.indexOf('wiersz usage-bar'))
  // No topic yet: the session is named by its id.
  expect(all).toContain('sesja aaaaaaaa')
  // A row beneath is parted by one gap.
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'radar-band')?.props.gap).toBe('sm')
  await ui.unmount()
})

test('a silent, ended or own session is left out', async ($, on) => {
  engine(on, [
    { ...peer('aaaaaaaa-1', 'zgoda', 4), beat: T0 - 4 * MIN },
    peer('bbbbbbbb-1', 'zgoda', 4, { ended: true }),
    peer(ME, 'zgoda', 4),
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await texts(ui)).some(t => /czeka/.test(t))).toBe(false)
  await ui.unmount()
})

test('a newly waiting session lights the dot from grey to amber', async ($, on) => {
  const { clock } = engine(on, [peer('aaaaaaaa-1', 'zgoda', 0)])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const dot = async () => (await ui.find({ type: 'Text', text: /^●$/ }))?.props.color
  expect(await dot()).toBe('#8A8F98')
  await clock.advance(60 * 4)
  const mid = await dot()
  expect(mid).not.toBe('#8A8F98')
  expect(mid).not.toBe('#D9A441')
  await clock.advance(60 * 4)
  expect(await dot()).toBe('#D9A441')
  await ui.unmount()
})

test('the polish counts agree with their numbers', async ($, on) => {
  engine(on, Array.from({ length: 5 }, (_, i) => peer(`s${i}-0000000`, 'zgoda', i)))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const all = await texts(ui)
  expect(all).toContain(' 5 sesji czeka:  ')
  // Three named, two counted.
  expect(all).toContain('+2 czekają')
  await ui.unmount()
})

// ---------------------------------------------------------------- pane

test('/sesje opens the pane, sessions grouped by what they need', async ($, on) => {
  engine(on, [
    peer('aaaaaaaa-1', 'zgoda', 4, { topic: 'strona-firmy deploy', reason: 'zgoda na Bash', project: '/Users/u/Developer/strona-firmy' }),
    peer('cccccccc-1', 'tura', 70, { topic: 'raport' }),
    peer('dddddddd-1', 'praca', 2, { topic: 'w toku' }),
  ])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const done = await $.command.run({ command: 'sesje', args: '' } as never)
  expect(done.text).toBe('Panel sesji otwarty.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await texts(ui)
    expect(all.filter(t => /^[A-ZĄĘŻ ]+ · \d+$/.test(t))).toEqual(['CZEKAJĄ NA CIEBIE · 1', 'PO TURZE · 1', 'PRACUJĄ · 1'])
    expect(all).toContain('strona-firmy')
    expect(all).toContain(' · zgoda na Bash · 4 min')
    // The pane keeps a turn the band has let go of.
    expect(all).toContain(' · skończyła turę · 1 h')
    // The folder gives way; the reason and its age do not.
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.find(b => b.key === 'where-aaaaaaaa-1')?.props.flexShrink).toBe(1)
    expect(boxes.find(b => b.key === 'what-aaaaaaaa-1')?.props.flexShrink).toBe(0)
    // The dot stands on the topic's line.
    expect(boxes.find(b => b.key === 'peer-aaaaaaaa-1')?.props.alignItems).toBe('flex-start')
    await ui.unmount()
  }
})

test('an empty pane says so', async ($, on) => {
  engine(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await texts(ui)).toContain('Żadna inna sesja Claude na tym komputerze nie jest teraz otwarta.')
  await ui.unmount()
})

test('in a narrow window the topic gives way, never the headline or the reason', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'zgoda', 2, { topic: 'utwórz plik /tmp/radar-test-2.txt', reason: 'zgoda na Bash' })])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 50 } })
  const boxes = await ui.findAll({ type: 'Box' })
  const shrink = (key: string) => boxes.find(b => b.key === key)?.props.flexShrink
  expect(shrink('name-aaaaaaaa-1')).toBe(1)
  expect(shrink('why-aaaaaaaa-1')).toBe(0)
  const headline = boxes.find(b => b.props.flexShrink === 0 && b.key === undefined)
  expect(headline).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /czeka:/ }))?.text).toBe(' 1 sesja czeka:  ')
  expect((await ui.find({ type: 'Text', text: /radar-test/ }))?.props.wrap).toBe('truncate-end')
  await ui.unmount()
})

test('the engine\'s empty slot beneath is kept, with no gap beside it', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'zgoda', 4, { reason: 'zgoda na Edit' })])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'radar-band')?.props.gap).toBe(0)
  await ui.unmount()
})

test('a row with a button beneath is parted by the same one gap', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'zgoda', 4, { reason: 'zgoda na Edit' })], BUTTON_ROW)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Box' })).find(b => b.key === 'radar-band')?.props.gap).toBe('sm')
  await ui.unmount()
})

test('× clears the line until a session changes its state', async ($, on) => {
  const { clock, put } = engine(on, [peer('aaaaaaaa-1', 'tura', 3, { topic: 'raport' })])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const lineShown = async () => (await ui.findAll({ type: 'Box' })).some(b => b.key === 'radar-line')
  expect(await lineShown()).toBe(true)

  await ui.press({ key: 'radar-clear' })
  expect(await lineShown()).toBe(false)
  // The same state, polled again, stays cleared.
  await clock.advance(5_000)
  expect(await lineShown()).toBe(false)

  // The session asks for permission: a new state, a new moment, back it comes.
  put(peer('aaaaaaaa-1', 'zgoda', 0, { topic: 'raport', reason: 'zgoda na Bash', beat: T0 + 5_000 }))
  await clock.advance(5_000)
  expect(await lineShown()).toBe(true)
  expect((await texts(ui))).toContain(' · zgoda na Bash · teraz')
  await ui.unmount()
})

test('× clears the band only: the pane still lists every session', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'tura', 3, { topic: 'raport' })])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'radar-clear' })
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await texts(pane)).toContain('raport')
  await pane.unmount()
})

test('the × is a plain button, so the line keeps a line\'s height', async ($, on) => {
  engine(on, [peer('aaaaaaaa-1', 'zgoda', 4)])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const button = (await ui.findAll({ type: 'Button' })).find(b => b.key === 'radar-clear')
  expect(button?.props.plain).toBe(true)
  await ui.unmount()
})

test('on Windows the trace goes under USERPROFILE, where HOME is not set', async ($, on) => {
  const { mine } = engine(on, [], undefined, undefined, { USERPROFILE: '/home/u' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(mine().session).toBe(ME)
})
