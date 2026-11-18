import { Composio } from '@composio/core';
import { OpenAIResponsesProvider } from '@composio/openai';
import { db } from './db.js';
import { env } from './env.js';
import type { Toolkit } from './types.js';
import { connectionHealth, type ConnectionAccount, type ConnectionHealth } from './domain/connections.js';

/**
 * Constructed on first use: an empty COMPOSIO_API_KEY must not stop the server booting —
 * the desktop app starts its local stack before any keys are configured. The Proxy keeps
 * every existing `composio.x.y(…)` call site working unchanged.
 */
function makeComposio() {
  return new Composio({ apiKey: env.composioKey, provider: new OpenAIResponsesProvider() });
}
let composioClient: ReturnType<typeof makeComposio> | null = null;
export const composio: ReturnType<typeof makeComposio> = new Proxy({} as ReturnType<typeof makeComposio>, {
  get(_target, prop) {
    composioClient ??= makeComposio();
    const value = Reflect.get(composioClient, prop, composioClient);
    return typeof value === 'function' ? value.bind(composioClient) : value;
  },
});

export const composioEnabled = () => env.composioKey.length >= 10;

const REST = 'https://backend.composio.dev/api/v3.1';
async function rest<T>(path: string): Promise<T> {
  if (!composioEnabled()) throw new Error('COMPOSIO_API_KEY is not configured');
  const res = await fetch(`${REST}${path}`, { headers: { 'x-api-key': env.composioKey } });
  if (!res.ok) throw new Error(`Composio ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ---------- catalog (user-independent, cached) ----------

type CatalogItem = Omit<Toolkit, 'connected'>;
let catalogCache: { at: number; items: CatalogItem[] } | null = null;

/** The fields of a v3 `/toolkits` entry this module reads. */
interface ToolkitEntry {
  slug: string;
  name: string;
  meta?: { logo?: string; description?: string; categories?: { name?: string; id?: string }[] };
  composio_managed_auth_schemes?: unknown[];
  no_auth?: boolean;
}

interface ToolkitPage {
  items?: ToolkitEntry[];
  next_cursor?: string;
}

export async function catalog(): Promise<CatalogItem[]> {
  if (!composioEnabled()) return [];
  if (catalogCache && Date.now() - catalogCache.at < 3600_000) return catalogCache.items;
  const items: CatalogItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await rest<ToolkitPage>(`/toolkits?sort_by=usage&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const t of r.items ?? []) {
      items.push({
        slug: t.slug,
        name: t.name,
        logo: t.meta?.logo,
        description: t.meta?.description,
        categories: (t.meta?.categories ?? []).map((c) => (c.name ?? c.id) as string),
        managedAuth: (t.composio_managed_auth_schemes ?? []).length > 0,
        noAuth: !!t.no_auth,
      });
    }
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  catalogCache = { at: Date.now(), items };
  return items;
}

export async function toolkitInfo(slug: string): Promise<CatalogItem | undefined> {
  return (await catalog()).find((t) => t.slug === slug);
}

// ---------- per-user connections ----------

/** A v3 connected-account entry, in the fields this module reads. */
interface ConnectedAccountEntry {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  toolkitSlug?: string;
}

interface ConnectedAccountPage {
  items?: ConnectedAccountEntry[];
}

export async function connectedToolkits(userId: string): Promise<Set<string>> {
  if (!composioEnabled()) return new Set();
  const r = (await composio.connectedAccounts.list({ userIds: [userId], statuses: ['ACTIVE'] })) as unknown as ConnectedAccountPage;
  const items = r.items ?? [];
  return new Set(items.map((i) => i.toolkit?.slug ?? i.toolkitSlug).filter((s): s is string => Boolean(s)));
}

/** Every connected account of the user, whatever its status. An entry that names no app or status is dropped: nothing can act on it. */
export async function connectionsDetail(userId: string): Promise<ConnectionAccount[]> {
  if (!composioEnabled()) return [];
  const r = (await composio.connectedAccounts.list({ userIds: [userId] })) as unknown as ConnectedAccountPage;
  return (r.items ?? []).flatMap((i) => {
    const toolkit = i.toolkit?.slug ?? i.toolkitSlug;
    return toolkit && i.status ? [{ id: i.id, toolkit, status: i.status }] : [];
  });
}

/** Which of the user's apps are connected, and which need reconnecting because their sign-in expired. */
export const connectionHealthOf = async (userId: string): Promise<ConnectionHealth> => connectionHealth(await connectionsDetail(userId));

export async function disconnect(userId: string, toolkit: string) {
  for (const c of await connectionsDetail(userId)) {
    if (c.toolkit === toolkit) await composio.connectedAccounts.delete(c.id);
  }
  sessionCache.delete(userId);
}

// ---------- sessions (tool router) ----------

/** The slice of a Composio session this server calls; the SDK does not export its session type, so
 *  every value crossing that boundary is cast to this shape once. */
interface ComposioSession {
  sessionId: string;
  tools(): Promise<unknown[]>;
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
  authorize(toolkit: string, opts: { callbackUrl: string }): Promise<{ redirectUrl: string; id?: string }>;
}

const sessionCache = new Map<string, ComposioSession>();

export async function sessionFor(userId: string): Promise<ComposioSession> {
  const cached = sessionCache.get(userId);
  if (cached) return cached;
  const row = db.prepare('SELECT session_id FROM composio_sessions WHERE user_id=?').get(userId) as
    | { session_id: string }
    | undefined;
  let session: ComposioSession | null = null;
  if (row) {
    try {
      session = (await composio.use(row.session_id)) as unknown as ComposioSession;
    } catch {
      session = null;
    }
  }
  if (!session) {
    session = (await composio.create(userId, { manageConnections: false })) as unknown as ComposioSession;
    db.prepare('INSERT OR REPLACE INTO composio_sessions(user_id, session_id) VALUES (?,?)').run(userId, session.sessionId);
  }
  sessionCache.set(userId, session);
  return session;
}

/** Start a connect flow; returns the hosted Connect Link URL. */
export async function startConnect(userId: string, toolkit: string, callbackUrl: string): Promise<{ redirectUrl: string; connectedAccountId?: string }> {
  if (!composioEnabled()) throw new Error('Composio is not configured on this server (COMPOSIO_API_KEY missing).');
  const session = await sessionFor(userId);
  const req = await session.authorize(toolkit, { callbackUrl });
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** OpenAI-Responses-format function tools for this user's Composio session (meta tools). */
export async function composioTools(userId: string): Promise<unknown[]> {
  if (!composioEnabled()) return [];
  try {
    const session = await sessionFor(userId);
    const tools = await session.tools();
    return Array.isArray(tools) ? tools : [];
  } catch (e) {
    console.warn('[composio] tools unavailable', (e as Error).message);
    return [];
  }
}

export async function executeComposio(userId: string, name: string, args: Record<string, unknown>) {
  const session = await sessionFor(userId);
  const r = await session.execute(name, args);
  return r as { data?: unknown; error?: unknown; resultType?: string; logId?: string };
}

/** One app action inside a Composio call: its slug and the arguments it will run with. */
export interface InnerCall { slug: string; args: Record<string, unknown> }

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Which app actions a Composio call would run, with their arguments (for approval checks).
 * COMPOSIO_MULTI_EXECUTE_TOOL documents `tools: [{ tool_slug, arguments }]`; the router also accepts
 * `tool_params`, and older callers used `tool_calls` / `actions` / `slug`, so all of them are read.
 */
export function innerToolCalls(name: string, args: unknown): InnerCall[] {
  if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
    const a = asObject(args);
    const list = a.tools ?? a.tool_calls ?? a.actions ?? [];
    return (Array.isArray(list) ? list : []).flatMap((t) => {
      const o = asObject(t);
      const slug = String(o.tool_slug ?? o.slug ?? o.name ?? o.tool ?? '');
      return slug ? [{ slug, args: asObject(o.arguments ?? o.tool_params ?? o.args) }] : [];
    });
  }
  if (name.startsWith('COMPOSIO_')) return [];
  return [{ slug: name, args: asObject(args) }];
}

/** Which inner tool slugs a Composio meta-tool call would run (for approval checks). */
export const innerToolSlugs = (name: string, args: unknown): string[] => innerToolCalls(name, args).map((c) => c.slug);

export { isReadOnlySlug } from './domain/google-actions.js';

// ---------- sign-in via Composio-managed Google (Gmail) connection ----------

export async function startGoogleLogin(provisionalUserId: string, callbackUrl: string) {
  if (!composioEnabled()) throw new Error('Google sign-in via Composio is not available (COMPOSIO_API_KEY missing). Use the dev login instead.');
  const session = (await composio.create(provisionalUserId, { manageConnections: false })) as unknown as ComposioSession;
  const req = await session.authorize('gmail', { callbackUrl });
  return { redirectUrl: req.redirectUrl, connectedAccountId: req.id };
}

/** The Gmail profile fields read out of a proxied Google API response. */
interface GoogleProfileBody {
  emailAddress?: string;
  email?: string;
}

export async function googleProfile(connectedAccountId: string): Promise<{ email: string; name?: string }> {
  const r = (await composio.tools.proxyExecute({
    endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    method: 'GET',
    connectedAccountId,
  } as unknown as Parameters<typeof composio.tools.proxyExecute>[0])) as unknown as { data?: GoogleProfileBody } | GoogleProfileBody | undefined;
  const data = (r as { data?: GoogleProfileBody })?.data ?? (r as GoogleProfileBody | undefined);
  const email = data?.emailAddress ?? data?.email;
  if (!email) throw new Error(`Could not read Google profile: ${JSON.stringify(r).slice(0, 300)}`);
  return { email, name: undefined };
}

export async function deleteConnection(id: string) {
  try { await composio.connectedAccounts.delete(id); } catch { /* ignore */ }
}
