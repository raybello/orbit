import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { Bot } from '@orbit/contracts';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { voiceApi, type LocalModels, type LocalVoiceStatus, type VoiceOptions } from '../voice/api';
import { PcmPlayer, RATE, createAudioContext } from '../voice/audio';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useVoiceModels } from '../voice/models-store';
import { Icon } from './Icon';
import { formatSize, latencyHint } from './voice/format';

const FALLBACK: VoiceOptions = {
  voices: ['ara', 'eve', 'leo', 'luna', 'rex', 'sal'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  languages: [{ code: 'auto', name: 'Auto-detect' }, { code: 'en', name: 'English' }],
  speeds: [0.7, 0.85, 1, 1.15, 1.3, 1.5],
};

const speedLabel = (s: number) => `${Number(s.toFixed(2))}x`;

/** STT + TTS on disk: dictation and preview can both run on this machine. */
const modelsReady = (s: LocalVoiceStatus) => s.models.stt === 'ready' && s.models.tts === 'ready';
const modelBusy = (s: LocalVoiceStatus) =>
  s.download.active || s.models.stt === 'downloading' || s.models.tts === 'downloading' || s.models.vad === 'downloading';

/**
 * Can this machine run speech locally at all? `available` alone is not enough: the server also answers
 * `available: false, reason: 'models-missing'` while the 263 MB are not on disk, and that is a
 * downloadable state, not an unsupported one. The addon flag is the honest runtime signal.
 */
const supported = (s: LocalVoiceStatus) => s.available || s.runtime.addon;

const REASONS: Record<string, string> = {
  'unsupported-runtime': 'this build can’t load the speech engine',
  'models-missing': 'models not downloaded',
};
/** The server sends a code; show the ones we know as prose and fall back to whatever it said. */
const reasonText = (r: string | undefined) => (r ? (REASONS[r] ?? r) : 'not available here');

/** 22 050 → "22.05 kHz", 24 000 → "24 kHz": the rate the engine really produces, never resampled. */
function formatRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '';
  return `${Number((rate / 1000).toFixed(2))} kHz`;
}

function NativeSelect<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const current = options.find((o) => o.value === value)?.label ?? String(value);
  return (
    <span className="mini-select mini-select--native">
      <span>{current}</span>
      <Icon name="chev_down" size={10} opacity={0.66} />
      <select
        aria-label={label}
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </span>
  );
}

export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalVoiceStatus | null>(null);
  const [localPhase, setLocalPhase] = useState<'loading' | 'ok' | 'gone'>('loading');
  const [menu, setMenu] = useState<LocalModels | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);
  /**
   * The shared store's last error for this bot. It carries the "went to the cloud instead" notice
   * that call.ts sets when a bot wants on-device but this server can't do it, so it is actionable
   * right here in the panel instead of only in the call bar.
   */
  const callError = useVoice((s) => (s.botId === bot.id ? s.error : null));

  useEffect(() => { voiceApi.options().then(setOpts).catch(() => {}); }, []);
  useEffect(() => setError(null), [bot.id]);

  const loadLocal = useCallback((refresh: boolean) => {
    let alive = true;
    voiceApi.localStatus(refresh)
      .then((s) => { if (alive) { setLocal(s); setLocalPhase('ok'); } })
      // A server without the local routes (or offline) must leave the cloud controls alone.
      .catch(() => { if (alive) { setLocal(null); setLocalPhase('gone'); } });
    return () => { alive = false; };
  }, []);

  // The Voice models manager and the first-run chooser change the inventory through the shared
  // store; re-read this panel's copy whenever a model there changes state.
  const inventory = useVoiceModels((s) => s.status?.voices.map((m) => `${m.id}:${m.state}`).join() ?? '');
  useEffect(() => loadLocal(true), [loadLocal, inventory]);

  // The menu is a separate call from the status: it carries per-model size, rate and state.
  useEffect(() => {
    let alive = true;
    voiceApi.localModels(true)
      .then((m) => { if (alive) setMenu(m); })
      .catch(() => { /* older server: no menu, the picker stays empty */ });
    return () => { alive = false; };
  }, [inventory]);

  // A download runs in the background on the server, so the only progress signal is the status call.
  const polling = local ? modelBusy(local) : false;
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      voiceApi.localStatus(true)
        .then((s) => { setLocal(s); setLocalPhase('ok'); })
        .catch(() => { /* keep the last known state; the next tick retries */ });
    }, 2000);
    return () => clearInterval(t);
  }, [polling]);

  // One model's download: poll the menu every 2 s until that model says `ready` (or fails), because
  // `/status` only reports kind-level state and would hide an optional voice's completion.
  useEffect(() => {
    if (!watching) return;
    const t = setInterval(() => {
      voiceApi.localModels(true)
        .then((m) => {
          setMenu(m);
          const item = m.items.find((x) => x.id === watching);
          if (!item || item.state === 'ready' || item.state === 'error') {
            setWatching(null);
            if (item?.state === 'error') setError(`Couldn’t download ${item.name}.`);
          }
        })
        .catch(() => { /* next tick retries */ });
    }, 2000);
    return () => clearInterval(t);
  }, [watching]);

  const save = async (patch: Partial<Pick<Bot, 'voice' | 'voiceSpeed' | 'voiceLanguage'>>) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    // Optimistic; the server's `bot` event confirms.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const res = await fetch(`/api/bots/${bot.id}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voice: prev.voice, voiceSpeed: prev.voiceSpeed, voiceLanguage: prev.voiceLanguage } : b)) }));
      setError('Couldn’t save that setting.');
    }
  };

  /**
   * The voice *pipeline* choice (Cloud / On-device) and the on-device model id. Optimistic, rolled
   * back to the previous values if the PATCH fails; the server returns the row it stored.
   */
  const saveVoice = async (patch: { voiceProvider?: 'cloud' | 'local'; voiceModel?: string }) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch } : b)) }));
    setError(null);
    try {
      const { bot: saved } = await voiceApi.saveBotVoice(bot.id, patch);
      if (saved) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch, ...saved } : b)) }));
    } catch {
      if (prev) useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, voiceProvider: prev.voiceProvider, voiceModel: prev.voiceModel } : b)) }));
      setError('Couldn’t save that voice.');
    }
  };

  const localReady = !!local && modelsReady(local);

  const provider = bot.voiceProvider ?? 'cloud';
  // The toggle is only usable where the server can actually load the engine. `available:false` with
  // `models-missing` is recoverable (the picker below downloads it), so it stays enabled.
  const onDeviceBlocked = !local || !supported(local);
  const blockedWhy = !local ? (localPhase === 'gone' ? 'not available on this server' : 'checking this device…') : reasonText(local.reason);

  const ttsModels = (menu?.items ?? []).filter((m) => m.kind === 'tts');
  const chosenModel = ttsModels.find((m) => m.id === bot.voiceModel);
  // A bot can hold a model that is not on disk (downloaded elsewhere, or removed since). Never
  // preview it on-device: the server answers 409, so fall back to the cloud voice instead.
  const chosenReady = !chosenModel || chosenModel.state === 'ready';
  // Preview follows the bot's own provider, the same rule the call uses: a bot set to Cloud previews
  // its cloud voice even when the on-device models are on disk, and a bot set to On-device previews
  // the picker's model (falling back to the cloud voice only when that model is not downloaded).
  const useLocalPreview = provider === 'local' && localReady && chosenReady;

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    // Created inside the click so autoplay policy lets it play; the sample rate is whatever the
    // server produced for the chosen engine (22 050 Piper, 24 000 Kokoro, 24 kHz cloud).
    const ctx = createAudioContext();
    const player = new PcmPlayer(ctx);
    try {
      let pcm: Int16Array;
      let rate: number | undefined;
      if (useLocalPreview) {
        ({ pcm, rate } = await voiceApi.localPreview({ text: `Hi, I’m ${bot.name}. This is how I’ll sound.`, speed: bot.voiceSpeed, model: bot.voiceModel }));
      } else {
        pcm = await voiceApi.preview({ botId: bot.id, voice: bot.voice, speed: bot.voiceSpeed, language: bot.voiceLanguage });
      }
      // Feed it in 100 ms chunks, like realtime deltas.
      const step = Math.max(1, Math.round((rate ?? RATE) * 0.1));
      for (let i = 0; i < pcm.length; i += step) player.push(pcm.subarray(i, i + step), rate);
      await player.whenIdle(30000);
    } catch (e) {
      setError((e as Error).message || 'Preview unavailable');
    } finally {
      player.dispose();
      void ctx.close().catch(() => {});
      setPreviewing(false);
    }
  };

  const downloadVoice = async (id: string) => {
    if (watching === id) return;
    setError(null);
    setWatching(id);
    try {
      const r = await voiceApi.downloadLocalModel(id);
      const state = r.states?.[id];
      setMenu((m) => (m ? { ...m, items: m.items.map((x) => (x.id === id ? { ...x, state: state ?? 'downloading' } : x)) } : m));
      if (!r.started) {
        // Already complete: nothing to watch, just re-read the menu.
        setWatching(null);
        voiceApi.localModels(true).then(setMenu).catch(() => {});
      }
    } catch (e) {
      setWatching(null);
      setError((e as Error).message || 'Couldn’t start the download');
    }
  };

  const voices = opts.voices.some((v) => v.id === bot.voice) ? opts.voices : [{ id: bot.voice, name: bot.voice }, ...opts.voices];
  const speeds = opts.speeds.includes(bot.voiceSpeed) ? opts.speeds : [...opts.speeds, bot.voiceSpeed].sort((a, b) => a - b);

  const pct = Math.max(0, Math.min(100, Math.round(local?.download.pct ?? 0)));
  const localLine = !local
    ? 'Checking…'
    : !supported(local)
      ? `Not supported — ${reasonText(local.reason)}`
      : modelBusy(local)
        ? `Downloading ${pct}%`
        : modelsReady(local)
          ? 'Ready'
          : local.models.stt === 'ready' && local.models.vad === 'ready'
            ? 'Needs a voice model'
            : `Not downloaded (${Math.round(local.bytes.have / 1e6)} of ${Math.round(local.bytes.total / 1e6)} MB)`;

  const seg = (active: boolean): CSSProperties => ({
    background: active ? 'var(--accent-500)' : 'transparent',
    color: active ? 'var(--color-fg-on-accent)' : undefined,
    border: 'none',
    opacity: active ? 1 : undefined,
  });

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <span className="voice-setting__right">
          <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={useLocalPreview ? 'Hear this device’s on-device voice' : `Hear ${bot.name}'s voice`}>{previewing ? 'Playing…' : 'Preview'}</button>
          <NativeSelect label="Voice" value={bot.voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={(voice) => save({ voice })} />
        </span>
      </div>
      <div className="panel-row panel-row--setting">
        <span>Speed</span>
        <NativeSelect label="Speed" value={bot.voiceSpeed} options={speeds.map((s) => ({ value: s, label: speedLabel(s) }))} onChange={(voiceSpeed) => save({ voiceSpeed })} />
      </div>
      <div className="panel-row panel-row--setting">
        <span>Language</span>
        <NativeSelect label="Language" value={bot.voiceLanguage} options={opts.languages.map((l) => ({ value: l.code, label: l.name }))} onChange={(voiceLanguage) => save({ voiceLanguage })} />
      </div>
      <button type="button" className={`panel-row panel-row--action panel-row--call${inCall ? ' is-active' : ''}`} onClick={() => (inCall ? endCall() : startCall(bot.id))}>
        <Icon name="voice_a" size={14} opacity={inCall ? 1 : 0.56} /> {inCall ? 'End voice chat' : 'Start voice chat'}
      </button>
      {localPhase !== 'gone' && (
        <div className="panel-row panel-row--setting" title={local && supported(local) ? `Speech runs on this machine (${local.runtime.platform}/${local.runtime.arch}, ${local.runtime.provider})` : local ? reasonText(local.reason) : undefined}>
          <span>On-device</span>
          <span className="voice-setting__right" style={{ minWidth: 0 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: local && supported(local) ? undefined : 'var(--color-text-secondary)' }}>{localLine}</span>
          </span>
        </div>
      )}
      {localPhase !== 'gone' && (
        <div className="panel-row panel-row--setting" data-state={onDeviceBlocked ? 'unavailable' : provider} data-provider={provider}>
          <span>Voice calls</span>
          <span className="voice-setting__right" role="group" aria-label="Voice provider" style={{ gap: 2, padding: 2, borderRadius: 8, background: 'var(--color-bg-hover)' }}>
            <button
              type="button"
              className="voice-preview"
              aria-label="Cloud voice"
              aria-pressed={provider === 'cloud'}
              data-state={provider === 'cloud' ? 'active' : 'idle'}
              style={seg(provider === 'cloud')}
              title="Speak through the cloud voice service"
              onClick={() => { if (provider !== 'cloud') void saveVoice({ voiceProvider: 'cloud' }); }}
            >Cloud</button>
            <button
              type="button"
              className="voice-preview"
              aria-label="On-device voice"
              aria-pressed={provider === 'local'}
              data-state={onDeviceBlocked ? 'disabled' : provider === 'local' ? 'active' : 'idle'}
              style={seg(provider === 'local' && !onDeviceBlocked)}
              disabled={onDeviceBlocked}
              title={onDeviceBlocked ? `On-device voice isn’t available — ${blockedWhy}` : 'Speak in this server, with no cloud voice service'}
              onClick={() => { if (!onDeviceBlocked && provider !== 'local') void saveVoice({ voiceProvider: 'local' }); }}
            >On-device</button>
          </span>
        </div>
      )}
      {local && onDeviceBlocked && (
        <div className="panel-row panel-row--setting" data-state="reason" title={`On-device voice isn’t available — ${blockedWhy}`}>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'normal' }}>On-device voice is off: {blockedWhy}.</span>
        </div>
      )}
      {local && supported(local) && ttsModels.map((m) => {
        const ready = m.state === 'ready';
        const chosen = bot.voiceModel === m.id;
        const busy = watching === m.id || m.state === 'downloading';
        const detail = [formatRate(m.rate), formatSize(m.size), latencyHint(m)].filter(Boolean).join(' · ');
        return (
          <div key={m.id} className="panel-row panel-row--setting" data-model-id={m.id} data-state={m.state} data-selected={chosen ? 'true' : 'false'} style={{ alignItems: 'flex-start' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: ready ? 'pointer' : 'default' }} title={ready ? `Speak with ${m.name}` : `${m.name} isn’t downloaded yet`}>
                <input
                  type="radio"
                  name={`orbit-voice-model-${bot.id}`}
                  value={m.id}
                  aria-label={`Use ${m.name}`}
                  checked={chosen}
                  disabled={!ready}
                  onChange={() => { if (ready && !chosen) void saveVoice({ voiceModel: m.id }); }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
              </label>
              {/* Second line: the metadata has its own row so a 350 px details panel never clips it. */}
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingLeft: 22 }} title={detail}>{detail}</span>
            </span>
            <span className="voice-setting__right" style={{ minWidth: 0 }}>
              {!ready && (
                <button
                  type="button"
                  className="voice-preview"
                  aria-label={`Download ${m.name}`}
                  data-state={busy ? 'downloading' : 'idle'}
                  onClick={() => void downloadVoice(m.id)}
                  disabled={busy}
                >{busy ? `${Math.round(Math.max(0, Math.min(100, m.pct)))}%` : 'Download'}</button>
              )}
            </span>
          </div>
        );
      })}
      {local && supported(local) && !modelsReady(local) && modelBusy(local) && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Model download progress" style={{ height: 4, margin: '2px 8px 6px', borderRadius: 2, background: '#1C1C1C14', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-ink)', transition: 'width 240ms linear' }} />
        </div>
      )}
      {local && supported(local) && (
        <button type="button" className="panel-row panel-row--action" onClick={() => useConfigUI.getState().openVoiceModels()}>
          <Icon name="arrow_down" size={14} opacity={0.56} /> Voice models…
        </button>
      )}
      {error && <div className="voice-error">{error}</div>}
      {!error && callError && <div className="voice-error" data-state="call">{callError}</div>}
    </div>
  );
}
