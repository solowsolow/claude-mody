import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { Mine, Peer, PeerState } from '../types'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
// A session starts with nothing to do: work begins with the first turn.
const mine = atom({ plugin: 'radar-sesji', key: 'mine' } as const, { state: 'spokój', since: 0 }, { shape: 'mine-1' })
const peers = atom({ plugin: 'radar-sesji', key: 'peers' } as const, [], { shape: 'peers-1' })
const dismissed = atom({ plugin: 'radar-sesji', key: 'dismissed' } as const, {}, { shape: 'dismissed-1' })
const now = atom({ plugin: 'radar-sesji', key: 'now' } as const, 0)
const glow = atom({ plugin: 'radar-sesji', key: 'glow' } as const, 8)

const MINUTE = 60_000
// Every session writes a beat each minute; three missed and it is gone.
const BEAT_MS = MINUTE
const ALIVE_MS = 3 * MINUTE
// How often the other sessions' traces are read.
const POLL_MS = 5_000
// A finished turn stays news for an hour in the band; the pane keeps it.
const FRESH_TURN_MS = 60 * MINUTE
// The band names at most this many waiting sessions; the rest are counted.
const NAMED = 3
const TOPIC_CHARS = 32

const PANE = 'radar-sesji'
const TITLE = 'Sesje'

const BLOCKING: readonly PeerState[] = ['zgoda', 'pytanie']
// The tools whose call is itself a question to the person.
const QUESTION_TOOLS: Record<string, string> = {
  AskUserQuestion: 'pytanie',
  ExitPlanMode: 'plan do akceptacji',
}
const STATE_WORDS: Record<PeerState, string> = {
  zgoda: 'czeka na zgodę',
  pytanie: 'pyta',
  tura: 'skończyła turę',
  praca: 'pracuje',
  spokój: 'bez zadania',
}

const AMBER = '#D9A441'
const GREY = '#8A8F98'
const BLUE = '#6F9FD8'
const DIM = '#5A6070'

// A newly waiting session lights the dot from grey to amber: 8 frames, 60 ms.
const GLOW_FRAMES = 8
const GLOW_MS = 60

// ---------------------------------------------------------------- traces

// Every session writes only its own file, so two sessions never race on one.
// HOME on macOS and Linux, USERPROFILE on Windows.
async function traceDir($: Engine): Promise<string> {
  return `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''}/.claude/radar-sesji`
}

async function publish($: Engine, ended = false): Promise<void> {
  const session = await $.session.id()
  const own = await read($, mine)
  const trace: Peer = {
    session,
    project: await $.session.root(),
    topic: own.topic,
    state: own.state,
    reason: own.reason,
    since: own.since,
    beat: await $.clock.now(),
    ...(ended ? { ended: true } : {}),
  }
  await $.fs.write(`${await traceDir($)}/${session}.json`, JSON.stringify(trace))
}

async function setState($: Engine, state: PeerState, reason?: string): Promise<void> {
  const at = await $.clock.now()
  const was = await read($, mine)
  if (was.state === state && was.reason === reason) return
  await update($, mine, m => ({ ...m, state, reason, since: at }))
  await publish($)
}

// The radar must never stand in the way of the work it reports on: a hook that
// gates a prompt or a tool call records the state and swallows any failure.
const ignore = (): void => undefined

let lastWaiting = new Set<string>()
let glowing: Timer | undefined

function lightUp($: Engine): void {
  glowing?.cancel()
  let frame = 0
  void update($, glow, () => 0)
  glowing = $.clock.every(GLOW_MS, () => {
    frame += 1
    void update($, glow, () => frame)
    if (frame >= GLOW_FRAMES) {
      glowing?.cancel()
      glowing = undefined
    }
  })
}

async function poll($: Engine): Promise<void> {
  const at = await $.clock.now()
  const dir = await traceDir($)
  const self = await $.session.id()
  const found: Peer[] = []
  if (await $.fs.exists(dir)) {
    for (const entry of await $.fs.list(dir)) {
      // A file untouched for longer than a session may stay silent is not read.
      if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${self}.json`) continue
      if (at - entry.mtimeMs > ALIVE_MS) continue
      try {
        const peer = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Peer
        if (!peer.ended && at - peer.beat < ALIVE_MS) found.push(peer)
      } catch {
        // Caught mid-write, or not ours: the next poll reads it again.
      }
    }
  }
  found.sort((a, b) => a.since - b.since)

  // Redraw only when what the band or the pane shows has changed: a state,
  // or a minute on someone's clock.
  const signature = (list: Peer[], when: number) =>
    JSON.stringify([list.map(p => [p.session, p.state, p.reason, p.since, p.topic]), Math.floor(when / MINUTE)])
  if (signature(found, at) !== signature(await read($, peers), await read($, now))) {
    await update($, peers, () => found)
    await update($, now, () => at)
  }

  const waiting = new Set(found.filter(p => BLOCKING.includes(p.state)).map(p => p.session))
  if ([...waiting].some(s => !lastWaiting.has(s))) lightUp($)
  lastWaiting = waiting
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

// ---------------------------------------------------------------- words

function base(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function topicOf(text: string): string | undefined {
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '')
  if (line === undefined) return undefined
  return line.length > TOPIC_CHARS ? `${line.slice(0, TOPIC_CHARS - 1).trimEnd()}…` : line
}

function nameOf(p: Peer): string {
  return p.topic ?? `sesja ${p.session.slice(0, 8)}`
}

function age(ms: number): string {
  const minutes = Math.floor(ms / MINUTE)
  if (minutes < 1) return 'teraz'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h`
}

// 1 sesja, 2–4 sesje (but 12–14 sesji), 5 sesji.
function sessions(n: number): string {
  if (n === 1) return 'sesja'
  const tens = n % 100
  return n % 10 >= 2 && n % 10 <= 4 && (tens < 12 || tens > 14) ? 'sesje' : 'sesji'
}

function waits(n: number): string {
  return sessions(n) === 'sesje' ? 'czekają' : 'czeka'
}

function mix(from: string, to: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const parts = [0, 1, 2].map(i => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * t))
  return `#${parts.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

// ---------------------------------------------------------------- module

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sesje',
      description: 'Pokaż inne sesje Claude na tym komputerze: które czekają na Ciebie, które pracują',
    })
    await publish($).catch(ignore)
    $.clock.every(BEAT_MS, () => void publish($).catch(ignore))
    $.clock.every(POLL_MS, () => void poll($).catch(ignore))
    await poll($).catch(ignore)

    return next(e)
  })

  // The trace says the session is gone, so no one waits a beat to drop it.
  on('session.end', async ($, e, next) => {
    try {
      await publish($, true)
    } catch {
      // Ending: a trace not written ages out on its own.
    }
    return next(e)
  })

  on('command.run', { command: 'sesje' }, async $ => {
    await poll($).catch(ignore)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panel sesji otwarty.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta) return next(e)
    if (!e.command && (await read($, mine).catch(() => undefined))?.topic === undefined) {
      const topic = topicOf(e.text)
      if (topic !== undefined) {
        await update($, mine, m => ({ ...m, topic })).catch(ignore)
        // Written now: the state below may be unchanged and write nothing.
        await publish($).catch(ignore)
      }
    }
    // A typed prompt sets the session to work; a command shows the person has
    // it in hand, and its own turn, if any, says work at turn.start.
    await setState($, e.command ? 'spokój' : 'praca').catch(ignore)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await setState($, 'praca').catch(ignore)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) await setState($, 'tura').catch(ignore)
    return done
  })

  // Raised as the permission prompt goes up, a subagent's included.
  on('classic.PermissionRequest', async ($, e, next) => {
    await setState($, 'zgoda', `zgoda na ${e.tool_name}`).catch(ignore)
    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    if ((await read($, mine)).state === 'zgoda') await setState($, 'praca').catch(ignore)
    return next(e)
  })

  on('classic.Elicitation', async ($, e, next) => {
    await setState($, 'pytanie', `formularz ${e.mcp_server_name}`).catch(ignore)
    return next(e)
  })

  on('classic.ElicitationResult', async ($, e, next) => {
    if ((await read($, mine)).state === 'pytanie') await setState($, 'praca').catch(ignore)
    return next(e)
  })

  // A question tool waits on the person for as long as it runs; any other
  // call that returns has been allowed, so a pending prompt is answered.
  on('tool.call', async ($, e, next) => {
    const name = (e as { tool?: string }).tool
    const question = name === undefined ? undefined : QUESTION_TOOLS[name]
    if (question !== undefined) await setState($, 'pytanie', question).catch(ignore)
    const done = await next(e)
    const state = (await read($, mine).catch(() => undefined))?.state
    if (state === 'zgoda' || (question !== undefined && state === 'pytanie')) await setState($, 'praca').catch(ignore)
    return done
  })

  // ---------------------------------------------------------------- band

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const cleared = await read($, dismissed)
    const list = (await read($, peers)).filter(p => cleared[p.session] !== p.since)
    const at = await read($, now)
    const waiting = list.filter(p => BLOCKING.includes(p.state))
    const finished = list.filter(p => p.state === 'tura' && at - p.since < FRESH_TURN_MS)
    if (e.props.hasSurvey || (waiting.length === 0 && finished.length === 0)) return below

    const { Box, Text, Button } = $.ui.resolve(e)

    // × clears what the line shows now; a session whose state changes after
    // has a new moment and comes back. Sessions gone from the list are let go.
    const clear = async () => {
      const shown = [...waiting, ...finished]
      const alive = new Set((await read($, peers)).map(p => p.session))
      await update($, dismissed, was => ({
        ...Object.fromEntries(Object.entries(was).filter(([s]) => alive.has(s))),
        ...Object.fromEntries(shown.map(p => [p.session, p.since])),
      }))
    }
    const isTerminal = e.surface === 'terminal'
    const fs = isTerminal ? undefined : ('footnote' as const)
    const t = (await read($, glow)) / GLOW_FRAMES
    const dot = waiting.length > 0 ? mix(GREY, AMBER, 1 - (1 - t) * (1 - t)) : GREY

    const named = waiting.slice(0, NAMED)
    const rest = waiting.length - named.length
    // Under pressure the topic gives way first: the headline and the reason
    // with its age never shrink, so a narrow window still says who waits on
    // what, and for how long.
    const parts = named.flatMap((p, i) => [
      ...(i > 0
        ? [
            <Box key={`sep-${p.session}`} flexShrink={0}>
              <Text dimColor size={fs}>{'  |  '}</Text>
            </Box>,
          ]
        : []),
      <Box key={`name-${p.session}`} flexShrink={1} minWidth={0}>
        <Text size={fs} wrap="truncate-end">{nameOf(p)}</Text>
      </Box>,
      <Box key={`why-${p.session}`} flexShrink={0}>
        <Text dimColor size={fs}>{` · ${p.reason ?? STATE_WORDS[p.state]} · ${age(at - p.since)}`}</Text>
      </Box>,
    ])

    // Short, so it fits beside a topic in a narrow window; the amber says
    // whom it waits on.
    const headline =
      waiting.length > 0
        ? `${waiting.length} ${sessions(waiting.length)} ${waits(waiting.length)}:  `
        : `${finished.length} ${sessions(finished.length)} po turze`
    // Right-aligned: the waiting sessions not named, then the finished turns.
    const trailer = [
      ...(rest > 0 ? [`+${rest} ${waits(rest)}`] : []),
      ...(waiting.length > 0 && finished.length > 0 ? [`+${finished.length} po turze`] : []),
    ].join(' · ')

    // The same insets as usage-bar's row, so the dots stand on one axis.
    const line = (
      <Box
        key="radar-line"
        flexDirection="row"
        flexWrap="nowrap"
        justifyContent="space-between"
        alignItems="center"
        gap="sm"
        paddingLeft={isTerminal ? 1 : 0.5}
        paddingTop={isTerminal ? 0 : 0.1}
      >
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={dot} size="caption">●</Text>
          <Box flexShrink={0}>
            <Text color={waiting.length > 0 ? AMBER : undefined} dimColor={waiting.length === 0} size={fs}>
              {` ${headline}`}
            </Text>
          </Box>
          {parts}
        </Box>
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap="sm" flexShrink={0}>
          {trailer !== '' && (
            <Text dimColor tabular size={fs}>
              {trailer}
            </Text>
          )}
          {/* plain: drawn as text, so the line stays a line's height (a plain
              ▼ beside the context title left its row as it was, measured). */}
          <Button key="radar-clear" plain dimColor onPress={clear}>
            <Text size={fs}>×</Text>
          </Button>
        </Box>
      </Box>
    )

    return below ? (
      <Box key="radar-band" flexDirection="column" gap={isEngineSlot(below) ? 0 : 'sm'}>
        {line}
        {below}
      </Box>
    ) : (
      line
    )
  })

  // ---------------------------------------------------------------- pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, peers)
    const at = await read($, now)

    const sections: Array<[string, PeerState[], string]> = [
      ['CZEKAJĄ NA CIEBIE', ['zgoda', 'pytanie'], AMBER],
      ['PO TURZE', ['tura'], GREY],
      ['PRACUJĄ', ['praca'], BLUE],
      ['BEZ ZADANIA', ['spokój'], DIM],
    ]

    // The dot has a column of its own and the two lines stand in the next, so
    // the details start under the topic, not under the dot: spaces would not
    // match a proportional font's "● ". The folder gives way before the
    // reason and its age.
    const row = (p: Peer, color: string) => (
      // flex-start: the dot sits on the topic's line, not midway down both.
      <Box key={`peer-${p.session}`} flexDirection="row" flexWrap="nowrap" alignItems="flex-start">
        <Box flexShrink={0}>
          <Text color={color}>● </Text>
        </Box>
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{nameOf(p)}</Text>
          <Box flexDirection="row" flexWrap="nowrap">
            <Box key={`where-${p.session}`} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{base(p.project)}</Text>
            </Box>
            <Box key={`what-${p.session}`} flexShrink={0}>
              <Text dimColor>{` · ${p.reason ?? STATE_WORDS[p.state]} · ${age(at - p.since)}`}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    )

    const filled = sections
      .map(([title, states, color]) => [title, list.filter(p => states.includes(p.state)), color] as const)
      .filter(([, members]) => members.length > 0)

    return (
      <Box flexDirection="column" gap="md" paddingX={1}>
        {filled.length === 0 ? (
          <Text dimColor>Żadna inna sesja Claude na tym komputerze nie jest teraz otwarta.</Text>
        ) : (
          filled.map(([title, members, color]) => (
            <Box key={`section-${title}`} flexDirection="column" gap="xs">
              <Text dimColor weight="semibold">{`${title} · ${members.length}`}</Text>
              {members.map(p => row(p, color))}
            </Box>
          ))
        )}
        <Text dimColor>Widzi sesje z tym modem na tym komputerze; odświeża co 5 s.</Text>
      </Box>
    )
  })
}
