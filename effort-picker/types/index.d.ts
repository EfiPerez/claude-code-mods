// effort-picker's $.state contract.
// Every value is session-scoped and survives a hot reload; nothing here holds
// prompt text, file content or model-written text.

export type EffortPickerLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type EffortPickerCategory =
  | 'chat_or_question'
  | 'lookup_or_search'
  | 'trivial_edit'
  | 'contained_change'
  | 'multi_file_change'
  | 'unknown_root_cause'
  | 'review_or_plan'
  | 'strict_rules'
  | 'long_agentic'
  | 'architecture_security_data'
  | 'prior_attempt_failed'

export type EffortPickerManual = false | 'effort-command' | 'ultrathink' | 'skill' | 'agent-request'

export type EffortPickerLoop = {
  turnId: string
  manual: EffortPickerManual
  desired: { level: EffortPickerLevel; category: EffortPickerCategory } | null
  applied: { level: EffortPickerLevel | number; step: number } | null
  /** A failed step left the sent value unknown: no footer this turn. */
  appliedUnknown: boolean
  /** The effort the engine itself handed the previous step (before any rewrite). */
  lastIncoming: EffortPickerLevel | number | null
}

declare module 'claude-code' {
  interface PluginState {
    'effort-picker': {
      /** key: 'main' | a subagent's agentId */
      loops: Record<string, EffortPickerLoop>
      /** Set by command.run, consumed by the next main turn.start. */
      pendingManual: false | 'effort-command' | 'skill'
      /** Agent tool_use_ids marked [effort-locked], until their call settles. */
      lockedSpawns: string[]
      /** agentId -> lock, from agent.spawn's result, until the child's turn.complete. */
      spawned: Record<string, { locked: boolean }>
      /** Last applied main level seen at an answered turn (R4). */
      lastShownMain: EffortPickerLevel | number | null
      /** Why the rewrite is off for the rest of the session, once proven refused. */
      disabled: string | null
      /** Consecutive failed rewritten steps. */
      failures: number
    }
  }
}
