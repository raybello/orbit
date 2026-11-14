import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { useStore } from '../store';
import { voiceApi, type LocalVoiceStatus, type VoiceOptions } from '../voice/api';
import { PcmPlayer, RATE, createAudioContext } from '../voice/audio';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { Icon } from './Icon';

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

/** "Voice chat" section of the details panel: voice, speed, language (saved per bot), preview, start a call. */
export function VoiceSettings({ bot }: { bot: Bot }) {
  const [opts, setOpts] = useState<VoiceOptions>(FALLBACK);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalVoiceStatus | null>(null);
  const [localPhase, setLocalPhase] = useState<'loading' | 'ok' | 'gone'>('loading');
  const [downloading, setDownloading] = useState(false);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

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

  useEffect(() => loadLocal(true), [loadLocal]);

  // A download runs in the background on the server, so the only progress signal is the status call.
  const polling = downloading || (local ? modelBusy(local) : false);
  // The POST can return before the background job shows up in /status; require two quiet polls
  // before we stop polling, so the bar doesn't vanish on the first tick.
  const quietTicks = useRef(0);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      voiceApi.localStatus(true)
        .then((s) => {
          setLocal(s);
          setLocalPhase('ok');
          if (!downloading) return;
          if (modelBusy(s)) quietTicks.current = 0;
          else if (++quietTicks.current >= 2) setDownloading(false);
        })
        .catch(() => { /* keep the last known state; the next tick retries */ });
    }, 2000);
    return () => clearInterval(t);
  }, [polling, downloading]);

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

  const localReady = !!local && modelsReady(local);

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); setError(null);
    // Created inside the click so autoplay policy lets it play; the sample rate is whatever the
    // server produced (22 050 Hz on-device, 24 kHz cloud), never a hardcoded 24 kHz.
    const ctx = createAudioContext();
    const player = new PcmPlayer(ctx);
    try {
      let pcm: Int16Array;
      let rate: number | undefined;
      if (localReady) {
        ({ pcm, rate } = await voiceApi.localPreview({ text: `Hi, I’m ${bot.name}. This is how I’ll sound.`, speed: bot.voiceSpeed }));
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

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    quietTicks.current = 0;
    setError(null);
    try {
      const r = await voiceApi.downloadLocalModels();
      setLocal((s) => (s ? { ...s, models: r.state } : s));
      if (!r.started) { setDownloading(false); return; }
      // Pick up the server's progress right away instead of waiting a poll interval.
      voiceApi.localStatus(true).then((s) => { setLocal(s); setLocalPhase('ok'); }).catch(() => {});
    } catch (e) {
      setDownloading(false);
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
          : `Not downloaded (${Math.round(local.bytes.have / 1e6)} of ${Math.round(local.bytes.total / 1e6)} MB)`;

  return (
    <div className="panel-card">
      <div className="panel-row panel-row--setting">
        <span>Voice</span>
        <span className="voice-setting__right">
          <button type="button" className="voice-preview" onClick={preview} disabled={previewing} title={localReady ? 'Hear this device’s on-device voice' : `Hear ${bot.name}'s voice`}>{previewing ? 'Playing…' : 'Preview'}</button>
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
      {local && supported(local) && !modelsReady(local) && (downloading || modelBusy(local)) && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Model download progress" style={{ height: 4, margin: '2px 8px 6px', borderRadius: 2, background: '#1C1C1C14', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-ink)', transition: 'width 240ms linear' }} />
        </div>
      )}
      {local && supported(local) && !modelsReady(local) && (
        <button type="button" className="panel-row panel-row--action" onClick={download} disabled={downloading || modelBusy(local)}>
          <Icon name="arrow_down" size={14} opacity={0.56} /> {downloading || modelBusy(local) ? `Downloading ${pct}%` : 'Download on-device models · 263 MB'}
        </button>
      )}
      {error && <div className="voice-error">{error}</div>}
    </div>
  );
}
