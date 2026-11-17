import { useEffect, useRef, useState } from 'react';
import { AUDIOCPP_VOICES, type AudiocppStatus, type Bot } from '@orbit/contracts';
import { useStore } from '../../store';
import { voiceApi, portraitUrl, type BotVoicePatch } from '../../voice/api';
import { PcmPlayer, createAudioContext } from '../../voice/audio';
import { Icon } from '../Icon';

/** `british_english_male` → "British English · male". */
export function voiceLabel(id: string): string {
  const m = id.match(/^(.*)_(female|male)$/);
  if (!m) return id;
  const lang = m[1].split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return `${lang} · ${m[2]}`;
}

const REASONS: Record<string, string> = {
  unreachable: 'the audio.cpp server isn’t answering',
  'server-error': 'the audio.cpp server reported an error',
  'models-missing': 'its models aren’t downloaded yet',
  downloading: 'its models are downloading',
  'models-not-loaded': 'the server isn’t configured with the speech models',
};

/** One line for the GPU row: ready, loading with progress, or why not. */
export function gpuLine(s: AudiocppStatus | null): string {
  if (!s) return 'Checking…';
  if (s.available) return s.avatar ? 'Ready · speech + avatar' : 'Ready · speech';
  if (s.download?.state === 'downloading') return `GPU voice loading… ${s.download.pct}%`;
  if (s.download?.state === 'error') return `Download failed${s.download.error ? ` — ${s.download.error}` : ''}`;
  return `Unavailable — ${REASONS[s.reason ?? ''] ?? s.reason ?? 'unknown'}`;
}

/** Poll every 5 s until the GPU voice is available (the first-run download can take minutes). */
export function useAudiocppStatus(): [AudiocppStatus | null, () => void] {
  const [status, setStatus] = useState<AudiocppStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    voiceApi.audiocppStatus().then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [tick]);
  const waiting = !!status && !status.available;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [waiting]);
  return [status, () => setTick((n) => n + 1)];
}

/**
 * The GPU voice controls under the Voice settings when a bot uses audio.cpp: the LFM3-Audio voice,
 * a preview, the portrait SoulX-FlashHead animates, and whether calls show it.
 */
export function AudiocppSettings({ bot, status, refresh, onError }: {
  bot: Bot;
  status: AudiocppStatus | null;
  refresh: () => void;
  onError: (msg: string | null) => void;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [bust, setBust] = useState(() => Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const voice = bot.audiocppVoice && AUDIOCPP_VOICES.includes(bot.audiocppVoice) ? bot.audiocppVoice : 'american_english_female';

  const applyBot = (saved: Bot | undefined, patch: Partial<Bot> = {}) =>
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id ? { ...b, ...patch, ...(saved ?? {}) } : b)) }));

  const save = async (patch: BotVoicePatch) => {
    const prev = useStore.getState().bots.find((b) => b.id === bot.id);
    applyBot(undefined, patch as Partial<Bot>);
    onError(null);
    try {
      const { bot: saved } = await voiceApi.saveBotVoice(bot.id, patch);
      applyBot(saved);
    } catch {
      if (prev) applyBot(prev);
      onError('Couldn’t save that setting.');
    }
  };

  const preview = async () => {
    if (previewing) return;
    setPreviewing(true); onError(null);
    const ctx = createAudioContext();
    const player = new PcmPlayer(ctx);
    try {
      const { pcm, rate } = await voiceApi.audiocppPreview({ botId: bot.id, voice, text: `Hi, I’m ${bot.name}. This is how I’ll sound on a call.` });
      const step = Math.round(rate * 0.1);
      for (let i = 0; i < pcm.length; i += step) player.push(pcm.subarray(i, i + step), rate);
      await player.whenIdle(30000);
    } catch (e) {
      onError((e as Error).message || 'Preview unavailable');
    } finally {
      player.dispose();
      void ctx.close().catch(() => {});
      setPreviewing(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (!file.type.startsWith('image/')) { onError('Choose an image file.'); return; }
    setUploading(true); onError(null);
    try {
      const { bot: saved } = await voiceApi.uploadPortrait(bot.id, file);
      applyBot(saved);
      setBust(Date.now());
    } catch (e) {
      onError((e as Error).message || 'Couldn’t upload that image');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    onError(null);
    try {
      const { bot: saved } = await voiceApi.deletePortrait(bot.id);
      applyBot(saved);
    } catch (e) {
      onError((e as Error).message || 'Couldn’t remove the portrait');
    }
  };

  const download = async () => {
    onError(null);
    try {
      const r = await voiceApi.downloadAudiocppModels();
      if (r.error) onError(r.error);
      refresh();
    } catch (e) {
      onError((e as Error).message || 'Couldn’t start the download');
    }
  };

  const pct = status?.download?.state === 'downloading' ? status.download.pct : null;
  const canDownload = !!status && !status.available && status.managed && status.download?.state !== 'downloading';

  return (
    <>
      <div className="panel-row panel-row--setting" data-state={status?.available ? 'ready' : 'unavailable'} title={status?.url}>
        <span>GPU voice</span>
        <span className="voice-setting__right" style={{ minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: status?.available ? undefined : 'var(--color-text-secondary)' }}>{gpuLine(status)}</span>
          {canDownload && <button type="button" className="voice-preview" onClick={() => void download()}>Download</button>}
        </span>
      </div>
      {pct !== null && (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="GPU model download progress" style={{ height: 4, margin: '2px 8px 6px', borderRadius: 2, background: '#1C1C1C14', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-ink)', transition: 'width 240ms linear' }} />
        </div>
      )}
      <div className="panel-row panel-row--setting">
        <span>Speaks as</span>
        <span className="voice-setting__right">
          <button type="button" className="voice-preview" onClick={() => void preview()} disabled={previewing || !status?.available} title={`Hear ${voiceLabel(voice)}`}>{previewing ? 'Playing…' : 'Preview'}</button>
          <span className="mini-select mini-select--native">
            <span>{voiceLabel(voice)}</span>
            <Icon name="chev_down" size={10} opacity={0.66} />
            <select aria-label="GPU speaking voice" value={voice} onChange={(e) => void save({ audiocppVoice: e.target.value })}>
              {AUDIOCPP_VOICES.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
            </select>
          </span>
        </span>
      </div>
      <div
        className={`panel-row panel-row--setting audiocpp-portrait${dragging ? ' is-dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files?.[0]); }}
        style={{ alignItems: 'center' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {bot.hasPortrait ? (
            <img src={portraitUrl(bot.id, bust)} alt={`${bot.name}'s portrait`} width={64} height={64} style={{ borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <span aria-hidden style={{ width: 64, height: 64, borderRadius: 10, border: '1px dashed var(--color-border-strong, #8888)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0, textAlign: 'center' }}>Drop a photo</span>
          )}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span>Portrait</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', whiteSpace: 'normal' }}>
              {status && !status.avatar ? 'This audio.cpp server has no avatar model.' : 'A face photo, animated while the bot speaks.'}
            </span>
          </span>
        </span>
        <span className="voice-setting__right">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void upload(e.target.files?.[0])} aria-label="Portrait image" />
          <button type="button" className="voice-preview" onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? 'Uploading…' : bot.hasPortrait ? 'Replace' : 'Upload'}</button>
          {bot.hasPortrait && <button type="button" className="voice-preview" onClick={() => void remove()} aria-label="Remove portrait">Remove</button>}
        </span>
      </div>
      {bot.hasPortrait && (
        <label className="panel-row panel-row--setting" style={{ cursor: 'pointer' }}>
          <span>Show animated avatar during calls</span>
          <input type="checkbox" checked={!!bot.avatarEnabled} onChange={(e) => void save({ avatarEnabled: e.target.checked })} aria-label="Show animated avatar during calls" />
        </label>
      )}
    </>
  );
}
