import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { AgentDef, AgentRun, AgentScope } from '../types'

const PANE = 'agents-panel'
const TITLE = 'Agenci'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const defs = atom({ plugin: 'agents-panel', key: 'defs' } as const, [], { shape: 'defs-2' })
const runs = atom({ plugin: 'agents-panel', key: 'runs' } as const, [], { shape: 'runs-2' })
const now = atom({ plugin: 'agents-panel', key: 'now' } as const, 0)
const frame = atom({ plugin: 'agents-panel', key: 'frame' } as const, 0)
const fills = atom({ plugin: 'agents-panel', key: 'fills' } as const, {})

const TICK_MS = 1000
// Definitions are re-read every Nth tick, and only when a file changed.
const DEFS_EVERY = 3

// Agent files name a color word; these are mid-tones that read on dark and light.
const DOTS: Record<string, string> = {
  blue: '#7C9CC8',
  cyan: '#6FB3C4',
  green: '#7FB58A',
  yellow: '#E2C27A',
  orange: '#D98C69',
  red: '#DD6670',
  purple: '#A88BC9',
  pink: '#C990B4',
}
const DOT_ORDER = Object.values(DOTS)
const ACCENT = '#8EA4E8'

// ---------------------------------------------------------------- run prompt

// A deliberately general task: what to do comes from the agent's own system prompt.
function buildRunPrompt(def: AgentDef): string {
  return `Wykonaj swoje zadanie (${def.name}) na bieżącym stanie tego projektu i zwróć zwięzły raport.`
}

// ---------------------------------------------------------------- definitions

function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const out: Record<string, string> = {}
  let key: string | undefined
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field?.[1] !== undefined) {
      key = field[1]
      const value = (field[2] ?? '').trim()
      // `|` and `>` open a block; its indented lines follow.
      out[key] = value === '|' || value === '>' ? '' : value.replace(/^(['"])(.*)\1$/, '$2')
    } else if (key && /^\s+\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim()
    }
  }
  return out
}

// A short frontmatter field (model, effort) as the row may draw it: anyone who
// can write the project's agent files writes it, so no control characters
// reach a terminal and no length pushes the row apart.
function tidyField(raw: string | undefined): string | undefined {
  const clean = raw?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24)
  return clean || undefined
}

function tidyDescription(raw: string): string {
  return raw
    .replace(/\\n/g, ' ')
    .replace(/<example>[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

type Source = { scope: AgentScope; dir: string }

async function sources($: Engine): Promise<Source[]> {
  const root = await $.session.root()
  const home = await $.env.get('HOME')
  const list: Source[] = [{ scope: 'project', dir: `${root}/.claude/agents` }]
  if (home && `${home}/.claude/agents` !== `${root}/.claude/agents`) {
    list.push({ scope: 'user', dir: `${home}/.claude/agents` })
  }
  return list
}

let lastSignature = ''

async function refreshDefs($: Engine): Promise<void> {
  const files: { scope: AgentScope; path: string; stem: string; stamp: string }[] = []
  for (const source of await sources($)) {
    if (!(await $.fs.exists(source.dir))) continue
    for (const entry of await $.fs.list(source.dir)) {
      if (!entry.name.endsWith('.md') || entry.kind === 'dir') continue
      files.push({
        scope: source.scope,
        path: `${source.dir}/${entry.name}`,
        stem: entry.name.replace(/\.md$/, ''),
        stamp: `${entry.mtimeMs}:${entry.size}`,
      })
    }
  }
  const signature = files.map(f => `${f.path}@${f.stamp}`).join('|')
  if (signature === lastSignature) return
  lastSignature = signature

  const found: AgentDef[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const meta = parseFrontmatter(await $.fs.read(file.path))
    const name = meta.name || file.stem
    // A project agent shadows a user agent of the same name, as Claude Code does.
    if (seen.has(name)) continue
    seen.add(name)
    found.push({
      name,
      model: tidyField(meta.model) ?? 'inherit',
      description: tidyDescription(meta.description ?? ''),
      effort: tidyField(meta.effort),
      color: meta.color,
      scope: file.scope,
      path: file.path,
    })
  }
  found.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1))
  await update($, defs, () => found)
}

// ---------------------------------------------------------------- runs

async function addRun($: Engine, agentId: string, type: string, description?: string): Promise<void> {
  const startedAt = await $.clock.now()
  await update($, runs, list =>
    list.some(r => r.agentId === agentId)
      ? list.map(r => (r.agentId === agentId ? { ...r, type: r.type || type, description: r.description || description } : r))
      : [...list, { agentId, type, description, startedAt, state: 'running' as const }].slice(-100),
  )
  await update($, now, () => startedAt)
  spin($, true)
}

const LIVE_STATUSES = new Set(['pending', 'running', 'waiting'])

// Takes in every live agent the panel has not seen start: the spawn hook misses
// the panel's own spawns (a plugin's hook skips its own call) and anything
// started before a reload.
async function adopt($: Engine, agents?: AgentInfo[]): Promise<void> {
  const live = agents ?? (await $.agent.list())
  const known = new Set((await read($, runs)).map(r => r.agentId))
  for (const agent of live) {
    if (!known.has(agent.id) && LIVE_STATUSES.has(agent.status)) await addRun($, agent.id, agent.type, agent.description)
  }
}

async function endRun($: Engine, agentId: string, state: 'done' | 'failed'): Promise<AgentRun | undefined> {
  const endedAt = await $.clock.now()
  let ended: AgentRun | undefined
  await update($, runs, list =>
    list.map(r => {
      if (r.agentId !== agentId || r.state !== 'running') return r
      ended = { ...r, state, endedAt }
      return ended
    }),
  )
  return ended
}

// ---------------------------------------------------------------- measures

// The context each agent's last request left, by its id: a step can land
// before its run is listed, and the next tick hands it over.
const contextOf = new Map<string, number>()

type Measures = Pick<AgentRun, 'model' | 'effort' | 'context' | 'window' | 'tokens'>

function measuresOf(agent: AgentInfo): Measures {
  const usage = agent.usage ?? []
  const spent = usage.reduce(
    (n, u) => n + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
    0,
  )
  return {
    // What went out beats what was asked: a model caps effort, a fallback swaps the model.
    model: agent.lastRequest?.model ?? agent.model,
    effort: agent.lastRequest ? agent.lastRequest.effort : agent.effort,
    context: contextOf.get(agent.id),
    window: agent.contextWindowSize,
    tokens: usage.length > 0 ? spent : undefined,
  }
}

// Copies each listed agent's measures onto its run; a run whose agent left the
// list keeps the last ones. Writes only when something moved.
async function measure($: Engine, agents: AgentInfo[]): Promise<void> {
  const byId = new Map(agents.map(a => [a.id, a]))
  const list = await read($, runs)
  const fresh = new Map<string, Measures>()
  for (const run of list) {
    const agent = byId.get(run.agentId)
    if (!agent) continue
    const m = measuresOf(agent)
    const next = { ...m, context: m.context ?? run.context, model: m.model ?? run.model }
    if (
      next.model !== run.model ||
      next.effort !== run.effort ||
      next.context !== run.context ||
      next.window !== run.window ||
      next.tokens !== run.tokens
    ) {
      fresh.set(run.agentId, next)
    }
  }
  if (fresh.size === 0) return
  await update($, runs, all => all.map(r => (fresh.has(r.agentId) ? { ...r, ...fresh.get(r.agentId) } : r)))
}

async function tick($: Engine, count: number): Promise<void> {
  if (count % DEFS_EVERY === 0) await refreshDefs($)
  const agents = await $.agent.list()
  await adopt($, agents)
  // Before the idle return: an agent that just ended still has its last figures to hand over.
  await measure($, agents)
  const active = (await read($, runs)).filter(r => r.state === 'running')
  if (active.length === 0) {
    spin($, false)
    // No frames run now: a bar stopped mid-way settles where it is going.
    await ease($, true)
    // Idle, the clock still moves now and then, so ended runs age out of view
    // without the pane redrawing every second.
    if (count % IDLE_TICKS === 0) {
      const idleAt = await $.clock.now()
      await update($, now, () => idleAt)
    }
    return
  }

  // The engine's list is the authority on agents whose turn.complete we missed.
  const live = new Map(agents.map(a => [a.id, a.status]))
  for (const run of active) {
    const status = live.get(run.agentId)
    if (status === undefined || status === 'completed') await endRun($, run.agentId, 'done')
    else if (status === 'failed' || status === 'killed') await endRun($, run.agentId, 'failed')
  }
  spin($, (await read($, runs)).some(r => r.state === 'running'))
  const stamp = await $.clock.now()
  await update($, now, () => stamp)
}

// What an agent is doing now, in a few words: the tool, and the one argument
// that tells its calls apart (a file's name, a command's first word, a host).
function toolLabel(e: { tool: string } & Record<string, unknown>): string {
  const name = e.tool.startsWith('mcp__') ? e.tool.split('__').pop() ?? e.tool : e.tool
  const text = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : undefined)
  const path = text('file_path') ?? text('notebook_path') ?? text('path')
  const url = text('url')
  const detail =
    (path && path.split('/').filter(Boolean).pop()) ??
    text('command')?.trim().split(/\s+/)[0] ??
    text('pattern') ??
    (url && url.replace(/^https?:\/\/([^/]+).*$/, '$1')) ??
    text('query') ??
    text('description')
  const short = detail && detail.length > 28 ? `${detail.slice(0, 27)}…` : detail
  return short ? `${name} · ${short}` : name
}

// Runs whose agent type has no file in .claude/agents stay listed this long
// after they end, so a burst of parallel agents can be read back.
const OTHERS_KEEP_MS = 10 * 60_000
const OTHERS_SHOWN = 8
const IDLE_TICKS = 30

// ---------------------------------------------------------------- drawing helpers

function dotColor(def: AgentDef, index: number): string {
  return (def.color && DOTS[def.color.toLowerCase()]) || def.color || DOT_ORDER[index % DOT_ORDER.length] || ACCENT
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// A model id as a person says it: `claude-haiku-4-5-20251001` is `haiku 4.5`.
// An id of another shape stays as it is, cleaned like a frontmatter field.
// `[1m]` is how Claude Code marks a model run with its 1M window.
function modelName(id: string): string {
  const name = id
    .replace(/^claude-/, '')
    .replace(/\[1m\]$/i, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
  return tidyField(name) ?? '?'
}

// An effort level as written; a budget in tokens.
function effortName(effort: string | number): string {
  return typeof effort === 'number' ? tokens(effort) : (tidyField(effort) ?? '?')
}

function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// The fill colours of context-bar's pill, so the two read the same: amber
// from half the window, red from four fifths.
const LEVEL = ['#5DB36A', '#D9A441', '#DD6670']
const levelOf = (share: number) => LEVEL[share >= 0.8 ? 2 : share >= 0.5 ? 1 : 0]

// The context bar: on a desktop a hairline a fifth of a cell tall (about
// 4 px) on a grey that reads on dark and light; in a terminal, where a cell
// is the least a Box can be, a run of line glyphs as wide as this.
const GAUGE_HEIGHT = 0.2
const GAUGE_TRACK = 'rgba(127,127,127,0.22)'
const GAUGE_CELLS = 24

// A text spinner: every surface paints text, which an Svg in the pane is not
// guaranteed to be.
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPIN_MS = 80

// The share of its window a run's measured context fills, capped at whole.
function shareOf(run: AgentRun): number | undefined {
  return run.context !== undefined && run.window ? Math.min(1, run.context / run.window) : undefined
}

// Each frame a bar closes this much of what is left to its reading: quick at
// first, settling softly: an empty bar reaches a fifth of the window in
// about 0.9 s (11 frames), the whole window in about 1.2 s.
const EASE = 0.35
const SETTLED = 0.002

// Moves every bar toward its run's share; `snap` puts it there at once, for
// an idle pane with no frames to move on. Writes only when a bar moved.
async function ease($: Engine, snap: boolean): Promise<void> {
  const shown = await read($, fills)
  const next: Record<string, number> = {}
  let moved = false
  for (const run of await read($, runs)) {
    const target = shareOf(run)
    if (target === undefined) continue
    // A bar that appears while its agent works grows in from empty.
    const from = shown[run.agentId] ?? (snap ? target : 0)
    const to = snap || Math.abs(target - from) < SETTLED ? target : from + (target - from) * EASE
    next[run.agentId] = to
    if (to !== shown[run.agentId]) moved = true
  }
  if (moved || Object.keys(shown).length !== Object.keys(next).length) await update($, fills, () => next)
}

// The frame timer runs only while an agent does, so an idle pane never redraws.
let spinning: Timer | undefined

function spin($: Engine, isActive: boolean): void {
  if (isActive && !spinning) {
    spinning = $.clock.every(SPIN_MS, () => {
      void update($, frame, f => (f + 1) % FRAMES.length)
      void ease($, false).catch(() => {})
    })
  } else if (!isActive && spinning) {
    spinning.cancel()
    spinning = undefined
  }
}

// ---------------------------------------------------------------- module

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-panel',
      description: 'Pokaż panel agentów projektu z przyciskami Run',
    })
    await refreshDefs($)
    let count = 0
    $.clock.every(TICK_MS, () => void tick($, ++count))
    // The pane opens on /agents-panel only. Runs are tracked from the start
    // all the same, so a pane opened later shows what ran before it.

    return next(e)
  })

  on('command.run', { command: 'agents-panel' }, async $ => {
    lastSignature = ''
    await refreshDefs($)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Panel agentów otwarty.' }
  })

  // Every spawn passes here, the model's and the panel's alike, so a row lights
  // up whoever started its agent.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    // A plugin's own spawn reaches here shaped as the Agent tool's call.
    const type = e.subagentType || (e as { subagent_type?: string }).subagent_type
    // The panel only watches: a failure here must never cost the spawn.
    if (started.agentId && !e.resume && type) await addRun($, started.agentId, type, e.description).catch(() => {})

    return started
  })

  // A subagent's tool calls carry its loop's id: the row shows the latest.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      try {
        const id = e.agentId
        if ((await read($, runs)).some(r => r.agentId === id && r.state === 'running')) {
          const tool = toolLabel(e as { tool: string } & Record<string, unknown>)
          await update($, runs, list => list.map(r => (r.agentId === id && r.state === 'running' ? { ...r, tool } : r)))
        }
      } catch {
        // The panel only watches: its failure must never cost the call.
      }
    }

    return next(e)
  })

  // A subagent's request says how full its window is: what it sent and what
  // came back is what the next one starts from. The main loop's pass untouched.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const id = e.agentId
    const answered = yield* next(e)
    const u = answered.usage
    if (u) {
      const context = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens
      contextOf.set(id, context)
      try {
        if ((await read($, runs)).some(r => r.agentId === id)) {
          await update($, runs, list => list.map(r => (r.agentId === id ? { ...r, context } : r)))
        }
      } catch {
        // The panel only watches: its failure must never cost the response.
      }
    }

    return answered
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const ended = await endRun($, e.agentId, e.reason === 'answer' ? 'done' : 'failed')
      if (ended) {
        const took = elapsed((ended.endedAt ?? ended.startedAt) - ended.startedAt)
        $.ui.toast(ended.state === 'done' ? `${ended.type}: gotowe (${took})` : `${ended.type}: przerwany (${took})`)
      }
      spin($, (await read($, runs)).some(r => r.state === 'running'))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, defs)
    const history = await read($, runs)
    const at = await read($, now)
    const step = await read($, frame)
    const shown = await read($, fills)
    const isTerminal = e.surface === 'terminal'
    const tint = isTerminal ? undefined : 'rgba(127,127,127,0.10)'

    const latest = new Map<string, AgentRun>()
    for (const run of history) latest.set(run.type, run)
    const running = history.filter(r => r.state === 'running').length

    const spinner = () => <Text color={ACCENT}>{FRAMES[step % FRAMES.length]}</Text>

    const run = async (def: AgentDef) => {
      const answer = await $.agent.spawn({
        subagentType: def.name,
        description: `${def.name} · panel`,
        prompt: buildRunPrompt(def),
      })
      if (answer.deny !== undefined) {
        $.ui.toast(`${def.name}: ${answer.deny}`)
        return
      }
      if (answer.agentId) await addRun($, answer.agentId, def.name)
      else await adopt($)
    }

    const view = async (agentId: string) => {
      const shown = await $.ui.view({ agentId })
      if ('deny' in shown && shown.deny) $.ui.toast(`Nie da się pokazać transkryptu: ${shown.deny}`)
    }

    // The run's state, pressable into its transcript.
    const chip = (key: string, last: AgentRun) => {
      const took = elapsed((last.endedAt ?? at) - last.startedAt)
      return last.state === 'running' ? (
        <Box flexDirection="row" alignItems="center" gap="xs">
          {spinner()}
          <Button key={key} plain onPress={() => view(last.agentId)}>
            <Text color={ACCENT} tabular>działa · {took}</Text>
          </Button>
        </Box>
      ) : (
        <Button key={key} plain onPress={() => view(last.agentId)}>
          <Text color={last.state === 'done' ? 'success' : 'error'} size="caption" tabular>
            {last.state === 'done' ? '✓' : '✕'} {took}
          </Text>
        </Button>
      )
    }

    // While an agent works its second line is what it is doing, not who it is.
    const doing = (last: AgentRun | undefined) =>
      last?.state === 'running' && last.tool ? (
        <Text color={ACCENT} dimColor wrap="truncate-end">⏵ {last.tool}</Text>
      ) : undefined

    // Beside the name: the model and effort a run went out on, else what the
    // file asks for. A level or budget the model takes none of is not shown.
    const engineOf = (model: string | undefined, effort: string | number | undefined) => [
      model !== undefined && <Text key="model" dimColor wrap="truncate-end">{model}</Text>,
      effort !== undefined && <Text key="effort" dimColor wrap="truncate-end">· {effortName(effort)}</Text>,
    ]

    // Under it, from the first measured request: how full the window is, in
    // context-bar's colours, and every token the run went through.
    const figures = (last: AgentRun | undefined) => {
      if (!last || (last.context === undefined && last.tokens === undefined)) return undefined
      const { context, window, tokens: spent } = last
      const share = context !== undefined && window ? context / window : undefined
      return (
        <Box flexDirection="row" gap="xs">
          {context !== undefined && (
            <Text dimColor size="caption" tabular>
              kontekst {tokens(context)}{window ? ` z ${tokens(window)}` : ''}
            </Text>
          )}
          {share !== undefined && (
            <Text color={levelOf(share)} size="caption" tabular>
              {Math.round(share * 100)}%
            </Text>
          )}
          {spent !== undefined && (
            <Text dimColor size="caption" tabular>
              {context !== undefined ? '· ' : ''}zużyto {tokens(spent)}
            </Text>
          )}
        </Box>
      )
    }

    // Under the figures, the same fill as a bar. Its colour follows the
    // reading, its length the eased share, so it grows into a new reading.
    const gauge = (last: AgentRun | undefined) => {
      const target = last && shareOf(last)
      if (!last || target === undefined) return undefined
      const share = shown[last.agentId] ?? target
      const color = levelOf(target)
      if (isTerminal) {
        const lit = Math.round(share * GAUGE_CELLS)
        return (
          <Text key={`gauge-${last.agentId}`}>
            <Text color={color}>{'━'.repeat(lit)}</Text>
            <Text dimColor>{'─'.repeat(GAUGE_CELLS - lit)}</Text>
          </Text>
        )
      }
      // Flex weights in basis points of the window: the engine caps a weight at 10000.
      const filled = Math.round(share * 10_000)
      return (
        <Box
          key={`gauge-${last.agentId}`}
          flexDirection="row"
          width="100%"
          height={GAUGE_HEIGHT}
          marginTop="xs"
          backgroundColor={GAUGE_TRACK}
          overflow="hidden"
        >
          <Box key={`fill-${last.agentId}`} width={0} flexGrow={filled} height={GAUGE_HEIGHT} backgroundColor={color} />
          <Box key={`rest-${last.agentId}`} width={0} flexGrow={10_000 - filled} height={GAUGE_HEIGHT} />
        </Box>
      )
    }

    const row = (def: AgentDef, index: number) => {
      const last = latest.get(def.name)
      const isActive = last?.state === 'running'
      const status = last ? chip(`log-${def.name}`, last) : null
      const isMeasured = last?.model !== undefined

      return (
        <Box
          key={`row-${def.name}`}
          flexDirection="row"
          gap="sm"
          alignItems="flex-start"
          paddingX="sm"
          paddingY="xs"
          backgroundColor={isActive ? tint : undefined}
          hover={tint ? { backgroundColor: tint } : undefined}
        >
          <Text color={dotColor(def, index)}>●</Text>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
              <Box flexDirection="row" gap="sm" flexShrink={1}>
                <Text weight="semibold" wrap="truncate-end">{def.name}</Text>
                {isMeasured
                  ? engineOf(modelName(last.model!), last.effort)
                  : engineOf(def.model, def.effort)}
              </Box>
              <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
                {status}
                {!isActive && (
                  <Button
                    key={`run-${def.name}`}
                    label="▶ uruchom"
                    hotkey={index < 9 ? String(index + 1) : undefined}
                    onPress={() => run(def)}
                  />
                )}
              </Box>
            </Box>
            {doing(last) ??
              (def.description !== '' && <Text dimColor wrap="truncate-end">{def.description}</Text>)}
            {figures(last)}
            {gauge(last)}
          </Box>
        </Box>
      )
    }

    // Agents the model spawns from types with no file here (Explore,
    // general-purpose, a plugin's): live ones first, then the recently ended.
    const known = new Set(list.map(d => d.name))
    const others = history
      .filter(r => r.type && !known.has(r.type))
      .filter(r => r.state === 'running' || at - (r.endedAt ?? r.startedAt) < OTHERS_KEEP_MS)
      .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt)
      .slice(0, OTHERS_SHOWN)

    const otherRow = (r: AgentRun) => (
      <Box
        key={`other-${r.agentId}`}
        flexDirection="row"
        gap="sm"
        alignItems="flex-start"
        paddingX="sm"
        paddingY="xs"
        backgroundColor={r.state === 'running' ? tint : undefined}
        hover={tint ? { backgroundColor: tint } : undefined}
      >
        <Text color={r.state === 'running' ? ACCENT : 'inactive'}>●</Text>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            <Box flexDirection="row" gap="sm" flexShrink={1}>
              <Text weight="semibold" wrap="truncate-end">{r.type}</Text>
              {r.model !== undefined && engineOf(modelName(r.model), r.effort)}
            </Box>
            <Box flexDirection="row" alignItems="center" flexShrink={0}>
              {chip(`log-${r.agentId}`, r)}
            </Box>
          </Box>
          {doing(r) ?? (r.description ? <Text dimColor wrap="truncate-end">{r.description}</Text> : undefined)}
          {figures(r)}
          {gauge(r)}
        </Box>
      </Box>
    )

    const othersSection =
      others.length === 0 ? null : (
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" gap="sm" paddingX="sm" paddingTop="sm">
            <Text color={ACCENT} size="caption" weight="semibold">INNE AGENTY</Text>
            <Text dimColor size="caption">uruchomione przez model · {others.length}</Text>
          </Box>
          {others.map(otherRow)}
        </Box>
      )

    const section = (scope: AgentScope, label: string, path: string) => {
      const members = list.filter(d => d.scope === scope)
      if (members.length === 0) return null
      return (
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" gap="sm" paddingX="sm" paddingTop="sm">
            <Text color={ACCENT} size="caption" weight="semibold">{label}</Text>
            <Text dimColor size="caption">{path} · {members.length}</Text>
          </Box>
          {members.map(def => row(def, list.indexOf(def)))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingX="sm">
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Text color="claude">◆</Text>
            <Text weight="semibold">Agenci</Text>
            <Text dimColor>w tym projekcie</Text>
          </Box>
          {running > 0 && (
            <Box flexDirection="row" gap="xs" alignItems="center">
              {spinner()}
              <Text dimColor tabular>{running} {running === 1 ? 'działa' : 'działają'}</Text>
            </Box>
          )}
        </Box>
        {list.length === 0 ? (
          <Box flexDirection="column" gap="xs" paddingX="sm" paddingTop="sm">
            <Text dimColor>Brak agentów w .claude/agents ani w ~/.claude/agents.</Text>
            <Text dimColor size="caption">
              Dodaj plik .md z frontmatterem name, description i model (albo poproś Claude o subagenta); panel podchwyci go sam.
            </Text>
          </Box>
        ) : (
          [section('project', 'PROJEKT', '.claude/agents'), section('user', 'UŻYTKOWNIK', '~/.claude/agents')]
        )}
        {othersSection}
      </Box>
    )
  })
}
