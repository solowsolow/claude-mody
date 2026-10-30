import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-29T15:00:00Z')
const MIN = 60_000
const DIR = '/home/u/.claude/collision-guard'
const FILE = '/proj/src/app.ts'

type Trace = { session: string; project: string; beat: number; edits: Record<string, number> }

// A disk in memory, a clock, and the person's answer to the collision question.
function engine(on: On, traces: Trace[], answer?: string, env: Record<string, string> = { HOME: '/home/u' }) {
  const disk = new Map<string, string>(traces.map(t => [`${DIR}/${t.session}.json`, JSON.stringify(t)]))
  const asked: string[] = []
  const edited: string[] = []
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, env)
  on('session.id', () => ({ value: 'me-0000000' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'kolizje' } }))
  on('fs.exists', (_, e) => ({ value: [...disk.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.list', (_, e) => ({
    value: [...disk.keys()]
      .filter(k => k.startsWith(`${e.path}/`))
      .map(k => ({ name: k.slice(e.path!.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
  }) as never)
  on('fs.read', (_, e) => ({ value: disk.get(e.path) ?? '' }) as never)
  on('fs.write', (_, e) => (disk.set(e.path, e.text), { value: undefined }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false, realPath: e.path } }) as never)
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      asked.push(q)
      if (answer === undefined) throw new Error('dismissed')
      return { result: { questions: (e as unknown as { questions: unknown[] }).questions, answers: { [q]: answer } } } as never
    }
    edited.push(String((e as unknown as { file_path: string }).file_path))
    return { result: {} } as never
  })
  const mine = () => JSON.parse(disk.get(`${DIR}/me-0000000.json`) ?? '{}') as Trace
  return { clock, asked, edited, mine }
}

const other = (beatAgo: number, editAgo: number): Trace => ({
  session: 'other-1234567',
  project: '/proj',
  beat: T0 - beatAgo * MIN,
  edits: { [FILE]: T0 - editAgo * MIN },
})

const edit = { tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never

test('with no other session the edit goes through and is published', async ($, on) => {
  const { asked, edited, mine } = engine(on, [])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const done = await $.tool.call(edit)
  expect(done.deny).toBeUndefined()
  expect(asked).toEqual([])
  expect(edited).toEqual([FILE])
  expect(mine().edits[FILE]).toBe(T0)
})

test('a live session that edited the file 5 min ago is asked about, and "edit anyway" holds', async ($, on) => {
  const { asked, edited } = engine(on, [other(0, 5)], 'Edytuj mimo to')
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  expect((await $.tool.call(edit)).deny).toBeUndefined()
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatch(/app\.ts.*sesja other-12 w projekcie proj, 5 min temu/)
  // The person's yes covers this file for the rest of the session.
  expect((await $.tool.call(edit)).deny).toBeUndefined()
  expect(asked).toHaveLength(1)
  expect(edited).toEqual([FILE, FILE])
})

test('choosing a worktree stops the edit and tells the model to enter one', async ($, on) => {
  const { edited } = engine(on, [other(0, 5)], 'Przenieś do worktree')
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const done = await $.tool.call(edit)
  expect(done.deny).toMatch(/EnterWorktree/)
  expect(edited).toEqual([])
})

for (const [answer, name] of [['Anuluj', 'cancelling'], [undefined, 'dismissing the question']] as const) {
  test(`${name} stops the edit`, async ($, on) => {
    const { edited } = engine(on, [other(0, 5)], answer)
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    const done = await $.tool.call(edit)
    expect(done.deny).toMatch(/anulowana/)
    expect(edited).toEqual([])
  })
}

for (const [trace, name] of [[other(10, 5), 'a session gone quiet 10 min'], [other(0, 40), 'an edit 40 min ago']] as const) {
  test(`${name} is no collision`, async ($, on) => {
    const { asked, edited } = engine(on, [trace], 'Anuluj')
    await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
    expect((await $.tool.call(edit)).deny).toBeUndefined()
    expect(asked).toEqual([])
    expect(edited).toEqual([FILE])
  })
}

test('/kolizje lists what other live sessions edited', async ($, on) => {
  engine(on, [other(0, 5), { ...other(10, 5), session: 'gone-0000000' }])
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const shown = await $.command.run({ command: 'kolizje', args: '' } as never)
  expect(shown.text).toMatch(/\/proj\/src\/app\.ts \(sesja other-12 w projekcie proj, 5 min temu\)/)
  expect(shown.text).not.toMatch(/gone-000/)
})

test('on Windows the trace goes under USERPROFILE, where HOME is not set', async ($, on) => {
  const { mine } = engine(on, [], undefined, { USERPROFILE: '/home/u' })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(mine().session).toBe('me-0000000')
})
