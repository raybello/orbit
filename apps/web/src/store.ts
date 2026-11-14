import { create } from 'zustand';
import type { ActivityItem, Bot, CardBody, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@orbit/contracts';
import { api } from './lib/api';

export type ModalKind = 'create' | 'search' | 'apps' | 'group' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  authChecked: boolean;

  bots: Bot[];
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Cross-bot feed of finished assistant messages, pending cards and turn status changes. Newest first. */
  recentActivity: ActivityItem[];
  /**
   * What has already been folded into `recentActivity`, keyed `row:<botId>:<seq>` (value: updatedSeq)
   * or `live:<botId>:<kind>:<turn stamp>`. Keeps a streamed row and a running turn from repeating.
   */
  activitySeen: Record<string, number>;
  /** Bumped on every `connections` event so open views can refetch. */
  connectionsVersion: number;
  sseConnected: boolean;

  detailsOpen: boolean;
  modal: ModalKind;
  viewerOpen: boolean;
  /** How the large computer view opens, and the mode it is in while open. */
  viewerMode: 'watch' | 'control';
  /** One line shown under the large computer view while the person is driving (e.g. a sign-in to finish). */
  viewerHint: string | null;

  checkAuth(): Promise<void>;
  loadBots(): Promise<void>;
  selectBot(id: string): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'grokbot.selectedBot';
const LS_DETAILS = 'grokbot.detailsOpen';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

// ---------- cross-bot activity feed ----------

/** How many feed entries we keep, and how long a preview line is. */
const ACTIVITY_LIMIT = 200;
const PREVIEW_CHARS = 110;
/** `activitySeen` is pruned past this many keys so it cannot grow without bound. */
const SEEN_LIMIT = 1000;

/** One line of preview text: whitespace collapsed, cut at ~110 characters. */
export function activityPreview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** What a pending card says in the feed, or null when it no longer needs anyone. */
export function cardPreview(body: CardBody): string | null {
  if (body.status !== 'pending') return null;
  switch (body.card) {
    case 'approval': return body.title;
    case 'question': return body.question;
    case 'connect': return `Connect ${body.toolkitName}`;
    case 'draft': return body.subject || `Draft ${body.channel} message to ${body.to}`;
  }
}

const botNameFor = (bots: Bot[], botId: string) => bots.find((b) => b.id === botId)?.name ?? botId;

/** Feed identity: one entry per row, one per turn status change. */
export const activityKey = (item: ActivityItem): string =>
  item.seq === undefined ? `live:${item.botId}:${item.kind}:${item.at}` : `row:${item.botId}:${item.seq}`;

/** Newest first, deduped against what is already there, capped at ACTIVITY_LIMIT. */
export function mergeActivity(prev: ActivityItem[], incoming: ActivityItem[], max = ACTIVITY_LIMIT): ActivityItem[] {
  if (incoming.length === 0) return prev;
  const keys = new Set(incoming.map(activityKey));
  return [...incoming, ...prev.filter((p) => !keys.has(activityKey(p)))]
    .sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0))
    .slice(0, max);
}

function pruneSeen(seen: Record<string, number>): Record<string, number> {
  const keys = Object.keys(seen);
  if (keys.length <= SEEN_LIMIT) return seen;
  const kept: Record<string, number> = {};
  for (const k of keys.slice(-Math.floor(SEEN_LIMIT / 2))) kept[k] = seen[k];
  return kept;
}

/** An assistant message that finished streaming, or a pending card — everything else stays out of the feed. */
function activityFromRow(row: Row, botName: string): ActivityItem | null {
  let preview: string | null = null;
  let kind: ActivityItem['kind'] | null = null;
  if (row.body.type === 'message') {
    if (row.body.role !== 'assistant' || row.body.streaming) return null;
    preview = activityPreview(row.body.text);
    kind = 'message';
  } else if (row.body.type === 'card') {
    const card = cardPreview(row.body);
    if (card) { preview = activityPreview(card); kind = 'card'; }
  }
  if (!preview || !kind) return null;
  return { botId: row.botId, botName, kind, preview, at: row.createdAt, seq: row.seq };
}

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  authChecked: false,
  bots: [],
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  recentActivity: [],
  activitySeen: {},
  connectionsVersion: 0,
  sseConnected: false,
  // Closed by default (Teams): the conversation takes the full width until asked otherwise.
  detailsOpen: lsGet(LS_DETAILS) === '1',
  modal: null,
  viewerOpen: false,
  viewerMode: 'watch',
  viewerHint: null,

  async checkAuth() {
    try {
      const { user, devLogin } = await api.me();
      set({ user, devLogin, authChecked: true });
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  async loadBots() {
    const { bots, live } = await api.bots();
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, live: liveMap });
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId);
    }
  },

  selectBot(id) {
    set({ selectedBotId: id });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    const bot = get().bots.find((b) => b.id === id);
    if (bot?.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const { generation, rows } = await api.rows(id);
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    const prev = get().transcripts[id];
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const { computer } = await api.computer();
    set({ computer });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  handleEvent(ev) {
    const s = get();
    switch (ev.type) {
      case 'hello':
      case 'ping':
        return;
      case 'rows':
        s.upsertRows(ev.botId, ev.generation, ev.rows);
        // Fold the same batch into the cross-bot feed. A row we already showed is only
        // replaced when its updatedSeq moved on, so streaming rewrites never duplicate.
        set((st) => {
          const seen = { ...st.activitySeen };
          const fresh: ActivityItem[] = [];
          for (const r of ev.rows) {
            const key = `row:${r.botId}:${r.seq}`;
            const shown = seen[key];
            if (shown !== undefined && shown >= r.updatedSeq) continue;
            const item = activityFromRow(r, botNameFor(st.bots, r.botId));
            if (!item) continue;
            seen[key] = r.updatedSeq;
            fresh.push(item);
          }
          if (fresh.length === 0) return {};
          return { recentActivity: mergeActivity(st.recentActivity, fresh), activitySeen: pruneSeen(seen) };
        });
        return;
      case 'cleared':
        set((st) => ({
          transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } },
          // Rows are gone, so their feed entries would open an empty chat.
          recentActivity: st.recentActivity.filter((a) => a.botId !== ev.botId),
        }));
        return;
      case 'live': {
        const prev = s.live[ev.state.botId];
        const state = ev.state;
        set((st) => ({ live: { ...st.live, [state.botId]: state } }));
        // A bot we have not heard from before counts as idle, so its first running tick is a flip.
        if ((prev?.isRunning ?? false) === state.isRunning) return;
        // One entry per turn: keyed by when the turn started, not by this tick.
        const turn = state.isRunning ? (state.startedAt ?? Date.now()) : (prev?.startedAt ?? state.startedAt ?? Date.now());
        const kind: ActivityItem['kind'] = state.isRunning ? 'working' : 'completed';
        const key = `live:${state.botId}:${kind}:${turn}`;
        set((st) => {
          if (st.activitySeen[key] !== undefined) return {};
          const detail = state.isRunning ? (state.activity?.detail ?? state.caption ?? null) : null;
          const item: ActivityItem = {
            botId: state.botId,
            botName: botNameFor(st.bots, state.botId),
            kind,
            preview: detail ? activityPreview(detail) : state.isRunning ? 'Working on it' : 'Finished working',
            at: Date.now(),
          };
          return {
            recentActivity: mergeActivity(st.recentActivity, [item]),
            activitySeen: pruneSeen({ ...st.activitySeen, [key]: turn }),
          };
        });
        return;
      }
      case 'activity':
        set((st) => ({
          recentActivity: mergeActivity(st.recentActivity, [
            { ...ev.item, botName: ev.item.botName || botNameFor(st.bots, ev.item.botId) },
          ]),
        }));
        return;
      case 'roster':
        s.loadBots().catch(console.error);
        return;
      case 'bot': {
        const exists = s.bots.some((b) => b.id === ev.bot.id);
        // Opening a bot marks it read; keep the open bot at 0 unread.
        if (ev.bot.id === s.selectedBotId && ev.bot.unread > 0 && document.visibilityState === 'visible') api.markRead(ev.bot.id).catch(() => {});
        set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...st.bots, ev.bot] }));
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'tasks':
      case 'memories':
        // Picked up by configStore.ts (Tasks view, Library/Tasks tabs, bot settings).
        window.dispatchEvent(new CustomEvent('grokbot:event', { detail: ev }));
        return;
      case 'connections':
        set((st) => ({ connectionsVersion: st.connectionsVersion + 1 }));
        return;
    }
  },

  setModal(modal) { set({ modal }); },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    set(p);
  },
}));

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
