import type { Bot, CalendarResponse, ComputersResponse, CreateRoutineRequest, FileEntry, FilesResponse, ComputerState, LiveState, ModelChoice, ModelsResponse, Routine, Row, SkillEntry, SkillsResponse, Toolkit, User, EventEdits, EventFields, GoogleCalendarInfo, DuplicateDefaults, PairCodeResponse } from '@orbit/contracts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); }
}

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AppsResponse { apps: Toolkit[]; connected: string[]; categories: string[]; total: number }

export interface RoomMember { id: string; name: string; label: string; avatarShape: string; avatarColor: string }

export interface TeamTemplateSummary {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  schedule: string;
  memberCount: number;
  memberNames: string[];
}

export const api = {
  me: () => req<{ user: User | null; devLogin: boolean }>('GET', '/auth/me'),
  /** Tell the server this device's timezone (bots use it for times). */
  setTimezone: (timezone: string) => req<{ user: User }>('PATCH', '/auth/me', { timezone }),
  updateMe: (patch: { avatarUrl?: string | null }) => req<{ user: User }>('PATCH', '/auth/me', patch),
  uploadAvatar: async (file: File): Promise<{ url: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/auth/avatar', { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new ApiError(res.status, msg);
    }
    return res.json() as Promise<{ url: string }>;
  },
  /** A single-use code for the phone's QR (see PairCodeResponse). */
  pairCode: () => req<PairCodeResponse>('POST', '/auth/pair'),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode'> & (ModelChoice | object)) => req<{ bot: Bot }>('POST', '/bots', b),
  /** The models a new Bot can run: the primary agent's connected providers, and the default. */
  models: () => req<ModelsResponse>('GET', '/models'),
  markRead: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/read`),
  rows: (id: string) => req<{ generation: number; rows: Row[] }>('GET', `/bots/${id}/rows`),
  send: (id: string, text: string, files?: { path: string; filename: string; mediaType: string }[]) =>
    req<{ row: Row }>('POST', `/bots/${id}/messages`, files?.length ? { text, files } : { text }),

  uploadAttachment: async (id: string, file: File): Promise<{ path: string; filename: string; mediaType: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/bots/${id}/attachments`, { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* not json */ }
      throw new ApiError(res.status, msg);
    }
    return res.json() as Promise<{ path: string; filename: string; mediaType: string }>;
  },
  interrupt: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/interrupt`),
  fresh: (id: string) => req<{ ok: true }>('POST', `/bots/${id}/fresh`),

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny', edits?: unknown) => req<{ ok: true }>('POST', `/approvals/${approvalId}`, edits ? { decision, edits } : { decision }),
  /** Keep an approval card's call waiting while the person edits it. */
  approvalEditing: (approvalId: string) => req<{ ok: boolean }>('POST', `/approvals/${approvalId}/editing`),
  /** Save, send or discard a Gmail draft from its email card. */
  draftAction: (botId: string, seq: number, action: 'save' | 'send' | 'discard', edits?: unknown) =>
    req<{ card: unknown }>('POST', `/bots/${botId}/cards/${seq}/draft`, edits ? { action, edits } : { action }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),
  deleteRoom: (id: string) => req<{ ok: true }>('DELETE', `/rooms/${id}`),

  calendar: (from: string, to: string) => req<CalendarResponse>('GET', `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  /** The person's Google calendars and which ones the Orbit calendar shows. */
  googleCalendars: () => req<{ state: { available: boolean; reason?: string }; calendars: GoogleCalendarInfo[]; sync: { lastSyncAt: number | null; lastError: string | null } }>('GET', '/calendar/google'),
  setGoogleCalendar: (key: string, enabled: boolean) => req<{ ok: true }>('PATCH', `/calendar/google/${encodeURIComponent(key)}`, { enabled }),
  /** What an Orbit event made from this Google event starts with. */
  duplicateDefaults: (key: string) => req<DuplicateDefaults>('GET', `/calendar/google/events/${encodeURIComponent(key)}/duplicate`),
  syncGoogle: () => req<{ ok: true; changes: number }>('POST', '/calendar/google/sync'),
  createGoogleEvent: (body: { calendarKey?: string; fields: EventFields; notifyGuests?: boolean }) => req<{ ok: true; eventId: string }>('POST', '/calendar/google/events', body),
  updateGoogleEvent: (key: string, edits: EventEdits) => req<{ ok: true }>('PATCH', `/calendar/google/events/${encodeURIComponent(key)}`, { edits }),
  deleteGoogleEvent: (key: string, opts: { scope?: 'this' | 'following' | 'all'; notify?: boolean }) =>
    req<{ ok: true }>('DELETE', `/calendar/google/events/${encodeURIComponent(key)}?${new URLSearchParams({ ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.notify !== undefined ? { notify: opts.notify ? '1' : '0' } : {}) })}`),
  createRoutine: (r: CreateRoutineRequest) => req<{ routine: Routine }>('POST', '/routines', r),

  files: (opts: { botId?: string; type?: string; search?: string; page?: number; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.botId) q.set('botId', opts.botId);
    if (opts.type && opts.type !== 'all') q.set('type', opts.type);
    if (opts.search) q.set('search', opts.search);
    if (opts.page) q.set('page', String(opts.page));
    if (opts.pageSize) q.set('pageSize', String(opts.pageSize));
    const s = q.toString();
    return req<FilesResponse>('GET', `/files${s ? `?${s}` : ''}`);
  },
  /** URL a browser can open/download directly; the file id is already URL-safe. */
  fileUrl: (file: Pick<FileEntry, 'id'> | string) => `/api/files/${typeof file === 'string' ? file : file.id}/download`,

  computers: () => req<ComputersResponse>('GET', '/computers'),

  skills: () => req<SkillsResponse>('GET', '/skills'),
  setSkillEnabled: (botId: string, skillName: string, enabled: boolean) =>
    req<{ skill: SkillEntry }>('PUT', `/skills/${encodeURIComponent(botId)}/${encodeURIComponent(skillName)}`, { enabled }),

  teamTemplates: () => req<{ templates: TeamTemplateSummary[] }>('GET', '/team-templates'),
  createTeam: (body: { slug: string; name?: string; schedule?: string; timezone?: string }) =>
    req<{ bots: Bot[]; roomId: string; routineId: string }>('POST', '/teams', body),
};

export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return window.open(url, 'grokbot-connect', `width=${w},height=${h},left=${left},top=${top}`);
}
