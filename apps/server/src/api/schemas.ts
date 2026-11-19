import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { AUDIOCPP_VOICES, INITIATIVE_LEVELS, type ModelChoice } from '@orbit/contracts';

/**
 * The JSON bodies routes.ts accepts, as zod schemas, and the two helpers that read them.
 *
 * Two rules shaped these schemas:
 *
 *  - Validation is a boundary concern, so a schema only says what shape a body has. Checks whose
 *    failure has its own user-facing message stay in the route (an email without '@' is
 *    "email required", a missing push token is "token required"), which keeps every message and
 *    status a client sees today.
 *  - Optional fields stay optional and loose objects stay loose, exactly where the route used to
 *    ignore what it did not read. A schema here is not allowed to reject a body the old code happily
 *    handled.
 *
 * A malformed or wrong-typed body becomes HTTPException(400), which api/app.ts renders as
 * `{ error }`. Bodies that used to reach SQLite and fail there are the only ones whose status changes.
 */

/** POST /api/auth/dev — `email` is checked in the route so the message stays "email required". */
export const DevLoginSchema = z.object({ email: z.string().optional(), name: z.string().optional() }).loose();

/** POST /api/auth/sign-in — the native clients' token flow. */
export const SignInSchema = z
  .object({ email: z.string().optional(), name: z.string().optional(), ownerKey: z.string().optional() })
  .loose();

/** POST /api/auth/owner — the owner key comes in the Authorization header, not here. */
export const OwnerSignInSchema = z.object({ email: z.string().optional(), name: z.string().optional(), link: z.boolean().optional() }).loose();

/** POST /api/push/register — platform is checked in the route ("platform must be 'ios' or 'android'"). */
export const PushRegisterSchema = z.object({ token: z.string().optional(), platform: z.string().optional() }).loose();

/** DELETE /api/push/register?token=... — the query names one device, so signing out does not silence the rest. */
export const PushTokenQuerySchema = z.object({ token: z.string().optional() });

/**
 * POST /api/bots. `name` is optional on purpose: an empty body still creates "New Bot", as the
 * inline code did when the name was blank.
 */
export const CreateBotSchema = z
  .object({
    name: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    avatarShape: z.string().optional(),
    avatarColor: z.string().optional(),
    mode: z.string().optional(),
    isPrimary: z.boolean().optional(),
    voiceProvider: z.string().optional(),
    voiceModel: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  })
  .loose()
  .transform(({ provider, model, ...rest }, ctx) => {
    if (provider === undefined && model === undefined) return rest;
    const choice = parseModelChoice(provider, model);
    if (typeof choice !== 'string') return { ...rest, modelChoice: choice };
    ctx.addIssue({ code: 'custom', path: ['model'], message: choice });
    return z.NEVER;
  });

/**
 * A model id or provider slug as a person or an agent names it: "anthropic", "claude-sonnet-4-6",
 * "deepseek/deepseek-flash", "qwen3:32b". Not checked against the live list, which may be unreachable.
 */
const ModelIdSchema = z.string().trim().min(1).max(120).regex(/^\S+$/, 'no spaces');

/**
 * A Bot's model choice from two loose values, or the reason it is not one. Shared by POST /api/bots
 * and the create_bot tool, so a person and an agent are held to the same rule.
 */
export function parseModelChoice(provider: unknown, model: unknown): ModelChoice | string {
  if (provider === undefined || model === undefined) return 'provider and model go together: name both';
  const p = ModelIdSchema.safeParse(provider);
  const m = ModelIdSchema.safeParse(model);
  if (!p.success) return `provider: ${p.error.issues[0]?.message ?? 'not a provider id'}`;
  if (!m.success) return `model: ${m.error.issues[0]?.message ?? 'not a model id'}`;
  return { provider: p.data, model: m.data };
}

/**
 * PATCH /api/bots/:id. Loose, because the route walks its own allow-list and ignores every other
 * key; each allow-listed key is typed by the column it lands in (pinned is 0/1, voice_speed REAL,
 * the rest TEXT). `mode`, `voiceProvider` and the avatar fields are checked against their real
 * value sets by the code that consumes them, exactly as before.
 */
export const PatchBotSchema = z
  .object({
    name: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    avatarShape: z.string().optional(),
    avatarColor: z.string().optional(),
    mode: z.string().optional(),
    effort: z.string().optional(),
    pinned: z.union([z.boolean(), z.number()]).optional(),
    voice: z.string().optional(),
    voiceSpeed: z.number().optional(),
    voiceLanguage: z.string().optional(),
    // An explicit choice: anything else would be stored and read back as on-device.
    voiceProvider: z.enum(['cloud', 'local', 'audiocpp']).optional(),
    voiceModel: z.string().optional(),
    // GPU voice: one of LFM3-Audio's voices, and whether a call shows the animated portrait.
    audiocppVoice: z.enum(AUDIOCPP_VOICES as [string, ...string[]]).optional(),
    avatarEnabled: z.boolean().optional(),
    alwaysAllow: z.boolean().optional(),
    // New with F8, so no older client sends anything else: the column only ever holds a real level.
    initiative: z.enum(INITIATIVE_LEVELS).optional(),
  })
  .loose();

/** POST /api/bots/:id/messages — `text` is optional here so the route can answer "empty" as before. */
export const SendMessageSchema = z
  .object({
    text: z.string().optional(),
    files: z
      .array(z.object({ path: z.string(), filename: z.string(), mediaType: z.string() }).loose())
      .optional(),
  })
  .loose();

/** POST /api/approvals/:id — the three decisions the approval UI offers. */
const EventFieldsSchema = z.object({
  summary: z.string().max(1024), description: z.string().max(8000), location: z.string().max(1024),
  start: z.string().max(32), end: z.string().max(32), allDay: z.boolean(), timezone: z.string().max(64),
  attendees: z.array(z.string().max(320)).max(200), meet: z.boolean(),
});
/** POST /api/calendar/google/events */
export const GoogleEventCreateSchema = z.object({ calendarKey: z.string().optional(), fields: EventFieldsSchema, notifyGuests: z.boolean().optional() }).loose();
/** PATCH /api/calendar/google/events/:key — the event review's edits (fields, scope, notifyGuests), checked by it. */
export const GoogleEventPatchSchema = z.object({ edits: z.record(z.string(), z.unknown()) }).loose();

/** PATCH /api/calendar/google/:key */
export const CalendarToggleSchema = z.object({ enabled: z.boolean() }).loose();

/** POST /api/bots/:id/cards/:seq/draft — what to do with a Gmail draft card, with the person's edits. */
export const DraftActionSchema = z.object({
  action: z.enum(['save', 'send', 'discard']),
  edits: z.record(z.string(), z.unknown()).optional(),
}).loose();

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['allow', 'always', 'deny']),
  /** The person's changes to the action (an approval card with a `review`), checked by its review adapter. */
  edits: z.record(z.string(), z.unknown()).optional(),
}).loose();

/** POST /api/bots/:id/cards/:seq/answer */
export const CardAnswerSchema = z.object({ answer: z.string() }).loose();

/** POST /api/bots/:id/cards/:seq/dismiss — nothing is read from the body; this only documents that. */
export const CardDismissSchema = z.object({}).loose();

/** PATCH /api/routines/:id */
export const RoutineEnableSchema = z.object({ enabled: z.boolean() }).loose();

/** POST /api/bots/:id/screen/control — action is checked in the route ("action must be 'take' or 'give'"). */
export const ScreenControlSchema = z.object({ action: z.string().optional() }).loose();

/** PUT /api/config/hermes-settings — the text of either file; a file left out is not touched. */
export const SharedSettingsSchema = z.object({ env: z.string().max(256_000).optional(), config: z.string().max(1_000_000).optional() });

/** PUT /api/apps/:slug/access/:botId */
export const AppAccessSchema = z.object({ allowed: z.boolean() });

/** POST /api/apps/:slug/connect — both fields only decorate the OAuth callback URL. */
export const AppConnectSchema = z.object({ botId: z.string().optional(), seq: z.number().optional() }).loose();

/**
 * POST /api/rooms and PUT /api/rooms/:id/members. `name` and the member list are checked in the
 * route ("A group needs a name and at least 2 Bots."), which also filters ids down to the user's
 * own bots, so both stay optional here.
 */
export const CreateRoomSchema = z.object({ name: z.string().optional(), botIds: z.array(z.string()).optional() }).loose();
export const RoomMembersSchema = z.object({ botIds: z.array(z.string()).optional() }).loose();

/**
 * PUT /api/skills/:botId/:skillName. `enabled` is deliberately untyped: the route answers a
 * non-boolean with its own message ("\"enabled\" must be true or false."), and the schema's job is
 * only to insist the body is a JSON object.
 */
export const SkillToggleSchema = z.object({ enabled: z.unknown().optional() }).loose();

/**
 * POST /api/bots/:id/skills and PATCH /api/skills/:id. cleanSkill() in routes-config turns each
 * field into text (and caps it), and names the one the user has to fix ("Give the skill a name"),
 * so every field stays optional and typed only as far as "it is text".
 */
export const SkillBodySchema = z
  .object({ name: z.string().optional(), description: z.string().optional(), body: z.string().optional() })
  .loose();

/**
 * POST /api/routines — the CreateRoutineRequest contract, every field optional at the boundary.
 * The route checks the required ones itself ("botId is required.", "prompt is required.") and
 * `eventType` stays a plain string so its own message survives; it narrows the value to the two
 * event types before calling createRoutine.
 */
export const CreateRoutineSchema = z
  .object({
    botId: z.string().optional(),
    title: z.string().optional(),
    prompt: z.string().optional(),
    eventType: z.string().optional(),
    schedule: z.string().optional(),
    eventDate: z.string().optional(),
    timezone: z.string().optional(),
    description: z.string().optional(),
    parentEventKey: z.string().optional(),
  })
  .loose();
export type CreateRoutineBody = z.infer<typeof CreateRoutineSchema>;

/**
 * PATCH /api/bots/:id/engine and PUT /api/config/engine-auth/:botId. `null` is a real choice —
 * "the agent's default" — so the schema must not turn it away; engineField() maps it to NULL.
 */
export const EngineChoiceSchema = z
  .object({ provider: z.string().nullish(), model: z.string().nullish() })
  .loose();

/** POST /api/bots/:id/engine/login — the route checks the provider slug against its own pattern. */
export const EngineLoginSchema = z.object({ provider: z.string().optional() }).loose();

/** POST /api/bots/:id/files/download — safeRel() answers "bad path" for anything it cannot use. */
export const FileDownloadSchema = z.object({ path: z.string().optional() }).loose();

/** PUT /api/checkins — setCheckins() validates the times and the zone and throws with its message. */
export const CheckinSettingsSchema = z
  .object({ enabled: z.boolean().optional(), times: z.array(z.string()).optional(), timezone: z.string().optional() })
  .loose();

/** POST /api/voice/session — no body means no bot, which the route answers with its usual 404. */
export const VoiceSessionSchema = z.object({ botId: z.string().optional() }).loose();

/** POST /api/voice/tool — a realtime tool call; `args` is whatever the model produced. */
export const VoiceToolSchema = z
  .object({ botId: z.string(), callId: z.string().optional(), name: z.string(), args: z.unknown().optional() })
  .loose();

/** POST /api/voice/end — the transcript is the client's own record of the call. */
export const VoiceEndSchema = z
  .object({
    botId: z.string(),
    callId: z.string(),
    transcript: z.array(z.object({ role: z.string(), text: z.string() }).loose()).optional(),
    error: z.string().optional(),
  })
  .loose();

/** POST /api/voice/local/models/download — `{ model }`, `{ kind }`, or no body for the whole set. */
export const VoiceModelDownloadSchema = z
  .object({ model: z.string().optional(), kind: z.string().optional(), fresh: z.boolean().optional() })
  .loose();

/** POST /api/voice/local/models/cancel — the model whose download stops. */
export const VoiceModelTargetSchema = z.object({ model: z.string() }).loose();

/** POST /api/voice/local/session — the bot whose voice the call speaks with. */
export const LocalVoiceSessionSchema = z.object({ botId: z.string().optional() }).loose();

/** One line, naming the field that failed. Enough for a developer; never user-facing copy. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length ? issue.path.join('.') : 'body';
  return `invalid ${where}: ${issue?.message ?? 'unexpected value'}`;
}

/**
 * Read and validate a required JSON body. Throws HTTPException(400) for a body that is not JSON or
 * does not match the schema; app.ts turns that into `{ error }` with the same status.
 */
export async function requireBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON body' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: describe(parsed.error) });
  return parsed.data;
}

/**
 * Read a body that may legitimately be absent, as a DELETE's is. A missing or unparseable body
 * yields `fallback` instead of a 400, which is what the routes using it did before.
 */
export async function optionalBody<S extends z.ZodType>(c: Context, schema: S, fallback: z.infer<S>): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return fallback;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}
