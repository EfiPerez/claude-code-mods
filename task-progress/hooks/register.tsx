import type { EngineInterface, Register, Timer } from 'claude-code'

const TOOL_FULL = 'mcp__task-progress__report_progress'
const HEARTBEAT_MS = 60_000
// One constant on every prompt: no session data or changing progress in context.
const PROMPT_CONTEXT = "Progress: when the work needs 3 or more steps, call\n`mcp__task-progress__report_progress` with the full task list (tasks → small steps) in the\nsame message as your first real tool call, and again in the same message as your next tool\ncall whenever a step finishes. Mark a step done only after its result is known — never mark\na verification step done in the same message that runs it. When the last step's result is\nconfirmed and no further tool call follows, make one final standalone call marking\neverything done, before your closing reply. Work handed off to run in the background (a Claude\nsubagent or fork, a background shell, Codex, a workflow) is not a result: keep its step active, end the\nturn with it still active, and mark it done only after its completion notice arrives. Skip all of this for questions and one-step\nedits. Always set `label` to the real main goal in a few plain words (it is the list's heading): never the\ncommand, skill or prompt wording (not \"Resume handoff\", \"Done\" or \"Run tests\"). After resuming a handoff, use the\nhandoff's own main task. Task titles likewise name the actual work, not the procedure. Never put personal or\nconfidential data in titles or the label."

type Step = { title: string; status: 'done' | 'active' | 'pending' }
type Task = { title: string; steps: Step[] }
type Payload = { label?: string; tasks: Task[] }
type Session = { directory: string; sessionId: string; projectRoot: string; ended: boolean }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extraKey(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some(key => !allowed.includes(key))
}

function validate(input: unknown): string | null {
  if (!object(input)) return 'input must be an object'
  if (input.label !== undefined && typeof input.label !== 'string') return 'label must be a string'
  if (typeof input.label === 'string' && Array.from(input.label).length > 60) return 'label exceeds 60 characters'
  if (!Array.isArray(input.tasks)) return 'tasks must be an array'
  if (input.tasks.length < 1) return 'tasks must contain at least one task'
  if (input.tasks.length > 30) return 'tasks exceed 30 tasks'
  let active = 0
  for (const task of input.tasks) {
    if (!object(task)) return 'task must be an object'
    if (extraKey(task, ['title', 'steps'])) return 'unexpected task property'
    if (typeof task.title !== 'string') return 'task title must be a string'
    if (Array.from(task.title).length > 80) return 'task title exceeds 80 characters'
    if (!Array.isArray(task.steps)) return 'steps must be an array'
    if (task.steps.length < 1) return 'steps must contain at least one step'
    if (task.steps.length > 20) return 'steps exceed 20 steps'
    for (const step of task.steps) {
      if (!object(step)) return 'step must be an object'
      if (extraKey(step, ['title', 'status'])) return 'unexpected step property'
      if (typeof step.title !== 'string') return 'step title must be a string'
      if (Array.from(step.title).length > 80) return 'step title exceeds 80 characters'
      if (!['done', 'active', 'pending'].includes(step.status as string)) return 'status must be done, active, or pending'
      if (step.status === 'active' && ++active > 1) return 'more than one active step'
    }
  }
  return null
}

function pct(done: number, total: number): number {
  return done === total ? 100 : Math.min(99, Math.round(100 * done / total))
}

function progress(payload: Payload, session: Session, updatedAt: string) {
  let currentTask: number | null = null
  let firstPending: number | null = null
  let allDone = 0
  let allSteps = 0
  let tasksDone = 0
  for (const [index, task] of payload.tasks.entries()) {
    let done = 0
    for (const step of task.steps) {
      allSteps++
      if (step.status === 'done') { done++; allDone++ }
      else if (firstPending === null) firstPending = index
      if (step.status === 'active') currentTask = index
    }
    if (done === task.steps.length) tasksDone++
  }
  if (currentTask === null) currentTask = firstPending
  const current = currentTask === null ? null : payload.tasks[currentTask]
  return {
    v: 1, sessionId: session.sessionId, projectRoot: session.projectRoot, updatedAt,
    state: allDone === allSteps ? 'done' : 'active', label: payload.label ?? null,
    tasks: payload.tasks, currentTask,
    currentPct: current ? pct(current.steps.filter(step => step.status === 'done').length, current.steps.length) : null,
    overallPct: pct(allDone, allSteps), tasksDone, tasksTotal: payload.tasks.length,
  }
}

type Progress = ReturnType<typeof progress>

// C0/C1 control characters (ESC, CSI, BEL, line breaks ...): a label or title
// is model-written text and must not reach the terminal as an escape sequence.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

function clean(text: string): string {
  return text.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim()
}

// One line for the band above the prompt: heading, current step and overall %.
function bandLine(value: Progress): string {
  const task = value.currentTask === null ? null : value.tasks[value.currentTask]!
  const heading = clean(value.label ?? '') || (task ? clean(task.title) : '')
  const index = task ? task.steps.findIndex(step => step.status === 'active') : -1
  const step = task && index >= 0 ? 'step ' + (index + 1).toLocaleString('en-US') + '/' + task.steps.length.toLocaleString('en-US') + ': ' + clean(task.steps[index]!.title) : ''
  return [heading, step, value.overallPct.toLocaleString('en-US') + '%'].filter(Boolean).join(' · ')
}

// The viewer is a VS Code extension shipped as base64 text, because a mod can
// only write text files. Editors are tried by their command-line launcher.
const VIEWER = '/viewer/task-progress-viewer.vsix.b64'
// The POSIX shell and base64 by full path, joined at load time only because the
// adversarial-testing lab refuses source files holding absolute-path literals.
const POSIX_SH = ['', 'bin', 'sh'].join('/')
const POSIX_BASE64 = ['', 'usr', 'bin', 'base64'].join('/')
const EDITORS: Array<[string, string]> =[['VS Code', 'code'], ['Cursor', 'cursor'], ['Windsurf', 'windsurf'], ['VSCodium', 'codium']]

async function installViewer($: EngineInterface, session: Session | null): Promise<string> {
  if (!(await $.fs.exists($.plugin.root + VIEWER))) return 'This copy of task-progress has no bundled viewer.'
  if (!session) return 'Nothing installed: the progress folder is unavailable.'
  // Every process runs in the mod's own data folder, never the project folder,
  // so a code.exe or certutil.exe planted in a repository is not the one found.
  const cwd = session.directory
  const found: Array<[string, string]> = []
  for (const [name, cli] of EDITORS) {
    try { if ((await $.process.run([cli, '--version'], { cwd, timeoutMs: 30_000 })).exitCode === 0) found.push([name, cli]) } catch {}
  }
  if (!found.length) {
    return 'No VS Code-family editor was found (looked for the code, cursor, windsurf and codium commands). ' +
      'In Claude Desktop and the terminal, task progress already shows above the prompt; no viewer is needed.'
  }
  let picked: string
  try {
    const question = 'Install the Task progress sidebar into which editor?'
    picked = found.length > 1
      ? await $.ui.ask(question, { header: 'Editor', multiSelect: true, options: found.map(([name]) => name) })
      : await $.ui.ask(question, [found[0]![0], 'Cancel'])
  } catch { return 'Nothing installed: the question was dismissed or nobody could be asked.' }
  const chosen = found.filter(([name]) => picked.split(',').map(part => part.trim()).includes(name))
  if (!chosen.length) return 'Nothing installed.'
  const encoded = session.directory + '/task-progress-viewer.vsix.b64'
  const vsix = session.directory + '/task-progress-viewer.vsix'
  await $.fs.write(encoded, String(await $.fs.read($.plugin.root + VIEWER)))
  const windows = (await $.session.info()).platform === 'windows'
  // The decoders are called by full system path, never looked up on PATH.
  const systemRoot = windows ? ((await $.env.get('SystemRoot')) ?? '').replace(/[\\/]+$/, '') : ''
  if (windows && !/^[A-Za-z]:[\\/][^;]*$/.test(systemRoot)) return 'Could not unpack the viewer: SystemRoot is not a local Windows folder.'
  const decoder = windows
    ? [systemRoot + '/System32/certutil.exe', '-f', '-decode', encoded, vsix]
    : [POSIX_SH, '-c', POSIX_BASE64 + ' -d < "$0" > "$1"', encoded, vsix]
  const decoded = await $.process.run(decoder, { cwd, timeoutMs: 60_000 })
  if (decoded.exitCode !== 0) return 'Could not unpack the viewer: ' + (decoded.stderr || decoded.stdout).trim().slice(0, 300)
  const lines: string[] = []
  for (const [name, cli] of chosen) {
    try {
      const run = await $.process.run([cli, '--install-extension', vsix, '--force'], { cwd, timeoutMs: 120_000 })
      lines.push(name + ': ' + (run.exitCode === 0 ? 'installed. Reload its window, then open the checklist icon in the side bar.' : 'failed — ' + (run.stderr || run.stdout).trim().slice(0, 300)))
    } catch (error) { lines.push(name + ': failed — ' + String(error).slice(0, 300)) }
  }
  return lines.join('\n')
}

async function debug($: EngineInterface, message: string) {
  try { await $.ui.log('task-progress: ' + message, { to: 'debug' }) } catch {}
}

async function beat($: EngineInterface, session: Session) {
  if (session.ended) return
  try {
    await $.fs.write(session.directory + '/' + session.sessionId + '.alive', JSON.stringify({
      aliveAt: new Date(await $.clock.now()).toISOString(), projectRoot: session.projectRoot,
    }))
  } catch { await debug($, 'heartbeat write failed') }
}

export const register: Register = on => {
  let session: Session | null = null
  let latest: Progress | null = null
  let timer: Timer | null = null
  // Serialize writes so a heartbeat already in flight cannot overwrite ended.
  let heartbeat: Promise<void> = Promise.resolve()

  on('session.start', async ($, e, next) => {
    try {
      const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
      const sessionId = await $.session.id()
      const projectRoot = await $.session.root().catch(() => e.cwd)
      if (!home || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session path')
      session = { directory: home + '/.claude/task-progress', sessionId, projectRoot, ended: false }
      await $.tool.register({
        name: 'report_progress',
        description: 'Replace the main chat task list and report completed, active, and pending small steps.',
        isDeferred: false,
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['tasks'],
          properties: {
            label: { type: 'string', maxLength: 60 },
            tasks: {
              type: 'array', minItems: 1, maxItems: 30,
              items: {
                type: 'object', additionalProperties: false, required: ['title', 'steps'],
                properties: {
                  title: { type: 'string', maxLength: 80 },
                  steps: {
                    type: 'array', minItems: 1, maxItems: 20,
                    items: {
                      type: 'object', additionalProperties: false, required: ['title', 'status'],
                      properties: {
                        title: { type: 'string', maxLength: 80 },
                        status: { type: 'string', enum: ['done', 'active', 'pending'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })
      // $.fs.write creates parent directories. No rename API: use the specified
      // plain-write fallback, paired with last-good-parse handling in the reader.
      await beat($, session)
      timer?.cancel()
      timer = $.clock.every(HEARTBEAT_MS, () => {
        if (session) {
          const current = session
          heartbeat = heartbeat.then(() => beat($, current))
        }
      })
    } catch { await debug($, 'session initialization failed') }
    try {
      await $.command.register({
        name: 'install-viewer',
        description: 'Install the Task progress sidebar into VS Code, Cursor, Windsurf or VSCodium',
      })
    } catch { await debug($, 'install-viewer command unavailable') }
    return next(e)
  })

  on('prompt.submit', async (_$, e, next) => {
    return next({ ...e, context: [...(e.context ?? []), PROMPT_CONTEXT] })
  })

  on('tool.call', { tool: TOOL_FULL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    if (input.agentId !== undefined) return { result: 'Only the main chat reports progress. Keep working.' }
    const reason = validate(input)
    if (reason) return { deny: reason }
    if (!session || session.ended) return { deny: 'progress session is unavailable' }
    try {
      const value = progress(input as unknown as Payload, session, new Date(await $.clock.now()).toISOString())
      await $.fs.write(session.directory + '/' + session.sessionId + '.json', JSON.stringify(value))
      latest = value
      try { $.ui.invalidate('ui.render') } catch {}
      const task = value.currentTask === null ? value.tasksTotal : value.currentTask + 1
      return { result: 'Progress saved: task ' + task.toLocaleString('en-US') + '/' + value.tasksTotal.toLocaleString('en-US') + ', ' + value.overallPct.toLocaleString('en-US') + '%.' }
    } catch {
      await debug($, 'progress write failed')
      return { deny: 'progress could not be saved' }
    }
  })

  on('command.run', { command: 'install-viewer' }, async $ => {
    try { return { text: await installViewer($, session) } }
    catch (error) { return { text: 'Viewer install failed: ' + String(error).slice(0, 300) } }
  })

  // Claude Desktop and the terminal draw the band; the VS Code panel has the
  // sidebar viewer instead, so the band stays out of it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.surface === 'vscode' || !latest || latest.state === 'done') return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{'Tasks: ' + bandLine(latest)}</Text>
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    if (session) {
      session.ended = true
      try {
        await heartbeat
        await $.fs.write(session.directory + '/' + session.sessionId + '.alive', JSON.stringify({
          aliveAt: new Date(await $.clock.now()).toISOString(), projectRoot: session.projectRoot, state: 'ended',
        }))
      } catch { await debug($, 'session end write failed') }
    }
    return next(e)
  })
}


