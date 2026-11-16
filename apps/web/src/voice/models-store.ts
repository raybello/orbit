import { create } from 'zustand';
import { needsVoiceChoice, voiceReadiness, type Bot, type VoiceLocalStatus, type VoiceModelItem, type VoiceReadiness } from '@orbit/contracts';
import { useStore } from '../store';
import { voiceApi } from './api';

/**
 * The on-device model inventory, shared by the first-run chooser, the Voice models manager, the call
 * path and the call bar. One poller runs while anything downloads, so every view shows the same
 * progress and nothing polls twice.
 */
interface VoiceModelsState {
  status: VoiceLocalStatus | null;
  /** `gone`: this server has no on-device voice routes (or did not answer). */
  phase: 'loading' | 'ok' | 'gone';
  /** The voice picked in the first-run chooser; applied to the bots once it is installed. */
  pendingVoice: string | null;
  error: string | null;
}

export const useVoiceModels = create<VoiceModelsState>(() => ({ status: null, phase: 'loading', pendingVoice: null, error: null }));

const POLL_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<VoiceLocalStatus | null> | null = null;

const busy = (s: VoiceLocalStatus) => s.download.active || s.voices.some((m) => m.state === 'downloading');

function schedule(status: VoiceLocalStatus | null) {
  if (timer) clearTimeout(timer);
  timer = status && busy(status) ? setTimeout(() => void refreshVoiceModels(), POLL_MS) : null;
}

/** Read `/local/status` again. Never throws: a server without the routes reads as `gone`. */
export function refreshVoiceModels(): Promise<VoiceLocalStatus | null> {
  inflight ??= voiceApi.localStatus(true)
    .then((status) => {
      useVoiceModels.setState({ status, phase: 'ok' });
      void applyPendingVoice(status);
      schedule(status);
      return status;
    })
    .catch(() => {
      useVoiceModels.setState({ status: null, phase: 'gone' });
      schedule(null);
      return null;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Merge a fresh inventory from a mutation's response, then let the poller take over. */
function adopt(voices: VoiceModelItem[] | undefined) {
  const status = useVoiceModels.getState().status;
  if (status && voices) useVoiceModels.setState({ status: { ...status, voices } });
  void refreshVoiceModels();
}

async function run(what: string, op: () => Promise<{ items?: VoiceModelItem[] } | unknown>) {
  useVoiceModels.setState({ error: null });
  try {
    const r = (await op()) as { items?: VoiceModelItem[] } | undefined;
    adopt(r?.items);
  } catch {
    useVoiceModels.setState({ error: `Couldn’t ${what}.` });
    void refreshVoiceModels();
  }
}

export const downloadVoiceModel = (id: string, opts: { fresh?: boolean } = {}) =>
  run(opts.fresh ? 'redownload that model' : 'start that download', () => voiceApi.downloadLocalModel(id, opts));
/** Cancelling or deleting the voice picked at first run also drops that pick. */
const dropPending = (id: string) => {
  if (useVoiceModels.getState().pendingVoice === id) useVoiceModels.setState({ pendingVoice: null });
};
export const cancelVoiceModel = (id: string) => { dropPending(id); return run('cancel that download', () => voiceApi.cancelLocalModel(id)); };
export const deleteVoiceModel = (id: string) => { dropPending(id); return run('delete that model', () => voiceApi.deleteLocalModel(id)); };

/**
 * Point every bot at the chosen voice, on-device. It runs once the voice is installed, not when it
 * is picked, so a download that fails leaves a bot that was on the cloud still working.
 */
async function applyPendingVoice(status: VoiceLocalStatus) {
  const id = useVoiceModels.getState().pendingVoice;
  const item = id ? status.voices.find((m) => m.id === id) : undefined;
  if (!id || !item || item.state === 'downloading' || item.state === 'missing') return;
  useVoiceModels.setState({ pendingVoice: null });
  if (item.state !== 'ready') return;
  const bots = useStore.getState().bots.filter((b) => b.kind !== 'room');
  await Promise.all(bots.map(async (b) => {
    if (b.voiceProvider === 'local' && b.voiceModel === id) return;
    try {
      const { bot } = await voiceApi.saveBotVoice(b.id, { voiceProvider: 'local', voiceModel: id });
      useStore.setState((s) => ({ bots: s.bots.map((x) => (x.id === b.id ? { ...x, ...bot } : x)) }));
    } catch {
      useVoiceModels.setState({ error: `Couldn’t switch ${b.name} to on-device voice.` });
    }
  }));
}

/** First-run choice: download this voice, then make it every bot's on-device voice. */
export async function chooseVoice(id: string) {
  useVoiceModels.setState({ pendingVoice: id });
  await downloadVoiceModel(id);
}

// ---------- the first-run chooser's gate ----------

const LS_SETUP = 'orbit.voiceSetup';

export function voiceSetupDismissed(): boolean {
  try { return localStorage.getItem(LS_SETUP) === 'done'; } catch { return false; }
}

/** The chooser is shown once: picking a voice or skipping both close it for good. */
export function dismissVoiceSetup() {
  try { localStorage.setItem(LS_SETUP, 'done'); } catch { /* private mode: shows again next start */ }
}

/** Show the first-run chooser: the engine can run here and no voice is installed or on its way. */
export function voiceSetupDue(status: VoiceLocalStatus | null, dismissed: boolean): boolean {
  return !dismissed && !!status && status.runtime.addon && needsVoiceChoice(status.voices);
}

/** What a call with this bot can do right now, from the shared inventory. Null until it loads. */
export function readinessFor(bot: Pick<Bot, 'voiceProvider' | 'voiceModel'>, status: VoiceLocalStatus | null = useVoiceModels.getState().status): VoiceReadiness | null {
  if (bot.voiceProvider === 'cloud') return { status: 'cloud' };
  if (!status) return null;
  return voiceReadiness({ provider: 'local', addon: status.runtime.addon, models: status.voices, voiceModel: bot.voiceModel });
}

/** TEST-ONLY: forget the inventory and stop the poller. */
export function __resetVoiceModelsForTests() {
  if (timer) clearTimeout(timer);
  timer = null;
  inflight = null;
  useVoiceModels.setState({ status: null, phase: 'loading', pendingVoice: null, error: null });
}
