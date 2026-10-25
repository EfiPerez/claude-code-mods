// plain-language: Claude's chat replies to you are plain English at a CEFR
// level, with no code unless asked. It lives in a mod and not in CLAUDE.md on
// purpose: other AI tools that read CLAUDE.md (code reviewers, coding agents)
// would pick up these rules too and give vague answers with no file:line
// evidence. A mod's prompt text reaches Claude Code only.

import type { EngineInterface, Register } from 'claude-code'

export const SECTION_ID = 'plain-language:style'

export function styleText(level: string): string {
  return [
    '# How to write to the user in chat',
    '',
    'These rules apply only to the messages you write to the user in this chat, and they override any',
    'instruction that says to assume a technical reader. They do NOT apply to: files you write',
    '(code, docs, CLAUDE.md, handoffs, review reports), prompts you write for subagents or other AI tools,',
    'or what you return when you are a subagent. Those keep full technical detail and file:line',
    'evidence.',
    '',
    `- Write in CEFR ${level} English: short sentences, common words, one idea per sentence. The user is`,
    '  smart and busy, not a beginner; the goal is easy to follow, not talking down.',
    '- Explain everything in plain English for a non-programmer. If a technical term is',
    '  unavoidable, define it in a few words the first time it appears.',
    "- Don't paste code into the chat unless the user asks; say what it does and where it lives (a file",
    '  link is fine).',
    '- After finishing a task, report: what changed, where, and how the user can test it. 5 lines max.',
    '- Keep answering BLUF: the conclusion first, in one or two sentences.',
    '- When the user asks for code, a diff, exact commands, or "the technical version", give it in full.',
  ].join('\n')
}

// Headless runs (claude -p, the SDK) have no person reading the chat. VS Code reports
// "not interactive", so the entrypoint is the test: headless ones are sdk-*.
async function headless($: EngineInterface): Promise<boolean> {
  return ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) ?? '').startsWith('sdk')
}

export const register: Register = (on, options) => {
  const level = options?.cefrLevel === 'A2' ? 'A2' : 'B1'

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // --bare keeps its one section; a teammate writes to its lead, not to the user; print is -p / SDK.
    if (e.traits.includes('bare') || e.traits.includes('teammate') || e.traits.includes('print')) return result
    return { sections: [...result.sections, { id: SECTION_ID, text: styleText(level), scope: 'session' }] }
  })

  // prompt.compose above is skipped on managed / Team / Enterprise machines (cc-plugin-sec-default),
  // so the rules also ride on the first prompt of each conversation as hidden context: the model
  // reads them, the chat shows nothing and no extra turn is spent. Keyed on the session id because
  // /clear starts a new conversation in the same process with no session.start; recorded only once
  // the prompt actually entered, so a prompt another hook dropped does not use up the delivery.
  let attachedFor = ''
  on('prompt.submit', async ($, e, next) => {
    const sid = await $.session.id()
    if (attachedFor === sid || (await headless($))) return next(e)
    const r = await next({ ...e, context: [...(e.context ?? []), styleText(level)] })
    if (r.drop === undefined) attachedFor = sid
    return r
  })

  // A compaction summary would drop that message; ask the summarizer to keep the rules.
  on('session.compact', async ($, e, next) => {
    if (e.agentId || (await headless($))) return next(e)
    return next({ ...e, instructions: [e.instructions, keepText(level)].filter(Boolean).join('\n\n') })
  })
}

export function keepText(level: string): string {
  return `Copy this block word for word at the end of the summary; it is the user's standing chat style:\n\n${styleText(level)}`
}
