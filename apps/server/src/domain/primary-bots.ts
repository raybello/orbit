/**
 * Which bots are the team's primaries.
 *
 * Being primary is a flag on the bot row, not a role: a primary can talk to every other bot and
 * change them, and it carries the star in the app. The rules the product puts on that set:
 *
 *   - at most MAX_PRIMARY_BOTS at once
 *   - at least one always, so there is always somebody to coordinate the team
 *
 * The transitions are pure. The caller loads the current ids, asks for a plan, and writes the
 * resulting set in one statement, so two rules can never disagree about the outcome.
 */

export const MAX_PRIMARY_BOTS = 3;

export interface BotPrimaryFlag {
  id: string;
  isPrimary: boolean;
}

export type PrimaryAction = 'promote' | 'restore';

export type PrimaryPlan =
  | { ok: true; /** Every id that should be primary afterwards, in the caller's order. */ primaries: string[]; changed: boolean }
  | { ok: false; status: 400 | 404; message: string };

const ids = (flags: readonly BotPrimaryFlag[]) => flags.filter((f) => f.isPrimary).map((f) => f.id);

/** The bots that are not primaries, in creation order: what a promotion may pick from. */
export const nonPrimaries = (flags: readonly BotPrimaryFlag[]): string[] =>
  flags.filter((f) => !f.isPrimary).map((f) => f.id);

/**
 * Plan one change to the primary set.
 *
 * Promoting a bot that is already primary and restoring one that is not are both no-ops that
 * succeed: the caller asked for a state, and the state already holds. That makes the operations
 * idempotent, which matters because the agent tools can be retried by a model.
 */
export function planPrimaryChange(flags: readonly BotPrimaryFlag[], targetId: string, action: PrimaryAction): PrimaryPlan {
  if (!flags.some((f) => f.id === targetId)) return { ok: false, status: 404, message: 'No such bot.' };

  const current = ids(flags);
  const already = current.includes(targetId);

  if (action === 'promote') {
    if (already) return { ok: true, primaries: current, changed: false };
    if (current.length >= MAX_PRIMARY_BOTS) {
      return {
        ok: false,
        status: 400,
        message: `There are already ${MAX_PRIMARY_BOTS} primary Bots, the most a team allows. Restore one to default before promoting another.`,
      };
    }
    // Keep the creation order the caller passed in, so the team list does not reshuffle.
    return { ok: true, primaries: flags.filter((f) => f.isPrimary || f.id === targetId).map((f) => f.id), changed: true };
  }

  if (!already) return { ok: true, primaries: current, changed: false };
  if (current.length <= 1) {
    return {
      ok: false,
      status: 400,
      message: 'This is the only primary Bot. The last primary cannot be restored to default; promote another Bot first.',
    };
  }
  return { ok: true, primaries: current.filter((id) => id !== targetId), changed: true };
}
