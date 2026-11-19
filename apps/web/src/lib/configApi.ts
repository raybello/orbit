import type { Bot, BotEngineAuthRow, ComputerState, EngineAuthResponse, EngineInfo, InitiativeSettings, InitiativeSettingsPatch, GithubSkillInspect, LibraryFile, LibrarySkill, Memory, Routine, SkillLibraryResponse, Task, Toolkit } from '@orbit/contracts';
import { ApiError } from './api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    let body: unknown;
    try { body = await res.json(); msg = (body as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg, body);
  }
  return res.json() as Promise<T>;
}

export interface BotSettingsBundle {
  memories: Memory[];
  /** The library skills this Bot has. */
  skills: LibrarySkill[];
  routines: Routine[];
  tasks: Task[];
  memory: { lastConsolidatedAt: number | null; historyChars: number; compactAtChars: number; lastCompaction: { method: string; created_at: number } | null };
}

export interface LibraryListing { status: 'ok' | 'asleep' | 'error'; path: string; root?: string; files: LibraryFile[]; error?: string }

export interface ComputerDetails {
  computer: ComputerState;
  screens: { botId: string; screenId: string; lastUsedAt: number }[];
  hibernation: { idleMinutes: number; viewers: number; dryRun: boolean };
}

export interface NewLibrarySkill { name: string; content: string; description?: string; availability?: 'all' | 'selected'; botIds?: string[] }

export interface HermesSettings { env: string; config: string }
export type HermesSettingsFile = keyof HermesSettings;

export type BotPatch = Partial<Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor' | 'effort' | 'mode' | 'initiative' | 'alwaysAllow'>>;

export const configApi = {
  settings: (botId: string) => req<BotSettingsBundle>('GET', `/bots/${botId}/settings`),
  updateBot: (botId: string, p: BotPatch) => req<{ bot: Bot }>('PATCH', `/bots/${botId}`, p),
  /** What the person always-allowed for this Bot (used while its alwaysAllow setting is on). */
  botPolicies: (botId: string) => req<{ policies: { tool: string; createdAt: number }[] }>('GET', `/bots/${botId}/policies`),
  removeBotPolicy: (botId: string, tool: string) => req<{ ok: true }>('DELETE', `/bots/${botId}/policies/${encodeURIComponent(tool)}`),
  deleteBot: (botId: string) => req<{ ok: true }>('DELETE', `/bots/${botId}`),
  /** Promote a Bot to primary, or restore it to default. At most three primaries, at least one. */
  setPrimary: (botId: string, primary: boolean) => req<{ ok: true; primaries: string[] }>('POST', `/bots/${botId}/primary${primary ? '' : '/restore'}`),
  fresh: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/fresh`),
  /** The primary Bot's morning briefing and idle check, which belong to the person rather than a Bot. */
  initiative: () => req<InitiativeSettings>('GET', '/initiative'),
  setInitiative: (p: InitiativeSettingsPatch) => req<InitiativeSettings>('PUT', '/initiative', p),

  deleteMemory: (id: string) => req<{ ok: true }>('DELETE', `/memories/${id}`),


  /** The shared skill library: every skill, and which Bots have it. */
  skillLibrary: () => req<SkillLibraryResponse>('GET', '/skill-library'),
  createSkill: (s: NewLibrarySkill) => req<{ skill: LibrarySkill }>('POST', '/skill-library', s),
  updateSkill: (id: string, p: Partial<Pick<LibrarySkill, 'name' | 'description' | 'content' | 'availability'>>) => req<{ skill: LibrarySkill }>('PATCH', `/skill-library/${id}`, p),
  deleteSkill: (id: string) => req<{ ok: true }>('DELETE', `/skill-library/${id}`),
  setSkillAccess: (id: string, botId: string, allowed: boolean) => req<{ skill: LibrarySkill }>('PUT', `/skill-library/${id}/access/${encodeURIComponent(botId)}`, { allowed }),
  /** What a GitHub source would install, checked but not installed. */
  inspectGithubSkill: (source: string) => req<GithubSkillInspect>('POST', '/skill-library/github/inspect', { source }),
  installGithubSkill: (source: string, pick?: string) => req<{ skill: LibrarySkill }>('POST', '/skill-library/github', { source, ...(pick !== undefined ? { pick } : {}) }),

  setRoutine: (id: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${id}`, { enabled }),
  runRoutine: (id: string) => req<{ ok: true }>('POST', `/routines/${id}/run`),
  deleteRoutine: (id: string) => req<{ ok: true }>('DELETE', `/routines/${id}`),

  tasks: () => req<{ tasks: Task[] }>('GET', '/tasks'),
  botTasks: (botId: string) => req<{ tasks: Task[] }>('GET', `/bots/${botId}/tasks`),

  files: (botId: string, path = '', wake = false) => req<LibraryListing>('GET', `/bots/${botId}/files?path=${encodeURIComponent(path)}${wake ? '&wake=1' : ''}`),
  downloadFile: (botId: string, path: string) => req<{ url: string }>('POST', `/bots/${botId}/files/download`, { path }),

  computerDetails: () => req<ComputerDetails>('GET', '/computer/details'),
  wake: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),
  sleep: () => req<{ computer: ComputerState }>('POST', '/computer/suspend'),
  resetScreen: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/screen/reset`),
  /** Tells the bot the person has stopped driving its screen. */
  handback: (botId: string) => req<{ ok: true }>('POST', `/bots/${botId}/handback`),

  engine: (botId: string) => req<{ engine: EngineInfo }>('GET', `/bots/${botId}/engine`),
  setEngine: (botId: string, p: { provider?: string | null; model?: string | null }) => req<{ engine: EngineInfo }>('PATCH', `/bots/${botId}/engine`, p),
  /** Opens the provider's sign-in flow in a terminal on the bot's screen. */
  engineLogin: (botId: string, provider?: string) => req<{ ok: true }>('POST', `/bots/${botId}/engine/login`, provider ? { provider } : {}),
  restartEngine: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/restart`),
  /** Stops the private screen the agent runs for itself, so its computer work shows on the screen in the app. */
  stopOwnScreen: (botId: string) => req<{ engine: EngineInfo }>('POST', `/bots/${botId}/engine/screen/stop`),

  /** Every Bot's engine plus which shared credentials it has. Key values are never sent. */
  engineAuth: () => req<EngineAuthResponse>('GET', '/config/engine-auth'),
  setEngineAuth: (botId: string, p: { provider?: string; model?: string }) => req<{ bot: BotEngineAuthRow }>('PUT', `/config/engine-auth/${botId}`, p),
  /** Copies the primary Bot's shared credentials to every managed Bot. */
  syncEngineAuth: () => req<{ synced: number }>('POST', '/config/engine-auth/sync'),

  policies: () => req<{ policies: { tool: string; mode: string }[] }>('GET', '/policies'),
  deletePolicy: (tool: string) => req<{ ok: true }>('DELETE', `/policies/${encodeURIComponent(tool)}`),

  connectedApps: () => req<{ connectedApps?: Toolkit[]; connected: string[]; revoked?: Record<string, string[]> }>('GET', '/apps?limit=1'),
  /** Allow or stop one Bot using one connected app. Answers with the apps now turned off for that Bot. */
  setAppAccess: (toolkit: string, botId: string, allowed: boolean) =>
    req<{ ok: true; revoked: string[] }>('PUT', `/apps/${encodeURIComponent(toolkit)}/access/${encodeURIComponent(botId)}`, { allowed }),

  /** The Hermes settings every Bot shares: the primary agent's .env and config.yaml, as text. */
  hermesSettings: () => req<HermesSettings>('GET', '/config/hermes-settings'),
  /** Save either file; what changed is copied to every Bot and running Bots restart. A bad file answers 400 with its line. */
  saveHermesSettings: (p: Partial<HermesSettings>) =>
    req<{ updated: string[]; restarting: number; settings: HermesSettings }>('PUT', '/config/hermes-settings', p),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),
};
