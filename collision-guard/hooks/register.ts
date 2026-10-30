import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { SessionTrace } from '../types'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const mine = atom({ plugin: 'collision-guard', key: 'mine' } as const, {}, { shape: 'mine-1' })
const allowed = atom({ plugin: 'collision-guard', key: 'allowed' } as const, [], { shape: 'allowed-1' })

const MINUTE = 60_000
// A session counts as active while its heartbeat is younger than this; the
// beat itself is written every minute, so three misses mean it is gone.
const BEAT_MS = MINUTE
const ALIVE_MS = 3 * MINUTE

// The tools that change a file, and where each keeps the file's path.
const EDIT_TOOLS: Record<string, 'file_path' | 'notebook_path'> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

const ALLOW = 'Edytuj mimo to'
const WORKTREE = 'Przenieś do worktree'
const CANCEL = 'Anuluj'

// ---------------------------------------------------------------- traces

// Every session writes only its own file, so two sessions never race on one.
// HOME on macOS and Linux, USERPROFILE on Windows.
async function traceDir($: Engine): Promise<string> {
  return `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''}/.claude/collision-guard`
}

async function publish($: Engine, windowMs: number): Promise<void> {
  const at = await $.clock.now()
  const session = await $.session.id()
  // Edits past the window can no longer collide; they are left out.
  const edits = Object.fromEntries(Object.entries(await read($, mine)).filter(([, t]) => at - t < windowMs))
  const trace: SessionTrace = { session, project: await $.session.root(), beat: at, edits }
  await $.fs.write(`${await traceDir($)}/${session}.json`, JSON.stringify(trace))
}

async function others($: Engine): Promise<SessionTrace[]> {
  const dir = await traceDir($)
  if (!(await $.fs.exists(dir))) return []
  const self = await $.session.id()
  const found: SessionTrace[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${self}.json`) continue
    try {
      found.push(JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as SessionTrace)
    } catch {
      // A file caught mid-write, or not ours: the next edit reads it again.
    }
  }
  return found
}

// The same file reached by two spellings (a link, `..`) is one file.
async function canonical($: Engine, path: string): Promise<string> {
  const absolute = path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
  try {
    return (await $.fs.stat(absolute, { resolve: true })).realPath ?? absolute
  } catch {
    // A file Write is about to create has nothing to resolve yet.
    return absolute
  }
}

type Collision = { trace: SessionTrace; minutes: number }

async function collisions($: Engine, path: string, windowMs: number): Promise<Collision[]> {
  const at = await $.clock.now()
  return (await others($))
    .filter(t => at - t.beat < ALIVE_MS)
    .flatMap(t => {
      const when = t.edits[path]
      return when !== undefined && at - when < windowMs ? [{ trace: t, minutes: Math.max(1, Math.round((at - when) / MINUTE)) }] : []
    })
    .sort((a, b) => a.minutes - b.minutes)
}

// ---------------------------------------------------------------- words

function base(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function who(c: Collision): string {
  return `sesja ${c.trace.session.slice(0, 8)} w projekcie ${base(c.trace.project)}, ${c.minutes} min temu`
}

// ---------------------------------------------------------------- module

export const register: Register = (on, options) => {
  const windowMs = Number(options.windowMinutes ?? '30') * MINUTE

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kolizje',
      description: 'Pokaż pliki, które w ostatnim czasie edytowały inne aktywne sesje Claude',
    })
    await publish($, windowMs)
    $.clock.every(BEAT_MS, () => void publish($, windowMs))

    return next(e)
  })

  on('command.run', { command: 'kolizje' }, async $ => {
    const at = await $.clock.now()
    const lines = (await others($))
      .filter(t => at - t.beat < ALIVE_MS)
      .flatMap(t =>
        Object.entries(t.edits)
          .filter(([, when]) => at - when < windowMs)
          .map(([path, when]) => ({ path, line: `${path} (${who({ trace: t, minutes: Math.max(1, Math.round((at - when) / MINUTE)) })})` })),
      )
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(x => `- ${x.line}`)

    return {
      text: lines.length === 0
        ? `Żadna inna aktywna sesja nie edytowała plików w ostatnich ${windowMs / MINUTE} min.`
        : `Pliki edytowane przez inne aktywne sesje (ostatnie ${windowMs / MINUTE} min):\n${lines.join('\n')}`,
    }
  })

  on('tool.call', async ($, e, next) => {
    const field = EDIT_TOOLS[e.tool]
    const raw = field ? (e as Record<string, unknown>)[field] : undefined
    if (typeof raw !== 'string') return next(e)

    const path = await canonical($, raw)
    if (!(await read($, allowed)).includes(path)) {
      const found = await collisions($, path, windowMs)
      if (found.length > 0) {
        const first = found[0]!
        const more = found.length > 1 ? ` (i ${found.length - 1} inna)` : ''
        let answer: string
        try {
          answer = await $.ui.ask(
            `Plik ${base(path)} zmieniała niedawno inna sesja Claude: ${who(first)}${more}. Co zrobić z tą edycją?`,
            { header: 'Kolizja', options: [ALLOW, WORKTREE, CANCEL] },
          )
        } catch {
          // Dismissed, or nobody to ask (a -p run): an overwrite is the costly
          // mistake, so the edit does not go ahead unseen.
          answer = CANCEL
        }

        if (answer === WORKTREE) {
          return {
            deny:
              `Edycja wstrzymana przez collision-guard: ${path} zmieniała niedawno inna aktywna sesja (${who(first)}). ` +
              'Użytkownik wybrał pracę w osobnym git worktree: wywołaj narzędzie EnterWorktree, a potem powtórz tę zmianę w worktree.',
          }
        }
        if (answer !== ALLOW) {
          return {
            deny:
              `Edycja anulowana przez użytkownika (collision-guard): ${path} zmieniała niedawno inna aktywna sesja (${who(first)}). ` +
              'Nie zmieniaj tego pliku bez nowego polecenia użytkownika.',
          }
        }
        await update($, allowed, list => [...list, path])
      }
    }

    const done = await next(e)
    if (done.deny === undefined && done.isError !== true) {
      const at = await $.clock.now()
      await update($, mine, edits => ({ ...edits, [path]: at }))
      await publish($, windowMs)
    }

    return done
  })
}
