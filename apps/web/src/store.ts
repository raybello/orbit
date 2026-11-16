import { create } from 'zustand';
import type { ActivityItem, Bot, ComputerState, LiveState, Routine, Row, ServerEvent, User } from '@orbit/contracts';
import { api } from './lib/api';
import { activityFromRow, activityPreview, botNameFor, mergeActivity, pruneSeen } from './domain/activity-feed';
import type { Transcript } from './domain/transcript-utils';

export type ModalKind = 'create' | 'search' | 'apps' | 'group' | 'team' | null;

interface State {
  user: User | null;
  devLogin: boolean;
  authChecked: boolean;

  bots: Bot[];
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  /** Navigation history: past bot ids (most recent last). */
  navHistory: string[];
  /** Navigation future: forward stack (most recent last). */
  navFuture: string[];
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
  /** Bumped when a group's membership changes, so cached member lists (counts, avatar stacks) refetch. */
  rosterVersion: number;
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
  /** Group chats the person muted: their unread badge and preview stay quiet. */
  mutedRooms: string[];

  checkAuth(): Promise<void>;
  loadBots(): Promise<void>;
  selectBot(id: string): void;
  goBack(): void;
  goForward(): void;
  updateUser(patch: Partial<User>): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
  toggleMuteRoom(id: string): void;
}

const LS_SELECTED = 'grokbot.selectedBot';
const LS_DETAILS = 'grokbot.detailsOpen';
const LS_MUTED = 'orbit.mutedRooms';
// Storage is blocked in private mode and in sandboxed frames: a failed read counts as unset and a
// failed write is dropped, so the store still works for the session.
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  authChecked: false,
  bots: [],
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  navHistory: [],
  navFuture: [],
  transcripts: {},
  routines: {},
  computer: null,
  recentActivity: [],
  activitySeen: {},
  connectionsVersion: 0,
  rosterVersion: 0,
  sseConnected: false,
  // Closed by default (Teams): the conversation takes the full width until asked otherwise.
  detailsOpen: lsGet(LS_DETAILS) === '1',
  modal: null,
  viewerOpen: false,
  viewerMode: 'watch',
  viewerHint: null,
  mutedRooms: (() => {
    try {
      const raw = JSON.parse(lsGet(LS_MUTED) ?? '[]');
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  })(),

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
    const changed = selectedBotId !== get().selectedBotId;
    // A chat deleted here or on another device must not linger as feed entries or a mute flag.
    const kept = new Set(bots.map((b) => b.id));
    const gone = new Set(get().bots.filter((b) => !kept.has(b.id)).map((b) => b.id));
    const pruned = gone.size
      ? { recentActivity: get().recentActivity.filter((a) => !gone.has(a.botId)), mutedRooms: get().mutedRooms.filter((id) => !gone.has(id)) }
      : {};
    if (pruned.mutedRooms) lsSet(LS_MUTED, JSON.stringify(pruned.mutedRooms));
    // A deleted last chat must clear the selection too, or the shell keeps pointing at a gone bot.
    set({ bots, live: liveMap, ...pruned, ...(selectedBotId ? {} : { selectedBotId: null }) });
    if (selectedBotId && (changed || !get().transcripts[selectedBotId])) {
      get().selectBot(selectedBotId);
    }
  },

  selectBot(id) {
    const prev = get().selectedBotId;
    if (prev && prev !== id) {
      set((s) => ({ navHistory: [...s.navHistory, prev].slice(-50), navFuture: [] }));
    }
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
        set((st) => ({ rosterVersion: st.rosterVersion + 1 }));
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

  goBack() {
    const { navHistory, selectedBotId } = get();
    if (!navHistory.length) return;
    const target = navHistory[navHistory.length - 1];
    const next = navHistory.slice(0, -1);
    if (selectedBotId) set((s) => ({ navFuture: [...s.navFuture, selectedBotId] }));
    set({ navHistory: next, selectedBotId: target });
    lsSet(LS_SELECTED, target);
    const t = get().transcripts[target];
    if (!t?.loaded) get().loadRows(target).catch(console.error);
    get().loadRoutines(target).catch(console.error);
    const bot = get().bots.find((b) => b.id === target);
    if (bot?.unread) api.markRead(target).catch(() => {});
  },

  goForward() {
    const { navFuture, selectedBotId } = get();
    if (!navFuture.length) return;
    const target = navFuture[navFuture.length - 1];
    const next = navFuture.slice(0, -1);
    if (selectedBotId) set((s) => ({ navHistory: [...s.navHistory, selectedBotId] }));
    set({ navFuture: next, selectedBotId: target });
    lsSet(LS_SELECTED, target);
    const t = get().transcripts[target];
    if (!t?.loaded) get().loadRows(target).catch(console.error);
    get().loadRoutines(target).catch(console.error);
    const bot = get().bots.find((b) => b.id === target);
    if (bot?.unread) api.markRead(target).catch(() => {});
  },

  updateUser(patch) {
    set((s) => ({ user: s.user ? { ...s.user, ...patch } : s.user }));
  },

  setModal(modal) { set({ modal }); },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    set(p);
  },

  toggleMuteRoom(id) {
    set((s) => {
      const next = s.mutedRooms.includes(id) ? s.mutedRooms.filter((x) => x !== id) : [...s.mutedRooms, id];
      lsSet(LS_MUTED, JSON.stringify(next));
      return { mutedRooms: next };
    });
  },
}));

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
