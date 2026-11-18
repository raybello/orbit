// The shared API contract between the Orbit server, the web app, the desktop app and mobile.
// Everything here is type-only or plain constants: no runtime dependencies.

export * from './branded-types.js';
// Bot templates and the starter gallery (F6, F7).
export * from './templates.js';
// Auto-review rules (F9).
export * from './rules.js';
export * from './review.js';
// Voice model management (F, on-device default).
export * from './voice.js';
import type { VoiceModelItem } from './voice.js';

export type AvatarShape =
  | 'blob' | 'pebble' | 'bean' | 'egg' | 'squircle' | 'tablet' | 'capsule' | 'cylinder' | 'hex'
  | 'gem' | 'crystal' | 'wedge' | 'shield' | 'dome' | 'arch' | 'cloud' | 'teardrop' | 'leaf'
  | 'square' | 'sparkle' | 'clover' | 'flower' | 'heart' | 'house' | 'star';

export type AvatarColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'violet' | 'magenta' | 'gray';

export interface User { id: string; email: string; name: string; avatarUrl: string | null }

export interface Bot {
  id: string;
  name: string;
  label: string;
  description: string;
  instructions: string;
  avatarShape: AvatarShape;
  avatarColor: AvatarColor;
  mode: 'personal' | 'teammate';
  isPrimary: boolean;
  /** 'room' = group chat (members answer instead of the bot itself). */
  kind?: 'agent' | 'room';
  /** True when the room was created by a team template (has an orchestrating routine). */
  isTeam?: boolean;
  pinned: boolean;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** Voice chat settings: xAI voice id, speed multiplier (0.7–1.5), BCP-47 language or 'auto'. */
  voice: string;
  voiceSpeed: number;
  voiceLanguage: string;
  /** Which pipeline a call uses: the xAI realtime path, the on-device sherpa-onnx one, or audio.cpp on a GPU. */
  voiceProvider: VoiceProvider;
  /** On-device voice model id (see GET /api/voice/local/models); unused on the cloud path. */
  voiceModel: string;
  /** audio.cpp (GPU) voice: one of LFM3-Audio's built-in voices, e.g. `british_english_male`. */
  audiocppVoice?: string;
  /** audio.cpp: show the lip-synced portrait video during calls (needs `hasPortrait`). */
  avatarEnabled?: boolean;
  /** audio.cpp: a portrait has been uploaded (GET /api/voice/audiocpp/portrait/:botId). */
  hasPortrait?: boolean;
  /** The person lets this Bot's approval cards offer "Always allow for <Bot>", kept for this Bot only. Off by default. */
  alwaysAllow?: boolean;
  /** Hermes engine: model id and provider for this bot; null = the engine's default. */
  model: string | null;
  provider: string | null;
  /** How much the Bot reaches out unasked. Only the person's first primary Bot acts on it. */
  /** Defaults to 'proactive' for the primary bot; 'reactive' for all others. Optional so old rows without the column still deserialise. */
  initiative?: InitiativeLevel;
  generation: number;
  unread: number;
  lastPreview: string | null;
  lastActivityAt: number;
  createdAt: number;
}

/** A transcript row. `seq` orders rows; `updatedSeq` is a per-bot revision counter (rows are rewritten while streaming). */
export interface Row {
  botId: string;
  generation: number;
  seq: number;
  updatedSeq: number;
  kind: RowKind;
  body: RowBody;
  createdAt: number;
}

export type RowKind = 'message' | 'tool-call' | 'card' | 'event' | 'notice';

export type RowBody =
  | MessageBody
  | ToolCallBody
  | CardBody
  | EventBody
  | NoticeBody;

export interface MessageFile {
  /** Path relative to the bot's library root (e.g. "images/photo.jpg"). */
  path: string;
  filename: string;
  /** MIME type, e.g. "image/jpeg". */
  mediaType: string;
}

export interface MessageBody {
  type: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** Set when a message came from another bot, a routine or a voice call rather than the user typing. */
  from?: { kind: 'bot' | 'routine' | 'voice'; id: string; name: string };
  citations?: { url: string; title?: string }[];
  /** Files the agent attached to this message (images, downloads). */
  files?: MessageFile[];
}

export interface ToolCallBody {
  type: 'tool-call';
  callId: string;
  name: string;
  /** Human phrase, e.g. "Clicking on screen". */
  label: string;
  status: 'running' | 'done' | 'error' | 'awaiting-approval' | 'denied';
  args?: unknown;
  summary?: string;
  /** Data URL thumbnail for computer actions. */
  screenshot?: string;
}

export type CardBody =
  | {
      type: 'card';
      card: 'approval';
      approvalId: string;
      title: string;
      detail: string;
      tool: string;
      toolkit?: string;
      toolkitName?: string;
      logo?: string;
      args: unknown;
      /** The auto-review rule that raised this card. "Always allow" cannot override a rule, so the card does not offer it. */
      rule?: { id: string; description: string };
      /** False for an action that must ask every time (sending email): the card does not offer "Always allow". */
      offerAlways?: boolean;
      /** Set when the person turned on per-bot "Always allow" for this Bot: the button reads "Always allow for <Bot>" and is kept for this Bot only. */
      alwaysFor?: { botId: string; botName: string };
      /** What the action will do, for Gmail, Calendar, Sheets and Docs: shown in full, and editable before approving. */
      review?: import('./review.js').ReviewPayload;
      /** The person changed the action before allowing it; `review` shows their version. */
      edited?: boolean;
      status: 'pending' | 'allowed' | 'always' | 'denied' | 'expired';
    }
  | {
      type: 'card';
      card: 'question';
      question: string;
      options: string[];
      status: 'pending' | 'answered' | 'dismissed';
      answer?: string;
    }
  | {
      type: 'card';
      card: 'connect';
      toolkit: string;
      toolkitName: string;
      logo?: string;
      reason: string;
      /** The app was connected and its sign-in expired: the card asks to reconnect it. */
      reconnect?: true;
      status: 'pending' | 'connected' | 'skipped';
    }
  | {
      type: 'card';
      card: 'draft';
      channel: 'email' | 'slack' | 'message';
      to: string;
      subject?: string;
      text: string;
      approvalId: string;
      status: 'pending' | 'sent' | 'discarded';
    }
  | SecureFormCardBody;

export interface EventBody {
  type: 'event';
  event: 'routine-created' | 'routine-updated' | 'routine-run' | 'task-changed' | 'bot-message' | 'conversation-cleared' | 'computer' | 'voice-call';
  text: string;
  ref?: string;
  /** voice-call only: the call record (set on the end-of-call row). */
  call?: VoiceCallRecord;
}

export interface VoiceCallRecord {
  id: string;
  phase: 'started' | 'ended';
  durationMs?: number;
  summary?: string;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  tasks?: string[];
}

export interface VoiceOption { id: string; name: string; gender?: string }

/**
 * Who runs a voice call: the cloud provider, the on-device sherpa-onnx stack in this server (CPU), or
 * an audio.cpp server (GPU: OWSM ASR, LFM3-Audio TTS, optional SoulX-FlashHead avatar video).
 */
export type VoiceProvider = 'cloud' | 'local' | 'audiocpp';

export type VoiceModelStateValue = 'missing' | 'downloading' | 'ready' | 'error';

export interface VoiceModelState { stt: VoiceModelStateValue; tts: VoiceModelStateValue; vad: VoiceModelStateValue }

/**
 * `GET /api/voice/local/status`. `provider` is always 'cpu': the sherpa-onnx npm package ships no
 * CUDA execution provider and CoreML segfaults the VITS model, so `available` never depends on a GPU.
 */
export interface VoiceLocalStatus {
  available: boolean;
  reason?: string;
  runtime: { platform: string; arch: string; provider: 'cpu'; addon: boolean };
  models: VoiceModelState;
  bytes: { total: number; have: number };
  download: { active: boolean; pct: number; name: string | null };
  /** Every model, required and optional, with its state and size on disk. */
  voices: VoiceModelItem[];
}

/** What a notice reports, so a client can style or filter it. A plain notice has none. */
export type NoticeKind = 'context-compacted';

export interface NoticeBody { type: 'notice'; text: string; tone?: 'info' | 'warn' | 'error'; kind?: NoticeKind }

export type ActivityKind =
  | 'thinking' | 'working' | 'searching_web' | 'reading_web' | 'browsing_web' | 'on_its_computer'
  | 'running_commands' | 'waiting_on_command' | 'messaging_named' | 'connecting_service'
  | 'waiting_for_you' | 'drafting_file' | 'remembering';

export interface LiveState {
  botId: string;
  isRunning: boolean;
  activity: { kind: ActivityKind; detail?: string; since: number } | null;
  awaiting: { reason: string; since: number } | null;
  startedAt: number | null;
  /** Short line from the model's live reasoning, shown next to "Thinking". */
  caption?: string | null;
  /** Tool calls made so far in the current turn. */
  steps?: number;
}

export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: string; timezone: string;
  enabled: boolean; nextRunAt: number | null; lastRunAt: number | null; description: string;
  /** Calendar metadata. A routine without these is a plain recurring cron routine. */
  calendarTitle: string | null;
  eventType: 'recurring' | 'one_time';
  /** ISO 8601 date-time, only for one_time events. */
  eventDate: string | null;
  /** Bot that runs it when the calendar event is assigned to another bot; null = the routine's own bot. */
  assignedBotId: string | null;
  /** ISO 8601, set once a one_time event has run. */
  completedAt: string | null;
}

export interface Task { id: string; botId: string; title: string; state: 'working' | 'needs_input' | 'done'; note: string; updatedAt: number }

export interface Memory { id: string; botId: string; text: string; createdAt: number; source?: 'chat' | 'learned' }

export interface Skill { id: string; botId: string; name: string; description: string; body: string; createdAt: number; updatedAt: number }

export interface LibraryFile { name: string; size: number; modifiedAt: number; isDir: boolean }

export interface ComputerState {
  status: 'absent' | 'creating' | 'starting' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error' | 'stopped';
  orgoId: string | null;
  error: string | null;
  /** One screen per bot on the shared computer. width/height are the screen's pixel size. */
  screens: { botId: string; screenId: string; width?: number; height?: number }[];
  /** How many bots can have their own screen at once. */
  maxScreens?: number;
}

/** A model provider Hermes can use (subscription sign-in or API key). */
export interface EngineProvider {
  id: string;
  name: string;
  kind: 'subscription' | 'api_key';
  connected: boolean;
  /** Suggested model ids for this provider. */
  models: string[];
}

/** The Hermes agent that runs one bot. */
export interface EngineInfo {
  botId: string;
  /** Hermes profile name ('default' for the primary bot). */
  profile: string;
  status: 'ready' | 'starting' | 'stopped' | 'error';
  error: string | null;
  model: string | null;
  provider: string | null;
  version: string | null;
  providers: EngineProvider[];
  /** Hermes is running a private screen of its own for this agent, so its computer work is not on the screen the app shows. */
  ownScreen: boolean;
}

export interface Toolkit {
  slug: string; name: string; logo?: string; description?: string; categories: string[];
  managedAuth: boolean; noAuth: boolean; connected: boolean;
  /** Set on an app that is not connected because its sign-in expired, never on a connected one. */
  needsReconnect?: true;
}

/** One row of App Settings → Engine Auth: a bot's engine plus which shared credentials it has. */
export interface BotEngineAuthRow {
  botId: string;
  name: string;
  engine: 'primary' | 'managed';
  provider: string | null;
  model: string | null;
  status: 'ready' | 'starting' | 'stopped' | 'error' | 'unknown';
  /** Which SHARED_ENV keys are non-empty in this bot's .env. Never the values. */
  keysPresent: string[];
}

/** GET /api/config/engine-auth */
export interface EngineAuthResponse { bots: BotEngineAuthRow[] }

/** Server-sent events on GET /api/events */
export type ServerEvent =
  /** `seq` is the server's authoritative event cursor for this user, for `GET /api/events?since=`. */
  | { type: 'hello'; serverTime: number; seq?: number }
  | { type: 'rows'; botId: string; generation: number; rows: Row[] }
  | { type: 'cleared'; botId: string; generation: number }
  | { type: 'live'; state: LiveState }
  | { type: 'roster' }
  | { type: 'bot'; bot: Bot }
  | { type: 'computer'; state: ComputerState }
  | { type: 'routines'; botId: string }
  | { type: 'tasks'; botId: string }
  | { type: 'memories'; botId: string }
  | { type: 'connections' }
  | { type: 'activity'; item: ActivityItem }
  | { type: 'computer-status'; status: BotComputerStatus }
  | { type: 'files-updated'; botId: string }
  | { type: 'ping' };

// ------------------------------------------------------------------ nav

/** The sections of the left icon rail. */
export type NavSection = 'activity' | 'chat' | 'calendar' | 'calls' | 'files' | 'computers' | 'skills';

/** One entry of the cross-bot Activity feed. */
export interface ActivityItem {
  botId: string;
  botName: string;
  kind: 'message' | 'card' | 'working' | 'completed';
  preview: string;
  at: number;
  seq?: number;
}

// ------------------------------------------------------------------ calendar

/** One occurrence on the calendar. The server expands recurring routines into these. */
export interface CalendarEvent {
  routineId: string;
  botId: string;
  botName: string;
  title: string;
  /** ISO datetimes. */
  start: string;
  end: string;
  /** Cron expression for a recurring event, null for a one-time event. */
  recurrenceRule: string | null;
  eventType: 'recurring' | 'one_time';
  completedAt: string | null;
}

/** GET /api/calendar?from=&to= */
export interface CalendarResponse { events: CalendarEvent[] }

/** POST /api/routines */
export interface CreateRoutineRequest {
  botId: string;
  title: string;
  prompt: string;
  eventType: 'recurring' | 'one_time';
  /** Cron expression for a recurring event. */
  schedule?: string;
  /** ISO datetime for a one-time event. */
  eventDate?: string;
  timezone?: string;
  description?: string;
}

// ------------------------------------------------------------------ files

/** One file in the unified Files view. */
export interface FileEntry {
  /** Opaque, URL-safe id: it encodes the source and path, and the download route resolves it. */
  id: string;
  botId: string;
  botName: string;
  type: 'library' | 'attachment' | 'workspace';
  filename: string;
  /** Path relative to that source's root. */
  path: string;
  size: number;
  mediaType: string;
  /** Unix ms. */
  createdAt: number;
  downloadUrl: string;
}

/** GET /api/files */
export interface FilesResponse { files: FileEntry[]; total: number; page: number; pageSize: number }

// ------------------------------------------------------------------ computers

export interface BotComputerStatus {
  botId: string;
  botName: string;
  kind: 'docker' | 'orgo' | 'none';
  status: 'awake' | 'sleeping' | 'starting' | 'unknown';
  /** The agent is running a turn right now. */
  isRunning: boolean;
  vncAvailable: boolean;
  screenId: string | null;
}

/** GET /api/computers */
export interface ComputersResponse { computers: BotComputerStatus[] }

// ------------------------------------------------------------------ skills (MCP servers)

/** A skill/MCP server from the primary agent's config, and which bots have it. */
export interface SkillEntry {
  name: string;
  type: 'http' | 'stdio' | string;
  url: string | null;
  description: string | null;
  /** Always true: the primary agent's config is the source of truth and is read-only here. */
  primaryEnabled: boolean;
  bots: { botId: string; botName: string; enabled: boolean }[];
}

/** GET /api/skills */
export interface SkillsResponse { skills: SkillEntry[] }

// ------------------------------------------------------------------ vault (F12)

/** A saved login as the app shows it. The secret is write-only: no response ever carries it. */
export interface VaultEntry {
  id: string;
  label: string;
  username: string | null;
  /** The site it belongs to (`https://github.com`, `https://*.amazon.com/ap`), or null for any page. */
  urlPattern: string | null;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/vault. `configured` is false when the server has no usable DB_ENCRYPTION_KEY. */
export interface VaultResponse { configured: boolean; entries: VaultEntry[] }

/** POST /api/vault. */
export interface CreateVaultEntryRequest { label: string; username?: string | null; secret: string; urlPattern?: string | null }

/** PATCH /api/vault/:id. An omitted `secret` keeps the stored one; null clears a username or pattern. */
export interface UpdateVaultEntryRequest { label?: string; username?: string | null; secret?: string; urlPattern?: string | null }

/** One input of a secure form: `secret` is the masked one, and every form has exactly one. */
export interface SecureFormField { key: 'username' | 'secret'; label: string }

/**
 * A bot asking for a login it does not have. What the person types goes straight to
 * POST /api/bots/:id/cards/:seq/secure-form and into the Vault: it is never part of this row, a
 * message, or anything the bot reads.
 */
export interface SecureFormCardBody {
  type: 'card';
  card: 'secure-form';
  /** What the login is for; it becomes the Vault label the bot fills it in by. */
  label: string;
  reason: string;
  fields: SecureFormField[];
  /** The site the bot wants it for, when it named one. */
  urlPattern?: string;
  status: 'pending' | 'submitted' | 'dismissed';
  /** Set on submit: whether the person kept it in the Vault or let it expire after this use. */
  saved?: boolean;
}

/** POST /api/bots/:id/cards/:seq/secure-form */
export interface SecureFormSubmitRequest { values: { username?: string; secret: string }; save: boolean }

// ------------------------------------------------------------------ audit log (F13)

/**
 * How a tool call got to run, or did not: `allowed` after the person approved it, `auto-allowed`
 * when nothing asked, `denied` when the person, a policy or an expired approval stopped it, and
 * `pending` while an approval is still open.
 */
export type AuditOutcome = 'allowed' | 'auto-allowed' | 'denied' | 'pending';

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['allowed', 'auto-allowed', 'denied', 'pending'];

/** One tool call a bot made, with the approval decision that belongs to it. */
export interface AuditEntry {
  botId: string;
  generation: number;
  seq: number;
  /** Unix ms the call started. */
  at: number;
  tool: string;
  label: string;
  args: unknown;
  status: ToolCallBody['status'];
  summary: string | null;
  outcome: AuditOutcome;
  approval: { decision: 'pending' | 'allowed' | 'always' | 'denied' | 'expired'; decidedAt: number | null } | null;
}

/** GET /api/bots/:id/audit?from=&to=&tool=&outcome=&q=&format=json|csv */
export interface AuditResponse {
  entries: AuditEntry[];
  /** How many entries matched before `limit` cut the list. */
  total: number;
  /** Every tool name in the date range, for the filter. */
  tools: string[];
  /** AUDIT_RETENTION_DAYS: how far back the log reaches; 0 = no limit. */
  retentionDays: number;
}

// ------------------------------------------------------------------ aliases
// The implementation plan names some of these differently (BotRow / MessageRow /
// RoutineRow / TaskRow / EventPayload). Keep both spellings so clients can pick.

/** Alias of {@link ServerEvent}, for clients that call the union `EventPayload`. */
export type EventPayload = ServerEvent;
/** A transcript row, as the mobile client names it. */
export type MessageRow = Row;
export type RoutineRow = Routine;
export type TaskRow = Task;
export type BotRow = Bot;

// ------------------------------------------------------------------ API shapes

export interface ErrorResponse { error: string }

export interface AuthMeResponse { user: User | null; devLogin: boolean }

/** POST /api/auth/sign-in — a bearer session token for the mobile and desktop clients. */
export interface SignInRequest { email: string; name?: string; ownerKey?: string }
export interface SignInResponse { ok: true; token: string; user: User; expiresAt: number }

export interface BotsResponse { bots: Bot[]; live: LiveState[] }
export interface RowsResponse { generation: number; rows: Row[] }
export interface SendMessageRequest { message?: string; text?: string }
export interface SendMessageResponse { row: Row }

/** GET /api/health */
export interface HealthResponse {
  ok: boolean;
  version?: string;
  engine?: 'hermes';
  /** 'verified' when a valid x-orbit-stack-token header was sent with the probe. */
  stackToken?: 'verified';
  uptimeMs?: number;
}

/** GET /api/desktop/probe — authenticated with the stack token only. */
export interface DesktopProbeResponse {
  ok: boolean;
  imageTag: string;
  hermesConnected: boolean;
  version?: string;
}

/** GET /api/desktop/config — the desktop client's feature flags. */
export interface DesktopConfigResponse {
  updateCheckUrl: string;
  features: { voice: boolean; pushNotifications: boolean };
  maxBots: number;
  version?: string;
}

export type PushPlatform = 'ios' | 'android';

export interface PushRegisterRequest { token: string; platform: PushPlatform }

/** The body sent to the Expo Push API. */
export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
}

/** Headers the desktop client and the local stack controller use. */
export const ORBIT_HEADERS = {
  /** Marks a request as coming from the Orbit desktop app. */
  desktop: 'x-orbit-desktop',
  /** Shared secret the desktop app's local stack controller uses to probe its own stack. */
  stackToken: 'x-orbit-stack-token',
} as const;

/** Env var that overrides the server the desktop app opens. */
export const ORBIT_WEB_URL_ENV = 'ORBIT_WEB_URL';

// ------------------------------------------------------------------ deep links (F1)

export * from './deep-link.js';

// ------------------------------------------------------------------ proactive initiative (F8)

/**
 * `proactive`: check-ins, the morning briefing and every signal. `reactive`: only alerts (a failed
 * routine, an expired app connection). `off`: nothing unasked.
 */
export const INITIATIVE_LEVELS = ['proactive', 'reactive', 'off'] as const;
export type InitiativeLevel = (typeof INITIATIVE_LEVELS)[number];

export interface MorningBriefingSettings {
  /** null when the routine was deleted or not seeded yet; turning the briefing on creates one. */
  routineId: string | null;
  enabled: boolean;
  /** Local "HH:MM", or null when the routine was rescheduled to something other than a time of day. */
  time: string | null;
  timezone: string;
}

/** GET /api/initiative */
export interface InitiativeSettings {
  /** Hours without a message from the person before the primary Bot may check on them; 0 = never. */
  idleHours: number;
  briefing: MorningBriefingSettings;
}

/** PUT /api/initiative */
export interface InitiativeSettingsPatch {
  idleHours?: number;
  briefing?: { enabled?: boolean; time?: string; timezone?: string };
}

/**
 * `GET /api/voice/audiocpp/status`. `available` = the audio.cpp server answers and every model Orbit
 * needs is configured and loaded. `download` is present when the models live on this stack's data
 * volume (the Docker sidecar), where Orbit can fetch them; a native server manages its own.
 */
/**
 * The desktop app's control over the GPU voice sidecar on this computer (Windows and Linux with an
 * NVIDIA GPU). The person installs it: nothing ~3 GB is pulled without asking. macOS has no CUDA
 * sidecar yet, so there it reports `supported: false` and voice stays on-device.
 */
export interface DesktopGpuVoice {
  supported: boolean;
  /** Why it can't be installed here. */
  reason?: 'macos' | 'no-nvidia' | 'not-docker-stack' | 'docker-missing';
  /** "NVIDIA GeForce RTX 5070 Ti · 16 GB", when one was found. */
  gpu?: string;
  /** The person turned it on (the stack runs the sidecar). */
  enabled: boolean;
  phase: 'off' | 'installing' | 'on' | 'removing' | 'error';
  detail?: string;
  error?: string;
}

export interface AudiocppStatus {
  available: boolean;
  /**
   * Why it is unavailable. `disabled`: this server has GPU voice turned off (AUDIOCPP_URL=off, which
   * the desktop app sets on macOS until an Apple-silicon sidecar exists); clients hide GPU voice and
   * calls use on-device voice instead.
   */
  reason?: 'disabled' | 'unreachable' | 'server-error' | 'models-missing' | 'downloading' | 'models-not-loaded';
  url: string;
  /** Model ids Orbit uses → loaded on the server. */
  models: Record<string, boolean>;
  /** The avatar model is configured: portraits can be animated. */
  avatar: boolean;
  download: { state: 'missing' | 'downloading' | 'ready' | 'error'; pct: number; file: string | null; error?: string; serverError?: string } | null;
  /** The audio.cpp server's own reason it is not running (from the sidecar), when known. */
  detail?: string;
  /** A Docker sidecar Orbit can run the download in was found. */
  managed: boolean;
  voices: string[];
}
