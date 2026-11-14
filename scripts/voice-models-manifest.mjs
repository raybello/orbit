#!/usr/bin/env node
// Regenerates apps/server/src/voice-model-files.ts from the Hugging Face file listings.
//
//   node scripts/voice-models-manifest.mjs
//
// The generated module is committed: the server downloads exactly that file list (with sizes and
// LFS sha256s) instead of asking Hugging Face at runtime, so a first run is deterministic and the
// download can be verified offline. Re-run this only when the model repos change.
//
// Every entry carries the `model` id it belongs to, because the cache is laid out as
// `<kind>/<model>/<path>` (docs/voice-local-conventions.md, phase-3 addendum). The four ids are the
// ones the runtime and the voice menu use; adding a model here means adding it to VOICE_MODELS in
// apps/server/src/voice-models.ts as well (id, rate, tier, engine).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STT_MODEL = 'zipformer-bilingual-int8';
const TTS_MODEL = 'piper-lessac-medium';
const VAD_MODEL = 'silero-vad';
const KOKORO_MODEL = 'kokoro-multi-lang';

const STT_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20';
const TTS_REPO = 'csukuangfj/vits-piper-en_US-lessac-medium';
const KOKORO_REPO = 'csukuangfj/kokoro-multi-lang-v1_0';
const STT_PICK = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.int8.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt',
];
const TTS_PICK = ['en_US-lessac-medium.onnx', 'tokens.txt'];
/** Kokoro: the four files sherpa-onnx's kokoro frontend needs (espeak-ng data is shared with Piper). */
const KOKORO_PICK = ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt'];
/** Only the English espeak-ng data: the full tree is 355 files / 18 MB of unused dictionaries. */
const ESPEAK_KEEP = /^espeak-ng-data\/(phondata|phonindex|phontab|intonations|en_dict|lang\/|voices\/)/;
/** GitHub release asset, not on Hugging Face. */
const VAD = {
  name: 'silero_vad.onnx',
  kind: 'vad',
  model: VAD_MODEL,
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
    // LFS files report their real size here; small non-LFS files report it at the top level.
    size: f.lfs?.size ?? f.size ?? 0,
    sha256: f.lfs?.sha256 ?? f.lfs?.oid ?? null,
  }));
}

const stt = await listing(STT_REPO);
const tts = await listing(TTS_REPO);
const kokoro = await listing(KOKORO_REPO);

const missing = [
  ...STT_PICK.filter((p) => !stt.some((f) => f.path === p)).map((p) => `${STT_REPO}/${p}`),
  ...TTS_PICK.filter((p) => !tts.some((f) => f.path === p)).map((p) => `${TTS_REPO}/${p}`),
  ...KOKORO_PICK.filter((p) => !kokoro.some((f) => f.path === p)).map((p) => `${KOKORO_REPO}/${p}`),
];
if (missing.length) throw new Error(`files no longer published: ${missing.join(', ')}`);

const files = [
  ...stt
    .filter((f) => STT_PICK.includes(f.path))
    .map((f) => ({ name: `stt-${f.path}`, kind: 'stt', model: STT_MODEL, repo: STT_REPO, ...f })),
  ...tts
    .filter((f) => TTS_PICK.includes(f.path))
    .map((f) => ({ name: `tts-${f.path}`, kind: 'tts', model: TTS_MODEL, repo: TTS_REPO, ...f })),
  ...tts
    .filter((f) => ESPEAK_KEEP.test(f.path))
    // The espeak-ng frontend belongs to Piper's model directory; Kokoro points at the same dataDir.
    .map((f) => ({ name: `espeak-${f.path.replace(/^espeak-ng-data\//, '')}`, kind: 'espeak', model: TTS_MODEL, repo: TTS_REPO, ...f })),
  ...kokoro
    .filter((f) => KOKORO_PICK.includes(f.path))
    .map((f) => ({ name: `kokoro-${f.path}`, kind: 'tts', model: KOKORO_MODEL, repo: KOKORO_REPO, ...f })),
  VAD,
];

const bytes = files.reduce((n, f) => n + f.size, 0);
const out = `// Generated from the Hugging Face file listings (sizes + LFS sha256) for the local voice models.
// Regenerate with scripts/voice-models-manifest.mjs rather than editing by hand.
export interface VoiceModelFile { name: string; kind: 'stt' | 'tts' | 'espeak' | 'vad'; /** The model this file belongs to; the cache path is <kind>/<model>/<path>. */ model: string; repo: string; path: string; size: number; sha256: string | null }

export const VOICE_MODEL_FILES: VoiceModelFile[] = ${JSON.stringify(files, null, 1)};

export const VOICE_MODEL_BYTES = VOICE_MODEL_FILES.reduce((n, f) => n + f.size, 0);
`;

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps/server/src/voice-model-files.ts');
writeFileSync(target, out);
const perModel = new Map();
for (const f of files) perModel.set(f.model, (perModel.get(f.model) ?? 0) + f.size);
console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB total -> ${target}`);
for (const [model, size] of perModel) console.log(`  ${model}: ${(size / 1e6).toFixed(1)} MB`);
