#!/usr/bin/env node
// Regenerates apps/server/src/voice-model-files.ts from the Hugging Face file listings.
//
//   node scripts/voice-models-manifest.mjs
//
// The generated module is committed: the server downloads exactly that file list (with sizes and
// LFS sha256s) instead of asking Hugging Face at runtime, so a first run is deterministic and the
// download can be verified offline. Re-run this only when the model repos change.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STT_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20';
const TTS_REPO = 'csukuangfj/vits-piper-en_US-lessac-medium';
const STT_PICK = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt',
];
const TTS_PICK = ['en_US-lessac-medium.onnx', 'tokens.txt'];
/** Only the English espeak-ng data: the full tree is 355 files / 18 MB of unused dictionaries. */
const ESPEAK_KEEP = /^espeak-ng-data\/(phondata|phonindex|phontab|intonations|en_dict|lang\/|voices\/)/;
/** GitHub release asset, not on Hugging Face. */
const VAD = {
  name: 'silero_vad.onnx',
  kind: 'vad',
  repo: 'github:k2-fsa/sherpa-onnx/releases/asr-models',
  path: 'silero_vad.onnx',
  size: 643854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
};

async function listing(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}?blobs=true`);
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  const json = await res.json();
  return (json.siblings ?? []).map((f) => ({
    path: f.rfilename,
    size: f.size ?? 0,
    sha256: f.lfs?.oid ?? null,
  }));
}

const stt = await listing(STT_REPO);
const tts = await listing(TTS_REPO);

const files = [
  ...stt.filter((f) => STT_PICK.includes(f.path)).map((f) => ({ name: `stt-${f.path}`, kind: 'stt', repo: STT_REPO, ...f })),
  ...tts.filter((f) => TTS_PICK.includes(f.path)).map((f) => ({ name: `tts-${f.path}`, kind: 'tts', repo: TTS_REPO, ...f })),
  ...tts
    .filter((f) => ESPEAK_KEEP.test(f.path))
    .map((f) => ({ name: `espeak-${f.path.replace(/^espeak-ng-data\//, '')}`, kind: 'espeak', repo: TTS_REPO, ...f })),
  VAD,
];

const bytes = files.reduce((n, f) => n + f.size, 0);
const out = `// Generated from the Hugging Face file listings (sizes + LFS sha256) for the local voice models.
// Regenerate with scripts/voice-models-manifest.mjs rather than editing by hand.
export interface VoiceModelFile { name: string; kind: 'stt' | 'tts' | 'espeak' | 'vad'; repo: string; path: string; size: number; sha256: string | null }

export const VOICE_MODEL_FILES: VoiceModelFile[] = ${JSON.stringify(files, null, 1)};

export const VOICE_MODEL_BYTES = VOICE_MODEL_FILES.reduce((n, f) => n + f.size, 0);
`;

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/server/src/voice-model-files.ts');
writeFileSync(target, out);
console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB -> ${target}`);
