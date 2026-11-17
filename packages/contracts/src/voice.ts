// On-device voice: the model inventory the server reports, and the one derivation every client and
// the server use to decide what a call can do with it. Pure, no runtime dependencies.
import type { VoiceModelStateValue, VoiceProvider } from './index.js';

export type VoiceModelKind = 'stt' | 'tts' | 'vad';

/**
 * `required` models (speech recognition, voice activity) are fetched automatically. `optional` ones
 * are the voices: the person picks which to install, and a call needs at least one of them.
 */
export type VoiceModelTier = 'required' | 'optional';

/** One row of the model inventory: `GET /api/voice/local/models` and `voices` in `/status`. */
export interface VoiceModelItem {
  id: string;
  kind: VoiceModelKind;
  name: string;
  /** The engine's rate: input for stt/vad, output for tts. */
  rate: number;
  /** Bytes the complete model takes on disk. */
  size: number;
  /** Bytes this model holds on disk right now, partial downloads included. */
  onDisk: number;
  state: VoiceModelStateValue;
  /** Download progress, 0 to 100; 100 when ready. */
  pct: number;
  tier: VoiceModelTier;
  /** One line of UI copy: what the model trades away. */
  note: string;
}

/** What a voice call for one bot can do right now. */
export type VoiceReadiness =
  | { status: 'cloud' }
  /** audio.cpp on a GPU: its own readiness is GET /api/voice/audiocpp/status, checked at call start. */
  | { status: 'audiocpp' }
  | { status: 'unsupported' }
  /** On-device is selected but a model it needs is not on disk and nothing is fetching it. */
  | { status: 'needs-model'; missing: VoiceModelKind[] }
  | { status: 'preparing'; pct: number }
  /** `voice` is the TTS model the call speaks with. */
  | { status: 'ready'; voice: string };

/**
 * The stored provider preference resolved to the one a call uses. Only an explicit `cloud` keeps
 * the cloud path and only an explicit `audiocpp` the GPU one; anything else, including a value that
 * was never set, means on-device.
 */
export function resolveVoiceProvider(stored: unknown): VoiceProvider {
  return stored === 'cloud' || stored === 'audiocpp' ? stored : 'local';
}

/** LFM3-Audio's 38 built-in TTS voices: `<language>_<female|male>`. */
export const AUDIOCPP_VOICE_LANGUAGES = [
  'american_english', 'british_english', 'arabic', 'chinese', 'danish', 'dutch', 'finnish', 'french', 'german', 'greek',
  'hebrew', 'italian', 'japanese', 'korean', 'polish', 'portuguese', 'spanish', 'swedish', 'turkish',
] as const;
export const AUDIOCPP_VOICES: string[] = AUDIOCPP_VOICE_LANGUAGES.flatMap((l) => [`${l}_female`, `${l}_male`]);
export const DEFAULT_AUDIOCPP_VOICE = 'american_english_female';

/** A stored voice id, or the default when it is not one of LFM3's voices. */
export function resolveAudiocppVoice(stored: unknown): string {
  return typeof stored === 'string' && AUDIOCPP_VOICES.includes(stored) ? stored : DEFAULT_AUDIOCPP_VOICE;
}

const average = (items: VoiceModelItem[]) =>
  items.length ? Math.round(items.reduce((n, m) => n + m.pct, 0) / items.length) : 0;

/**
 * The single readiness rule. `voiceModel` is the bot's chosen voice; when it is not installed the
 * call speaks with the first installed voice instead of failing.
 */
export function voiceReadiness(input: {
  provider: VoiceProvider;
  addon: boolean;
  models: VoiceModelItem[];
  voiceModel?: string;
}): VoiceReadiness {
  if (input.provider === 'cloud') return { status: 'cloud' };
  if (input.provider === 'audiocpp') return { status: 'audiocpp' };
  if (!input.addon) return { status: 'unsupported' };

  const voices = input.models.filter((m) => m.kind === 'tts');
  const required = input.models.filter((m) => m.tier === 'required');
  const installedVoices = voices.filter((m) => m.state === 'ready');
  const pendingRequired = required.filter((m) => m.state !== 'ready');

  if (installedVoices.length && !pendingRequired.length) {
    const chosen = installedVoices.find((m) => m.id === input.voiceModel) ?? installedVoices[0];
    return { status: 'ready', voice: chosen.id };
  }

  const fetchingVoices = voices.filter((m) => m.state === 'downloading');
  const fetching = [...pendingRequired.filter((m) => m.state === 'downloading'), ...(installedVoices.length ? [] : fetchingVoices)];
  const stalled = pendingRequired.some((m) => m.state !== 'downloading') || (!installedVoices.length && !fetchingVoices.length);
  if (fetching.length && !stalled) return { status: 'preparing', pct: average(fetching) };

  const missing = new Set<VoiceModelKind>();
  for (const m of pendingRequired) missing.add(m.kind);
  if (!installedVoices.length && !fetchingVoices.length) missing.add('tts');
  return { status: 'needs-model', missing: [...missing] };
}

/** No voice is installed or on its way: the person has to pick one before an on-device call. */
export function needsVoiceChoice(models: VoiceModelItem[]): boolean {
  return !models.some((m) => m.kind === 'tts' && (m.state === 'ready' || m.state === 'downloading'));
}
