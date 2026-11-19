/**
 * Deterministic loop detection over the tool calls of one turn, the same for Hermes's own tools
 * and the app's. Hermes warns the model first (after two identical failures, or two identical
 * read results) and never stops a bot reached over its API server, so these limits sit one step
 * past its warnings: the model was told and kept going.
 */

/** One finished tool call. `args` and `output` are compared as given, so pass canonical text or a hash. */
export interface ToolEvent { name: string; args: string; ok: boolean; output: string; error?: string }

export type LoopRule = 'same-call-failed' | 'consecutive-failures' | 'no-progress' | 'step-budget';

export interface LoopTrip { rule: LoopRule; tool: string; count: number; error?: string }

export interface LoopLimits {
  /** The same tool with the same arguments failed this many times. */
  sameCallFailures: number;
  /** This many tool calls in a row failed, whatever they were. */
  consecutiveFailures: number;
  /** The same tool with the same arguments gave the same output this many times in a row. */
  sameResultRepeats: number;
  /** Tool calls in one turn. */
  maxToolCalls: number;
}

export const DEFAULT_LIMITS: LoopLimits = { sameCallFailures: 3, consecutiveFailures: 4, sameResultRepeats: 3, maxToolCalls: 60 };

/** Tools that are meant to be called again with the same arguments (waiting, polling, looking). */
const REPEATABLE = /screenshot|wait|sleep|poll|status|process|read_page|windows/i;

/**
 * A tool result without the notes Hermes appends to it ("[Tool loop warning: …]", "[hermes note:
 * …]"). Those carry a running count, so left in they make every repeat look new, and they turn a
 * JSON result into text that no longer parses.
 */
export function toolResultText(text: string): string {
  return text.replace(/(\s*\n)*\[(Tool loop warning|hermes note)\b[\s\S]*$/, '').trimEnd();
}

/** The first rule the turn's tool calls break, or null. Call after each finished tool call. */
export function checkLoop(events: readonly ToolEvent[], limits: LoopLimits = DEFAULT_LIMITS): LoopTrip | null {
  const last = events.at(-1);
  if (!last) return null;
  if (events.length > limits.maxToolCalls) return { rule: 'step-budget', tool: last.name, count: events.length };

  if (!last.ok) {
    const same = events.filter((e) => !e.ok && e.name === last.name && e.args === last.args).length;
    if (same >= limits.sameCallFailures) return { rule: 'same-call-failed', tool: last.name, count: same, ...(last.error ? { error: last.error } : {}) };
    let run = 0;
    for (let i = events.length - 1; i >= 0 && !events[i].ok; i--) run++;
    if (run >= limits.consecutiveFailures) return { rule: 'consecutive-failures', tool: last.name, count: run, ...(last.error ? { error: last.error } : {}) };
    return null;
  }

  if (REPEATABLE.test(last.name)) return null;
  let repeats = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e.ok || e.name !== last.name || e.args !== last.args || e.output !== last.output) break;
    repeats++;
  }
  return repeats >= limits.sameResultRepeats ? { rule: 'no-progress', tool: last.name, count: repeats } : null;
}

/** What the bot was stuck on, in one sentence (for the chat notice and the reassess message). */
export function describeTrip(t: LoopTrip): string {
  const why = t.error ? `: ${t.error.slice(0, 200)}` : '';
  switch (t.rule) {
    case 'same-call-failed': return `${t.tool} failed ${t.count} times with the same arguments${why}`;
    case 'consecutive-failures': return `${t.count} tool calls in a row failed, the last one ${t.tool}${why}`;
    case 'no-progress': return `${t.tool} returned the same result ${t.count} times in a row`;
    case 'step-budget': return `it made ${t.count} tool calls in one turn without finishing`;
  }
}
