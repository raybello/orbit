import { resolveVoiceProvider, type AvatarColor, type AvatarShape, type BotId, type ModelChoice, type UserId, type VoiceProvider } from '@orbit/contracts';
import { type BotState, type EngineKind, transition } from '../domain/bot-lifecycle.js';

/**
 * What it takes to create a bot, as data rather than as SQL.
 *
 * The rules here are the ones routes.ts used to inline around its INSERT: capacity, the name
 * fallback, the two-value normalisations (mode, voice provider) and the voice model default. Nothing
 * in this file touches the database — the caller inserts the row, assigns the engine and registers
 * the computer, in that order, exactly as before.
 */

export interface BotCreationInput {
  /** The owner. Not part of the POST /bots body: the route takes it from the session. */
  userId: UserId;
  name?: string;
  label?: string;
  description?: string;
  instructions?: string;
  avatarShape?: string;
  avatarColor?: string;
  mode?: string;
  isPrimary?: boolean;
  voiceProvider?: string;
  voiceModel?: string;
  /** The model it runs. Absent means the stack's default (BotCreationDeps.defaultModel). */
  modelChoice?: ModelChoice;
}

export interface BotCreationDeps {
  /** Whether this owner may add one more bot. The route answers it from `bots` and MAX_BOTS. */
  canAddBot(userId: UserId): boolean;
  /** The ceiling, quoted in the error message. */
  maxBots: number;
  /** A fresh bot id (`bot_...`). */
  newBotId(): string;
  /** The look for a bot id, honouring a requested shape/colour when the palette has them. */
  pickAvatar(id: string, requestedShape?: string, requestedColor?: string): { shape: AvatarShape; color: AvatarColor };
  /** The model a bot runs when the request picks none (DEFAULT_BOT_PROVIDER / DEFAULT_BOT_MODEL). */
  defaultModel: ModelChoice;
}

export interface BotPlan {
  botId: BotId;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatar: { shape: AvatarShape; color: AvatarColor };
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  voiceProvider: VoiceProvider;
  voiceModel: string;
  modelChoice: ModelChoice;
  /** A freshly created bot: `created`, which the route hands to beginProvisioning. */
  state: BotState;
}

/** The name a bot gets when the request names none (or only whitespace). */
export const DEFAULT_BOT_NAME = 'New Bot';
/** The on-device voice a bot starts with when the request names none. */
export const DEFAULT_VOICE_MODEL = 'piper-lessac-medium';

/** Thrown when the computer has no room for another bot. The message is shown to the user. */
export class TeamFullError extends Error {
  readonly maxBots: number;

  constructor(maxBots: number) {
    super(`The team is full: the computer has room for ${maxBots} bots. Remove one to add another.`);
    this.name = 'TeamFullError';
    this.maxBots = maxBots;
  }
}

/**
 * Turn a create-bot request into everything the row needs, or throw TeamFullError.
 *
 * The capacity check comes first, before an id or an avatar is allocated, so a rejected request
 * leaves no trace.
 */
export function planBotCreation(input: BotCreationInput, deps: BotCreationDeps): BotPlan {
  if (!deps.canAddBot(input.userId)) throw new TeamFullError(deps.maxBots);

  const botId = deps.newBotId() as BotId;
  return {
    botId,
    name: String(input.name ?? '').trim().slice(0, 60) || DEFAULT_BOT_NAME,
    label: input.label ?? '',
    description: input.description ?? '',
    instructions: input.instructions ?? '',
    avatar: deps.pickAvatar(botId, input.avatarShape, input.avatarColor),
    // Only the exact word means teammate; anything else is a personal bot.
    mode: input.mode === 'teammate' ? 'teammate' : 'personal',
    isPrimary: Boolean(input.isPrimary),
    // Voice runs on-device unless the request explicitly asks for the cloud path.
    voiceProvider: resolveVoiceProvider(input.voiceProvider),
    voiceModel: String(input.voiceModel ?? '').slice(0, 80) || DEFAULT_VOICE_MODEL,
    modelChoice: input.modelChoice ?? deps.defaultModel,
    state: { status: 'created', botId },
  };
}

/**
 * The created -> provisioning handoff, as a state-machine transition rather than a bare string.
 * Returns the state unchanged if it is not `created` (e.g. a screen was already claimed), so callers
 * can check `status === 'provisioning'` before starting an engine.
 */
export function beginProvisioning(state: BotState, engineKind: EngineKind): BotState {
  return transition(state, { type: 'provision-engine', engineKind });
}
