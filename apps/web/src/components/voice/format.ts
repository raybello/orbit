import type { VoiceModelItem } from '@orbit/contracts';

/** 64_104_260 → "64.1 MB", 359_719_088 → "360 MB". */
export function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  const mb = size / 1e6;
  return `${mb >= 100 ? Math.round(mb) : Number(mb.toFixed(1))} MB`;
}

/**
 * How a voice feels in a live call, from the measured real-time factors in
 * docs/voice-local-conventions.md: Piper 10–17× real time, Kokoro ~1×.
 */
export function latencyHint(m: Pick<VoiceModelItem, 'id'>): string {
  if (/piper/i.test(m.id)) return 'Fast';
  if (/kokoro/i.test(m.id)) return 'Best · slower';
  return '';
}

export const KIND_LABEL: Record<VoiceModelItem['kind'], string> = {
  stt: 'Speech recognition',
  vad: 'Voice activity detection',
  tts: 'Voices',
};
