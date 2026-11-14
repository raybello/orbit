import type {
  Bot, CalendarResponse, ComputersResponse, CreateRoutineRequest, FileEntry, FilesResponse,
  ComputerState, LiveState, Routine, Row, SkillEntry, SkillsResponse, Toolkit, User,
} from '@orbit/contracts';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
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

export const api = {
  me: () => req<{ user: User | null; devLogin: boolean }>('GET', '/auth/me'),
  devLogin: (email: string, name?: string) => req<{ ok: true }>('POST', '/auth/dev', { email, name }),
  logout: () => req<{ ok: true }>('POST', '/auth/logout'),

  bots: () => req<{ bots: Bot[]; live: LiveState[] }>('GET', '/bots'),
  createBot: (b: Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'mode'>) => req<{ bot: Bot }>('POST', '/bots', b),
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

  approve: (approvalId: string, decision: 'allow' | 'always' | 'deny') => req<{ ok: true }>('POST', `/approvals/${approvalId}`, { decision }),
  answer: (id: string, seq: number, answer: string) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/answer`, { answer }),
  dismiss: (id: string, seq: number) => req<{ ok: true }>('POST', `/bots/${id}/cards/${seq}/dismiss`),

  routines: (id: string) => req<{ routines: Routine[] }>('GET', `/bots/${id}/routines`),
  setRoutine: (rid: string, enabled: boolean) => req<{ routine: Routine }>('PATCH', `/routines/${rid}`, { enabled }),

  computer: () => req<{ computer: ComputerState }>('GET', '/computer'),
  ensureComputer: () => req<{ computer: ComputerState }>('POST', '/computer/ensure'),

  apps: (search = '', category = '') => req<AppsResponse>('GET', `/apps?search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}`),
  connect: (slug: string, botId?: string, seq?: number) => req<{ redirectUrl: string }>('POST', `/apps/${slug}/connect`, { botId, seq }),
  disconnect: (slug: string) => req<{ ok: true }>('DELETE', `/apps/${slug}`),

  googleStatus: () => req<{ configured: boolean; connected: boolean; email: string | null }>('GET', '/google/status'),
  googleConnect: () => req<{ redirectUrl: string }>('GET', '/google/connect'),
  googleDisconnect: () => req<{ ok: true }>('DELETE', '/google'),

  roomMembers: (id: string) => req<{ members: RoomMember[] }>('GET', `/rooms/${id}/members`),
  setRoomMembers: (id: string, botIds: string[]) => req<{ ok: true; members: string[] }>('PUT', `/rooms/${id}/members`, { botIds }),
  createRoom: (name: string, botIds: string[]) => req<{ id: string }>('POST', '/rooms', { name, botIds }),

  // ---------- calendar ----------
  calendar: (from: string, to: string) => req<CalendarResponse>('GET', `/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  createRoutine: (r: CreateRoutineRequest) => req<{ routine: Routine }>('POST', '/routines', r),

  // ---------- files ----------
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

  // ---------- computers ----------
  computers: () => req<ComputersResponse>('GET', '/computers'),

  // ---------- skills (MCP servers) ----------
  skills: () => req<SkillsResponse>('GET', '/skills'),
  setSkillEnabled: (botId: string, skillName: string, enabled: boolean) =>
    req<{ skill: SkillEntry }>('PUT', `/skills/${encodeURIComponent(botId)}/${encodeURIComponent(skillName)}`, { enabled }),
};

/** Open a Composio redirect in a centered popup. */
export function openPopup(url: string) {
  const w = 520, h = 680;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return window.open(url, 'grokbot-connect', `width=${w},height=${h},left=${left},top=${top}`);
}
