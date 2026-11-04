import type { EngineInterface, Register } from 'claude-code'

// .NET Char.IsWhiteSpace: JS trimEnd keeps U+0085 and removes U+FEFF.
const TRAILING_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/
const SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const HEADING = new RegExp(`^${SPACE}*#{1,6}${SPACE}+([^\\n]+?)${SPACE}*$`)
// PS 5.1's .NET Framework Unicode tables differ from the JS runtime. These
// exceptions were enumerated against the original regex/ToLowerInvariant for
// all 65,536 UTF-16 units; process units separately, including for Greek sigma.
const NEW_LETTERS = /[\u0560\u0588\u05ef\u0860-\u086a\u0870-\u0887\u0889-\u088e\u08b5-\u08c9\u09fc\u0c5d\u0c80\u0cdd\u0d04\u0d54-\u0d56\u0e86\u0e89\u0e8c\u0e8e-\u0e93\u0e98\u0ea0\u0ea8-\u0ea9\u0eac\u170d\u171f\u1878\u1b4c\u1c80-\u1c8a\u1c90-\u1cba\u1cbd-\u1cbf\u1cf2-\u1cf3\u1cfa\u2c2f\u2c5f\u312e-\u312f\u31bb-\u31bf\u4db6-\u4dbf\u9fd6-\u9fff\ua7ae-\ua7af\ua7b8-\ua7cd\ua7d0-\ua7d1\ua7d3\ua7d5-\ua7dc\ua7f2-\ua7f6\ua8fe\uab66-\uab69]/
const CASE_IDENTITY = /[\u0130\u01c5\u01c8\u01cb\u01f2\u037f\u03f4\u0524\u0526\u0528\u052a\u052c\u052e\u10c7\u10cd\u13a0-\u13f5\u1c89\u1c90-\u1cba\u1cbd-\u1cbf\u1e9e\u2126\u212a-\u212b\u2c2f\u2c70\u2c7e-\u2c7f\u2ceb\u2ced\u2cf2\ua660\ua698\ua69a\ua78d\ua790\ua792\ua796\ua798\ua79a\ua79c\ua79e\ua7a0\ua7a2\ua7a4\ua7a6\ua7a8\ua7aa-\ua7ae\ua7b0-\ua7b4\ua7b6\ua7b8\ua7ba\ua7bc\ua7be\ua7c0\ua7c2\ua7c4-\ua7c7\ua7c9\ua7cb-\ua7cc\ua7d0\ua7d6\ua7d8\ua7da\ua7dc\ua7f5]/
const LETTER_DIGIT = /[\p{L}\p{Nd}\u1885\u1886]/u
const nonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.replace(TRAILING_SPACE, '').length > 0
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error)
const stamp = () => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
function join(folder: string, name: string) {
  const windows = /^[a-z]:[\\/]/i.test(folder) || folder.includes('\\')
  return (windows ? folder.replace(/\//g, '\\') : folder).replace(/[\\/]+$/, '') + (windows ? '\\' : '/') + name
}
function slugOf(plan: string) {
  const lines = plan.split(/\r?\n/)
  const title = lines.map(line => HEADING.exec(line)?.[1]).find(value => value !== undefined) ?? lines.find(nonBlank) ?? ''
  const slug = title.replace(/[`*_~\[\]()]/g, '').split('')
    .map(c => LETTER_DIGIT.test(c) && !NEW_LETTERS.test(c) ? c : '-').join('')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '').split('')
    .map(c => CASE_IDENTITY.test(c) ? c : c.toLowerCase()).join('')
    .slice(0, 80).replace(/-+$/, '')
  return slug || `plan-${stamp()}`
}
function toast($: EngineInterface, text: string) {
  try { $.ui.toast(text) } catch { /* A missing surface must not fail ExitPlanMode. */ }
}
const INSTALL_HINT = 'Install it with /plugin marketplace add EfiPerez/claude-code-skills, then /plugin install codec-loop@efi-skills.'
// undefined = the command list could not be read; a listing failure must never block a review.
async function codecReviewInstalled($: EngineInterface): Promise<boolean | undefined> {
  try {
    return (await $.command.list()).some(c => c.name === 'codec-review' || c.name.endsWith(':codec-review'))
  } catch { return undefined }
}
// The review record's lock (sentinel.ps1) needs Windows PowerShell; elsewhere the record is skipped.
const isWindowsPath = (path: string) => /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')

export const register: Register = on => {
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.isError || 'deny' in r) return r
    const add = (text: string) => ({ ...r, context: [...(r.context ?? []), text] })
    let planPath: string
    let plansFolder: string
    let hash: string
    try {
      if (await $.env.get('CODEC_REVIEW_ACTIVE')) return r
      const root = await $.session.cwd()
      if (!nonBlank(root) || (await $.fs.stat(root).catch(() => undefined))?.kind !== 'dir') {
        throw new Error('Claude did not provide a valid project folder.')
      }
      const output = (r.result as { plan?: unknown } | undefined)?.plan
      const fallback = (e as { plan?: unknown }).plan
      const plan = nonBlank(output) ? output : nonBlank(fallback) ? fallback : undefined
      if (plan === undefined) throw new Error('Claude did not provide the approved plan content.')
      plansFolder = join(root, 'plans')
      const slug = slugOf(plan)
      planPath = join(plansFolder, `${slug}.md`)
      if (await $.fs.exists(planPath)) planPath = join(plansFolder, `${slug}-${stamp()}.md`)
      const body = plan.replace(TRAILING_SPACE, '') + '\r\n'
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
      hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
      await $.fs.write(planPath, body)
    } catch (error) {
      const text = `The ExitPlanMode hook could not save the plan: ${reasonOf(error)}. The plan is still in the conversation - save it manually before implementing, and mention this failure.`
      toast($, text)
      return add(text)
    }

    if (await codecReviewInstalled($) === false) {
      toast($, `plan-review: the codec-review skill is not installed, so no review was requested. ${INSTALL_HINT}`)
      return add(`The approved plan was saved to ${planPath}. The codec-review skill is not installed, so no review was requested. ` +
        `Tell the user, and do not start implementing until they say how to proceed. ${INSTALL_HINT}`)
    }
    if (!isWindowsPath(planPath)) {
      return add(`The approved plan was saved to ${planPath}. ` +
        'Before writing any code, run the codec-review skill with that ABSOLUTE path as its input. ' +
        'It runs a bounded adversarial review loop against Codex and reports back for your sign-off. ' +
        'Do not re-enter plan mode, and do not begin implementing until that review has been signed off. ' +
        '(On this system plan-review keeps no review record, so an unchanged plan approved again is reviewed again.)')
    }

    try {
      const result = await $.process.run([
        'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(join($.plugin.root, 'hooks'), 'sentinel.ps1'),
        plansFolder, hash, planPath, `mod:plan-review:${await $.session.id()}`,
      ], { timeoutMs: 15000 })
      if (result.exitCode !== 0) throw new Error(`PowerShell exited with code ${result.exitCode}: ${result.stderr.trim()}`)
      const decision = result.stdout.trim()
      if (decision === 'review') {
        const relativePath = join('plans', planPath.split(/[\\/]/).pop()!)
          .replace(/\//g, '\\')
        return add(`The approved plan was saved to ${planPath} (also at ${relativePath}). ` +
          'Before writing any code, run the codec-review skill with that ABSOLUTE path as its input. ' +
          'It runs a bounded adversarial review loop against Codex and reports back for your sign-off. ' +
          'Do not re-enter plan mode, and do not begin implementing until that review has been signed off.')
      }
      if (decision === 'skip-reviewed') {
        return add(`The approved plan was saved to ${planPath}. This plan's content is unchanged since it was ` +
          'last reviewed, so codec-review was not re-triggered. Implementation has not started - ' +
          'say so and wait for direction, or re-run codec-review explicitly if a fresh review is wanted.')
      }
      if (decision === 'skip-in-flight') {
        const sentinel = JSON.parse(await $.fs.read(join(plansFolder, '.codec-reviewed.json')))
        const lease = sentinel[hash]?.lease_until
        if (typeof lease !== 'string' || !Number.isFinite(Date.parse(lease))) throw new Error('The in-flight review lease could not be read')
        return add(`Saved to \`${planPath}\`. A codec-review of this exact content is already running (lease until \`${lease}\`), so it was not re-triggered. Do not start implementing; wait for that review or for the user's direction.`)
      }
      if (decision === 'skip-locked') {
        return add(`Saved to \`${planPath}\`. Another plan approval was updating the review record at the same moment, so this one did not request a review. Tell the user, and run codec-review on that absolute path if they want it.`)
      }
      throw new Error(`Unexpected PowerShell output: ${JSON.stringify(result.stdout)}`)
    } catch (error) {
      const reason = reasonOf(error)
      toast($, reason)
      return add(`Saved to \`${planPath}\`, but the review record could not be updated (\`${reason}\`), so no review was requested. Tell the user; run codec-review on that path before implementing.`)
    }
  })
}
