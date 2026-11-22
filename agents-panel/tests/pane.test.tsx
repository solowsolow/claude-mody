import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'agents-panel',
  component: 'Pane',
  requestId: 'agents-panel',
  props: {
    title: 'Agenci',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REVIEWER = `---
name: code-reviewer
description: "Reviews the current diff for correctness bugs.\\n<example>long example</example>"
model: sonnet
color: blue
---
You review code.`

const NOTES = `---
name: release-notes
description: >
  Turns the commits since the last tag
  into user-facing release notes.
model: haiku
---
You write release notes.`

type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}
type Live = {
  id: string
  description: string
  type: string
  status: string
  model?: string
  effort?: string | number
  contextWindowSize?: number
  usage?: Usage[]
  lastRequest?: { at: number; model: string; effort?: string | number }
}
const RELEASE: Live = { id: 'a1', description: 'release-notes · panel', type: 'release-notes', status: 'running' }

// The typed tool.call is deeper than the checker follows for an untyped input.
const callTool = ($: { tool: { call: unknown } }, input: Record<string, unknown>) =>
  ($.tool.call as (e: unknown) => Promise<unknown>)(input)

// The panes this test's session asked to open, in order.
const opened: string[] = []

function engine(on: On, files: Record<string, string>, live: Live[] = [RELEASE]) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  on('command.register', () => ({ value: { command: 'agents-panel' } }))
  opened.length = 0
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/proj/.claude/agents' && Object.keys(files).length > 0 }))
  on('fs.list', () => ({
    value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: files[e.path.split('/').pop() ?? ''] ?? '' }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: live }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: stepUsage } as never
  })
  return clock
}

// What the engine's next model response reports; a test sets it before a step.
let stepUsage: Usage | null = null

// Runs one model request of a loop through the hooks, read to its end.
async function step($: { turn: { step: unknown } }, agentId?: string): Promise<unknown> {
  const stream = ($.turn.step as (e: unknown) => AsyncGenerator<unknown, unknown>)({
    turnId: 't',
    index: 0,
    model: 'claude-haiku-4-5-20251001',
    messageCount: 3,
    agentId,
  })
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}

test('lists project agents with model and description on every surface', async ($, on) => {
  engine(on, { 'code-reviewer.md': REVIEWER, 'release-notes.md': NOTES })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^code-reviewer$/ }))?.text).toBe('code-reviewer')
    expect((await ui.find({ type: 'Text', text: /^sonnet$/ }))?.text).toBe('sonnet')
    expect((await ui.find({ type: 'Text', text: /Reviews the current/ }))?.text).toBe(
      'Reviews the current diff for correctness bugs.',
    )
    expect((await ui.find({ type: 'Text', text: /Turns the commits/ }))?.text).toBe(
      'Turns the commits since the last tag into user-facing release notes.',
    )
    expect(await ui.find({ key: 'run-release-notes' })).toBeDefined()
    await ui.unmount()
  }
})

test('run shows the agent running, then done', async ($, on) => {
  engine(on, { 'code-reviewer.md': REVIEWER, 'release-notes.md': NOTES })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-release-notes' })

  expect(await ui.find({ key: 'run-release-notes' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /działa ·/ }))?.text).toBe('działa · 0s')
  expect((await ui.find({ type: 'Text', text: /^1 działa$/ }))?.text).toBe('1 działa')

  await $.turn.complete({
    answer: 'notes',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    agentId: 'a1',
    reason: 'answer',
  })

  expect((await ui.find({ type: 'Text', text: /✓/ }))?.text).toBe('✓ 0s')
  expect(await ui.find({ key: 'run-release-notes' })).toBeDefined()
  await ui.unmount()
})

test('with no agent files the pane says how to add one', async ($, on) => {
  engine(on, {})
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Brak agentów/ }))?.text).toMatch(/Brak agentów/)
  await ui.unmount()
})

test('the spinner turns while an agent runs and stops when it ends', async ($, on) => {
  const clock = engine(on, { 'release-notes.md': NOTES })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const glyph = async () => (await ui.findAll({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).map(t => t.text)
  expect(await glyph()).toEqual([])

  await ui.press({ key: 'run-release-notes' })
  const first = await glyph()
  // One in the header, one in the row, on the same frame.
  expect(first).toHaveLength(2)
  await clock.advance(80)
  const second = await glyph()
  expect(second[0]).not.toBe(first[0])

  await $.turn.complete({ answer: 'notes', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  expect(await glyph()).toEqual([])
  await ui.unmount()
})

test('a working agent shows its current tool in place of its description', async ($, on) => {
  engine(on, { 'release-notes.md': NOTES })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-release-notes' })
  await callTool($, { tool: 'Read', file_path: '/proj/src/app.ts', agentId: 'a1' })
  expect((await ui.find({ type: 'Text', text: /⏵/ }))?.text).toBe('⏵ Read · app.ts')
  expect(await ui.find({ type: 'Text', text: /Turns the commits/ })).toBeUndefined()

  await callTool($, { tool: 'Bash', command: 'git log --oneline v1.2..HEAD', agentId: 'a1' })
  expect((await ui.find({ type: 'Text', text: /⏵/ }))?.text).toBe('⏵ Bash · git')
  await ui.unmount()
})

test('agents the model spawns from other types get a section of their own', async ($, on) => {
  const explore: Live = { id: 'x1', description: 'Szukam wywołań API', type: 'Explore', status: 'running' }
  const clock = engine(on, { 'release-notes.md': NOTES }, [explore])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /INNE AGENTY/ }))?.text).toBe('INNE AGENTY')
  expect((await ui.find({ type: 'Text', text: /^Explore$/ }))?.text).toBe('Explore')
  expect((await ui.find({ type: 'Text', text: /Szukam/ }))?.text).toBe('Szukam wywołań API')
  expect(await ui.find({ key: 'log-x1' })).toBeDefined()

  await callTool($, { tool: 'Grep', pattern: 'fetch\\(', agentId: 'x1' })
  expect((await ui.find({ type: 'Text', text: /⏵/ }))?.text).toBe('⏵ Grep · fetch\\(')
  await ui.unmount()
})

test('an ended agent of another type leaves the section after 10 minutes', async ($, on) => {
  const explore: Live = { id: 'x1', description: 'Szukam wywołań API', type: 'Explore', status: 'running' }
  const clock = engine(on, { 'release-notes.md': NOTES }, [explore])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'x1', reason: 'answer' })
  explore.status = 'completed'

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Explore$/ }))?.text).toBe('Explore')
  await clock.advance(11 * 60_000)
  expect(await ui.find({ type: 'Text', text: /^Explore$/ })).toBeUndefined()
  await ui.unmount()
})

test('a run shows its model, effort, context fill and tokens spent, and keeps them once it ends', async ($, on) => {
  const live: Live = { ...RELEASE }
  const clock = engine(on, { 'release-notes.md': NOTES }, [live])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Before a run: what the file asks for.
  expect((await ui.find({ type: 'Text', text: /^haiku$/ }))?.text).toBe('haiku')
  expect(await ui.find({ type: 'Text', text: /kontekst/ })).toBeUndefined()

  await ui.press({ key: 'run-release-notes' })
  const model = 'claude-haiku-4-5-20251001'
  stepUsage = { model, input_tokens: 400, output_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 600 }
  // The main loop's step passes through as it came.
  expect(await step($)).toMatchObject({ stopReason: 'end_turn' })
  expect(await step($, 'a1')).toMatchObject({ stopReason: 'end_turn' })
  Object.assign(live, {
    model,
    effort: 'high',
    contextWindowSize: 200_000,
    // The request went out at a lower level than the call asked for.
    lastRequest: { at: 1, model, effort: 'low' },
    usage: [{ model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2000 }],
  })
  await clock.advance(1000)

  expect((await ui.find({ type: 'Text', text: /^haiku 4\.5$/ }))?.text).toBe('haiku 4.5')
  expect((await ui.find({ type: 'Text', text: /^· / }))?.text).toBe('· low')
  expect((await ui.find({ type: 'Text', text: /^kontekst/ }))?.text).toBe('kontekst 42k z 200k')
  expect((await ui.find({ type: 'Text', text: /^\d+%$/ }))?.text).toBe('21%')
  expect((await ui.find({ type: 'Text', text: /zużyto/ }))?.text).toBe('· zużyto 34k')

  // Ended and gone from the engine's list, the row keeps what it last read.
  await $.turn.complete({ answer: 'notes', durationMs: 1, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer' })
  live.status = 'completed'
  await clock.advance(1000)
  live.id = 'gone'
  await clock.advance(1000)
  expect((await ui.find({ type: 'Text', text: /^kontekst/ }))?.text).toBe('kontekst 42k z 200k')
  expect((await ui.find({ type: 'Text', text: /zużyto/ }))?.text).toBe('· zużyto 34k')
  stepUsage = null
  await ui.unmount()
})

test('an agent of another type shows the same figures in its own section', async ($, on) => {
  const model = 'claude-opus-5-5'
  const explore: Live = {
    id: 'x1',
    description: 'Szukam wywołań API',
    type: 'Explore',
    status: 'running',
    model,
    contextWindowSize: 1_000_000,
    lastRequest: { at: 1, model, effort: 'xhigh' },
    usage: [{ model, input_tokens: 2000, output_tokens: 3000, cache_read_input_tokens: 800_000, cache_creation_input_tokens: 5000 }],
  }
  const clock = engine(on, { 'release-notes.md': NOTES }, [explore])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  stepUsage = { model, input_tokens: 1000, output_tokens: 4000, cache_read_input_tokens: 600_000, cache_creation_input_tokens: 15_000 }
  // Its step lands before the panel has listed it: the next tick hands it over.
  await step($, 'x1')
  await clock.advance(1000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^opus 5\.5$/ }))?.text).toBe('opus 5.5')
  expect((await ui.find({ type: 'Text', text: /^· / }))?.text).toBe('· xhigh')
  expect((await ui.find({ type: 'Text', text: /^kontekst/ }))?.text).toBe('kontekst 620k z 1M')
  expect((await ui.find({ type: 'Text', text: /^\d+%$/ }))?.text).toBe('62%')
  expect((await ui.find({ type: 'Text', text: /zużyto/ }))?.text).toBe('· zużyto 810k')
  stepUsage = null
  await ui.unmount()
})

// A run measured at 42k of a 200k window, the bar's reading 0.21.
async function measuredRun($: { turn: { step: unknown } }, live: Live) {
  const model = 'claude-haiku-4-5-20251001'
  stepUsage = { model, input_tokens: 400, output_tokens: 1000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 600 }
  await step($, 'a1')
  stepUsage = null
  Object.assign(live, { model, contextWindowSize: 200_000, lastRequest: { at: 1, model, effort: 'low' } })
}

test('the context bar grows into a new reading frame by frame, then holds it', async ($, on) => {
  const live: Live = { ...RELEASE }
  const clock = engine(on, { 'release-notes.md': NOTES }, [live])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'run-release-notes' })
  expect(await ui.find({ key: 'fill-a1' })).toBeUndefined()

  await measuredRun($, live)
  // The tick that reads the window; the bar starts from empty on the frames after it.
  await clock.advance(1000)
  const fill = async () => (await ui.find({ key: 'fill-a1' }))?.props.flexGrow as number
  const seen: number[] = []
  for (let i = 0; i < 3; i++) {
    await clock.advance(80)
    seen.push(await fill())
  }
  expect(seen[0]).toBeGreaterThan(0)
  expect(seen[1]).toBeGreaterThan(seen[0]!)
  expect(seen[2]).toBeGreaterThan(seen[1]!)
  expect(seen[2]).toBeLessThan(2100)

  await clock.advance(2000)
  expect(await fill()).toBe(2100)
  expect((await ui.find({ key: 'rest-a1' }))?.props.flexGrow).toBe(7900)
  // The reading's colour, as the percentage beside it.
  expect((await ui.find({ key: 'fill-a1' }))?.props.backgroundColor).toBe('#5DB36A')
  await ui.unmount()
})

test('in a terminal the context bar is a run of line glyphs', async ($, on) => {
  const live: Live = { ...RELEASE }
  const clock = engine(on, { 'release-notes.md': NOTES }, [live])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'run-release-notes' })
  await measuredRun($, live)
  await clock.advance(3000)

  // 0.21 of 24 cells: 5 drawn, 19 left.
  expect((await ui.find({ type: 'Text', text: /^[━─]{24}$/ }))?.text).toBe(`${'━'.repeat(5)}${'─'.repeat(19)}`)
  expect(await ui.find({ key: 'fill-a1' })).toBeUndefined()
  await ui.unmount()
})

test('model and effort from an agent file reach the row without control characters', async ($, on) => {
  const hostile = `---
name: odd
model: "sonnet\u001b[2J\u0007"
effort: "${'x'.repeat(40)}\u001b]8;;http://e\u0007"
---
x`
  engine(on, { 'odd.md': hostile })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const model = (await ui.find({ type: 'Text', text: /^sonnet/ }))?.text ?? ''
  const effort = (await ui.find({ type: 'Text', text: /^· x/ }))?.text ?? ''
  expect(model).toBe('sonnet [2J')
  expect(effort).toBe(`· ${'x'.repeat(24)}`)
  expect(/[\u0000-\u001f\u007f-\u009f]/.test(model + effort)).toBe(false)
  await ui.unmount()
})

// Nothing that steers a terminal or flips text direction may reach a row.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

test('names, descriptions, colours and tool labels reach the row clean', async ($, on) => {
  const files = {
    // A name that steers the terminal: the file's own name stands in.
    'scout.md': `---\nname: "scout\u001b[31m"\ndescription: "Szuka\u001b]8;;http://e\u0007 \u202eesrever\u202c plików"\ncolor: "red\u001b[0m"\n---\nx`,
    // Neither the name nor the file's is one the engine would run: left out.
    '\u001b[2J.md': `---\nname: "\u001b[2J"\n---\nx`,
  }
  const live: Live = { id: 's1', description: 'Zadanie\u001b[1A\u0007 od modelu', type: 'scout', status: 'running' }
  const clock = engine(on, files, [live])
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^scout$/ }))?.text).toBe('scout')
  expect(await ui.find({ type: 'Text', text: /2J/ })).toBeUndefined()
  // The dot falls back to the palette, as for a file that names no colour.
  const dot = (await ui.findAll({ type: 'Text', text: /^●$/ }))[0]
  expect(dot?.props.color).toBe('#7C9CC8')
  // Before the agent's first tool call the row still shows the description.
  expect((await ui.find({ type: 'Text', text: /^Szuka/ }))?.text).toBe('Szuka ]8;;http://e esrever plików')

  await callTool($, { tool: 'WebFetch', url: 'https://jan:tajne@example.com/a?b=1', agentId: 's1' })
  expect((await ui.find({ type: 'Text', text: /⏵/ }))?.text).toBe('⏵ WebFetch · example.com')
  await callTool($, { tool: 'Bash\u001b[2J', command: 'rm\u001b[8m -rf', agentId: 's1' })
  expect((await ui.find({ type: 'Text', text: /⏵/ }))?.text).toBe('⏵ Bash [2J · rm')

  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  expect(UNSAFE.test(shown)).toBe(false)
  expect(shown).not.toMatch(/tajne/)
  await ui.unmount()
})

test('a session starts with the pane closed; /agents-panel opens it', async ($, on) => {
  engine(on, { 'release-notes.md': NOTES })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual([])

  const done = await $.command.run({ command: 'agents-panel', args: '' } as never)
  expect(done.text).toBe('Panel agentów otwarty.')
  expect(opened).toEqual(['agents-panel'])
})
