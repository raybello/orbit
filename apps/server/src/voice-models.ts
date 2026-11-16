/**
 * Model cache manager for the on-device voice stack: the model registry the voice menu is built
 * from, a resumable checksum-verified downloader over the generated file list in
 * voice-model-files.ts (254 files, 623 MB with the optional tier), the phase-1/2 layout migration,
 * and the state the UI polls.
 *
 * Layout (docs/voice-local-conventions.md, phase-3 addendum):
 *
 *   voice-models/
 *     stt/zipformer-bilingual-int8/{encoder-epoch-99-avg-1.int8.onnx, decoder-…, joiner-…, tokens.txt}
 *     tts/piper-lessac-medium/{en_US-lessac-medium.onnx, tokens.txt, espeak-ng-data/**}
 *     tts/kokoro-multi-lang/{model.onnx, voices.bin, tokens.txt, lexicon-us-en.txt}
 *     vad/silero-vad/silero_vad.onnx
 *     .state.json          { verifiedAt, files: { name: sha256 }, errors: { model: message } }
 *
 * `<kind>/<model>/<path>`, one directory per model, because there are now two TTS tiers and a flat
 * `tts/` cannot hold both tokens.txt files. The phase-1/2 flat layout is migrated in place on first
 * touch (see migrateLayout), which is why an upgraded install does not re-download 263 MB.
 *
 * Three rules that matter:
 *  - A download runs in the background and NEVER rejects at its caller. A failure is recorded as an
 *    `error` state with a message, so a phone on hotel wifi sees the reason in `/local/status`
 *    instead of a crashed request.
 *  - Files are written as `<dest>.part` and renamed only after their sha256 matches, so a reader can
 *    never load a half-written ONNX file.
 *  - Speech recognition and VAD are required and fetched automatically. Voices are the person's
 *    choice: none is fetched implicitly, and a call needs at least one (see voiceReadiness).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { VOICE_MODEL_FILES, type VoiceModelFile } from './voice-model-files.js';
import { voiceReadiness, type VoiceModelItem, type VoiceModelState, type VoiceModelStateValue } from '@orbit/contracts';

export type VoiceKind = 'stt' | 'tts' | 'vad';
/** The three groups `/status` reports. espeak-ng data belongs to TTS and lives under tts/. */
export const VOICE_KINDS: VoiceKind[] = ['stt', 'tts', 'vad'];

export type VoiceModelId = 'zipformer-bilingual-int8' | 'silero-vad' | 'piper-lessac-medium' | 'kokoro-multi-lang';
export type VoiceTier = 'required' | 'optional';
/** Which sherpa-onnx frontend loads the model. */
export type VoiceEngineKind = 'zipformer' | 'silero' | 'vits' | 'kokoro';

export interface VoiceModelSpec {
  id: VoiceModelId;
  kind: VoiceKind;
  name: string;
  engine: VoiceEngineKind;
  /**
   * The rate the engine itself reports: the *input* rate for stt/vad, the *output* rate for tts.
   * The server never resamples TTS output, so this is what `X-Audio-Rate` carries.
   */
  rate: number;
  tier: VoiceTier;
  /** One line of UI copy: what the tier trades away. */
  note: string;
}

/**
 * The voice menu. Required models are fetched automatically; the voices (the optional tier) are
 * downloaded on demand from `POST /local/models/download { model }`.
 */
export const VOICE_MODELS: VoiceModelSpec[] = [
  {
    id: 'zipformer-bilingual-int8',
    kind: 'stt',
    name: 'Zipformer bilingual (zh + en, int8)',
    engine: 'zipformer',
    rate: 16000,
    tier: 'required',
    note: 'Streaming speech recognition; the only recogniser in the set.',
  },
  {
    id: 'silero-vad',
    kind: 'vad',
    name: 'Silero VAD',
    engine: 'silero',
    rate: 16000,
    tier: 'required',
    note: 'Voice activity detection for turn taking.',
  },
  {
    id: 'piper-lessac-medium',
    kind: 'tts',
    name: 'Piper lessac-medium',
    engine: 'vits',
    rate: 22050,
    tier: 'optional',
    note: 'Fast and clear: 10–17× real-time, ~200 ms to first audio.',
  },
  {
    id: 'kokoro-multi-lang',
    kind: 'tts',
    name: 'Kokoro multi-lang (54 voices)',
    engine: 'kokoro',
    rate: 24000,
    tier: 'optional',
    note: 'More natural, 54 speakers, but only ~1× real-time: replies render about as fast as they play.',
  },
];

const MODEL_BY_ID = new Map<string, VoiceModelSpec>(VOICE_MODELS.map((m) => [m.id, m]));

/** The voice a bot starts with, and the one a kind-level `{ kind: 'tts' }` download fetches. */
export const DEFAULT_TTS_MODEL: VoiceModelId = 'piper-lessac-medium';
export const TTS_MODELS: VoiceModelSpec[] = VOICE_MODELS.filter((m) => m.kind === 'tts');
export const REQUIRED_MODELS: VoiceModelSpec[] = VOICE_MODELS.filter((m) => m.tier === 'required');

/** The model a kind-level request means (tts → the default voice, never Kokoro). */
export const REQUIRED_MODEL_FOR: Record<VoiceKind, VoiceModelId> = {
  stt: 'zipformer-bilingual-int8',
  tts: 'piper-lessac-medium',
  vad: 'silero-vad',
};

export function modelSpec(id: string): VoiceModelSpec | undefined {
  return MODEL_BY_ID.get(id);
}

export function isVoiceModelId(id: unknown): id is VoiceModelId {
  return typeof id === 'string' && MODEL_BY_ID.has(id);
}

export function ttsModel(id: string): VoiceModelSpec | undefined {
  const spec = MODEL_BY_ID.get(id);
  return spec?.kind === 'tts' ? spec : undefined;
}

const FILES_BY_MODEL = new Map<string, VoiceModelFile[]>();
for (const f of VOICE_MODEL_FILES) {
  const list = FILES_BY_MODEL.get(f.model) ?? [];
  list.push(f);
  FILES_BY_MODEL.set(f.model, list);
}

/** Every listed file of one model, in manifest order. */
export function filesForModel(id: string): VoiceModelFile[] {
  return FILES_BY_MODEL.get(id) ?? [];
}

/**
 * Both voices phonemise with the espeak-ng data, which the manifest lists under Piper. Kokoro ships
 * no copy, so a Kokoro-only install still needs these files on disk.
 */
const ESPEAK_FILES = VOICE_MODEL_FILES.filter((f) => f.kind === 'espeak');

/** Every file a model needs to load: its own, plus the shared espeak-ng data for a voice. */
export function filesNeededBy(id: string): VoiceModelFile[] {
  const own = filesForModel(id);
  if (MODEL_BY_ID.get(id)?.kind !== 'tts') return own;
  return [...own.filter((f) => f.kind !== 'espeak'), ...ESPEAK_FILES];
}

/** Files more than one model needs. */
const SHARED_FILES = (() => {
  const users = new Map<string, number>();
  for (const spec of VOICE_MODELS) for (const f of filesNeededBy(spec.id)) users.set(f.name, (users.get(f.name) ?? 0) + 1);
  return new Set([...users].filter(([, n]) => n > 1).map(([name]) => name));
})();

/** The required files of a kind (for tts that is Piper's files, espeak-ng data included). */
export function filesForKind(kind: VoiceKind): VoiceModelFile[] {
  return filesNeededBy(REQUIRED_MODEL_FOR[kind]);
}

export function modelSize(id?: string): number {
  if (id === undefined) return REQUIRED_BYTES;
  return filesNeededBy(id).reduce((n, f) => n + f.size, 0);
}

const KIND_DIR: Record<VoiceModelFile['kind'], VoiceKind> = { stt: 'stt', tts: 'tts', espeak: 'tts', vad: 'vad' };

export interface VoiceDownloadProgress {
  /** Bytes of the requested set already on disk (verified or written this run). */
  done: number;
  total: number;
  pct: number;
  /** `<model>/<path>` of the file currently being written, or null between files. */
  name: string | null;
  fileDone: number;
  fileTotal: number;
}

export interface VoiceDownloadResult {
  ok: boolean;
  error?: string;
  downloaded: number;
  skipped: number;
  bytes: number;
}

interface StateFile {
  verifiedAt: number;
  files: Record<string, string>;
  errors?: Record<string, { at: number; message: string }>;
}

// ---------- paths & state ----------

export function modelsRoot(): string {
  return env.voiceModelsDir;
}

/**
 * Absolute destination for one listed file: `<root>/<kind>/<model>/<path>`.
 *
 * `espeak` files are TTS files (they are Piper's frontend data) and go under tts/, in the model
 * directory of the model that owns them.
 */
export function destFor(file: VoiceModelFile, root = modelsRoot()): string {
  return path.join(root, KIND_DIR[file.kind], file.model, file.path);
}

export function modelFilePath(id: string, relPath: string, root = modelsRoot()): string {
  const file = filesForModel(id).find((f) => f.path === relPath);
  if (!file) throw new Error(`${id} has no file ${relPath}`);
  return destFor(file, root);
}

const statePath = (root = modelsRoot()) => path.join(root, '.state.json');

let stateCache: { at: number; path: string; value: StateFile } | null = null;

function readState(root = modelsRoot()): StateFile {
  if (stateCache && stateCache.path === statePath(root) && Date.now() - stateCache.at < 1000) return stateCache.value;
  let value: StateFile = { verifiedAt: 0, files: {}, errors: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(root), 'utf8')) as Partial<StateFile>;
    value = { verifiedAt: Number(parsed.verifiedAt ?? 0), files: parsed.files ?? {}, errors: parsed.errors ?? {} };
  } catch {
    // No state file yet (a cache copied from another machine has none): size checks still work.
  }
  stateCache = { at: Date.now(), path: statePath(root), value };
  return value;
}

function writeState(next: StateFile, root = modelsRoot()): void {
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(statePath(root), `${JSON.stringify(next, null, 1)}\n`);
    stateCache = { at: Date.now(), path: statePath(root), value: next };
  } catch (e) {
    console.warn('[voice-models] could not write .state.json:', (e as { message?: string })?.message);
  }
}

function recordError(model: string, message: string): void {
  const state = readState();
  writeState({ ...state, errors: { ...state.errors, [model]: { at: Date.now(), message: message.slice(0, 500) } } });
}

function clearError(model: string): void {
  const state = readState();
  if (!state.errors?.[model]) return;
  const errors = { ...state.errors };
  delete errors[model];
  writeState({ ...state, errors });
}

// ---------- layout migration ----------

export interface MigrationReport {
  root: string;
  moved: number;
  /** Bytes those files account for (they were NOT downloaded again). */
  bytes: number;
  models: string[];
  /** Legacy paths left behind as relative symlinks so an older reader keeps working. */
  links: number;
}

const migrated = new Set<string>();
const migrationByRoot = new Map<string, MigrationReport>();

/**
 * Move the phase-1/2 flat layout into `<kind>/<model>/`, once per root per process.
 *
 * `tts/en_US-lessac-medium.onnx` → `tts/piper-lessac-medium/en_US-lessac-medium.onnx`, and the same
 * for the espeak-ng tree, the stt files and the VAD model. Nothing is copied, hashed or fetched: a
 * `rename` is enough because a file's size (which is what `present()` checks) does not change with
 * its name. A relative symlink is left at the old path, so a build that still reads the flat layout
 * (an older server bundle, the phase-1/2 test suites) keeps working against a migrated cache.
 *
 * Idempotent: a file already present at its new path is left alone, so a second call is a no-op.
 */
export function migrateLayout(root = modelsRoot(), files: VoiceModelFile[] = VOICE_MODEL_FILES): MigrationReport {
  const report: MigrationReport = { root, moved: 0, bytes: 0, models: [], links: 0 };
  const models = new Set<string>();
  for (const file of files) {
    const next = destFor(file, root);
    if (fs.existsSync(next)) continue;
    const legacy = path.join(root, KIND_DIR[file.kind], file.path);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(legacy);
    } catch {
      continue; // nothing at the old path: a fresh install, or already migrated
    }
    // Only files and symlinks move; a directory at that name is someone else's business.
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    // A symlink that resolves inside this root is a compatibility link this migration left behind
    // (possibly by a concurrent process). Moving it would chain links — `<kind>/tokens.txt` →
    // `<model>/tokens.txt` → itself — instead of moving a model.
    if (stat.isSymbolicLink()) {
      try {
        const target = path.resolve(path.dirname(legacy), fs.readlinkSync(legacy));
        if (target === root || target.startsWith(root + path.sep)) continue;
      } catch {
        continue;
      }
    }
    // Flat names collide between models — `tts/tokens.txt` is Piper's file *and* Kokoro's file name,
    // and the compatibility link left behind by an earlier move lives there too. A file only moves
    // into a model whose expected size it has; anything else stays put for its real owner.
    let legacySize = -1;
    try {
      legacySize = fs.statSync(legacy).size;
    } catch {
      continue; // a dangling symlink: nothing to move
    }
    if (legacySize !== file.size) continue;
    try {
      fs.mkdirSync(path.dirname(next), { recursive: true });
      // Two processes can migrate the same cache at once: `rename` is atomic, so the loser sees an
      // ENOENT here and the compat link below turns into a no-op.
      fs.renameSync(legacy, next);
      report.moved += 1;
      report.bytes += file.size;
      models.add(file.model);
      // Compatibility link: `<kind>/<path>` → `<kind>/<model>/<path>`.
      try {
        fs.symlinkSync(path.relative(path.dirname(legacy), next), legacy);
        report.links += 1;
      } catch {
        // A pre-existing dangling name, or a filesystem without symlinks: not worth failing over.
      }
    } catch (e) {
      console.warn(`[voice-models] could not migrate ${legacy}: ${(e as { message?: string })?.message}`);
    }
  }
  report.models = [...models];
  migrationByRoot.set(root, report);
  migrated.add(root);
  if (report.moved) {
    console.log(
      `[voice-models] migrated the phase-1/2 layout: ${report.moved} files (${(report.bytes / 1e6).toFixed(1)} MB) ` +
        `into <kind>/<model>/ for ${report.models.join(', ')} — nothing re-downloaded`,
    );
  }
  return report;
}

export function migrationReport(root = modelsRoot()): MigrationReport | null {
  return migrationByRoot.get(root) ?? null;
}

function ensureMigrated(root: string): void {
  if (migrated.has(root)) return;
  migrated.add(root); // set first: a throw below must not retry on every /status
  try {
    migrateLayout(root);
  } catch (e) {
    console.warn('[voice-models] layout migration failed:', (e as { message?: string })?.message);
  }
}

// ---------- disk scan ----------

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

/** True when the file is present at its expected size (sha256 is checked on download, not here). */
function present(file: VoiceModelFile, root = modelsRoot()): boolean {
  return fileSize(destFor(file, root)) === file.size;
}

interface ModelScan {
  /** Bytes of every file the model needs. */
  total: number;
  /** Bytes of those files that are complete. */
  have: number;
  /** Bytes on disk, partial `.part` downloads included, of files no other model needs. */
  onDisk: number;
  /** Bytes on disk of files other models need too (the espeak-ng data). */
  sharedOnDisk: number;
  files: number;
  missing: number;
  present: boolean;
}

interface Scan {
  at: number;
  byModel: Record<string, ModelScan>;
}

let scanCache: { at: number; root: string; value: Scan } | null = null;

function scan(root = modelsRoot(), fresh = false): Scan {
  if (!fresh && scanCache && scanCache.root === root && Date.now() - scanCache.at < 750) return scanCache.value;
  ensureMigrated(root);
  // Shared files (the espeak-ng data) are stat'ed once and counted for every model that needs them.
  const sizes = new Map<string, { complete: boolean; bytes: number }>();
  const sizeOf = (f: VoiceModelFile) => {
    let s = sizes.get(f.name);
    if (!s) {
      const dest = destFor(f, root);
      const size = fileSize(dest);
      s = size === f.size ? { complete: true, bytes: size } : { complete: false, bytes: Math.max(0, fileSize(`${dest}.part`)) };
      sizes.set(f.name, s);
    }
    return s;
  };
  const byModel: Record<string, ModelScan> = {};
  for (const spec of VOICE_MODELS) {
    const m: ModelScan = { total: 0, have: 0, onDisk: 0, sharedOnDisk: 0, files: 0, missing: 0, present: false };
    for (const f of filesNeededBy(spec.id)) {
      const s = sizeOf(f);
      m.total += f.size;
      m.files += 1;
      if (SHARED_FILES.has(f.name)) m.sharedOnDisk += s.bytes;
      else m.onDisk += s.bytes;
      if (s.complete) m.have += f.size;
      else m.missing += 1;
    }
    m.present = m.files > 0 && m.missing === 0;
    byModel[spec.id] = m;
  }
  const value: Scan = { at: Date.now(), byModel };
  scanCache = { at: Date.now(), root, value };
  return value;
}

/** Bytes of the *required* set (speech recognition and VAD) already on disk vs. its total. */
export function modelBytes(): { total: number; have: number } {
  const s = scan();
  let total = 0;
  let have = 0;
  for (const spec of REQUIRED_MODELS) {
    total += s.byModel[spec.id].total;
    have += s.byModel[spec.id].have;
  }
  return { total, have };
}

/** Total bytes of the required set (stt + vad). */
export const REQUIRED_BYTES = REQUIRED_MODELS.reduce((n, m) => n + modelSize(m.id), 0);

/** Every model's state, required and optional: the menu needs all four. */
export function modelStatesById(): Record<VoiceModelId, VoiceModelStateValue> {
  const s = scan();
  const state = readState();
  const out = {} as Record<VoiceModelId, VoiceModelStateValue>;
  for (const spec of VOICE_MODELS) {
    out[spec.id] = busyModels.has(spec.id)
      ? 'downloading'
      : s.byModel[spec.id].present
        ? 'ready'
        : state.errors?.[spec.id]
          ? 'error'
          : 'missing';
  }
  return out;
}

/** The best state among several models: one ready voice makes the kind ready. */
const STATE_RANK: VoiceModelStateValue[] = ['ready', 'downloading', 'error', 'missing'];

/**
 * Per-kind state for `/status` and `VoiceModelState` in the contracts. stt and vad are their one
 * model; tts is the best of the voices, so it reads `ready` as soon as any voice is installed.
 */
export function modelStates(): VoiceModelState {
  const states = modelStatesById();
  const out = {} as VoiceModelState;
  for (const kind of VOICE_KINDS) {
    const ofKind = VOICE_MODELS.filter((m) => m.kind === kind).map((m) => states[m.id]);
    out[kind] = STATE_RANK.find((s) => ofKind.includes(s)) ?? 'missing';
  }
  return out;
}

/** True when a call can run on-device: the required models and at least one voice are on disk. */
export function modelsReady(): boolean {
  return voiceReadiness({ provider: 'local', addon: true, models: modelItems() }).status === 'ready';
}

export function modelReady(id: string): boolean {
  return scan().byModel[id]?.present === true;
}

/** Whether a kind can run: its required model, or for tts any installed voice. */
export function kindReady(kind: VoiceKind): boolean {
  if (kind === 'tts') return TTS_MODELS.some((m) => modelReady(m.id));
  return modelReady(REQUIRED_MODEL_FOR[kind]);
}

/** One row per model for `GET /local/models` and the `voices` array in `/status`. */
export function modelItems(): VoiceModelItem[] {
  const s = scan();
  const states = modelStatesById();
  return VOICE_MODELS.map((spec) => {
    const m = s.byModel[spec.id];
    const state = states[spec.id];
    // Shared data counts for an installed model only: a missing voice next to an installed one
    // holds nothing of its own, and deleting it would free nothing.
    const onDisk = m.onDisk + (m.present ? m.sharedOnDisk : 0);
    const fromDisk = m.total ? Math.min(100, Math.round((onDisk / m.total) * 100)) : 100;
    const pct = state === 'ready' ? 100 : (liveProgress.get(spec.id) ?? fromDisk);
    return {
      id: spec.id,
      kind: spec.kind,
      name: spec.name,
      rate: spec.rate,
      size: m.total,
      onDisk,
      state,
      pct,
      tier: spec.tier,
      note: spec.note,
    };
  });
}

// ---------- downloader ----------

/** Hugging Face resolve URL, or a GitHub release asset for the `github:` pseudo-repos in the list. */
export function defaultUrlFor(file: VoiceModelFile): string {
  if (file.repo.startsWith('github:')) {
    const rest = file.repo.slice('github:'.length);
    const [repo, release] = rest.split('/releases/');
    return `https://github.com/${repo}/releases/download/${release}/${file.path}`;
  }
  return `https://huggingface.co/${file.repo}/resolve/main/${file.path}`;
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface VoiceDownloadOptions {
  dir: string;
  /** The file list to satisfy (injectable so tests can serve tiny fakes). */
  files: VoiceModelFile[];
  urlFor?: (file: VoiceModelFile) => string;
  onProgress?: (progress: VoiceDownloadProgress) => void;
  /** Parallel file downloads. 4 saturates a home connection without tripping HF rate limits. */
  concurrency?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Aborting stops the run between and inside files; finished files and `.part` files stay. */
  signal?: AbortSignal;
}

/**
 * A file is skipped when it is present at its listed size and the state has no *disagreeing* digest
 * for it. That is what makes the layout migration free: a cache copied or moved into place has no
 * `.state.json` entry for its files, and its sizes are exactly what the manifest says, so nothing is
 * fetched again. A recorded digest that differs from the manifest (the release changed, or the file
 * was replaced) does force a re-fetch, and every byte this function writes is hashed before it is
 * renamed into place.
 */
function upToDate(file: VoiceModelFile, dir: string, state: StateFile): boolean {
  if (!present(file, dir)) return false;
  const recorded = state.files[file.name];
  return !file.sha256 || !recorded || recorded === file.sha256;
}

/**
 * Download (or verify) every file in `files` into `dir`, four at a time.
 *
 * A file is skipped when upToDate() says so — a warm cache costs one stat per file, not 263 MB of
 * hashing. A file is resumed from `<dest>.part` with a Range request when one is left behind.
 * Resolves with `ok: false` and a message instead of rejecting, so the caller can always record a
 * state.
 */
export async function downloadVoiceFiles(opts: VoiceDownloadOptions): Promise<VoiceDownloadResult> {
  const { dir, files } = opts;
  const urlFor = opts.urlFor ?? defaultUrlFor;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));
  const log = opts.log ?? ((m: string) => console.log(m));

  const state = readState(dir);
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  let failure: string | null = null;
  let currentName: string | null = null;
  let currentDone = 0;
  let currentTotal = 0;

  let lastEmit = 0;
  const emit = (force = false) => {
    const at = Date.now();
    if (!force && at - lastEmit < 100) return;
    lastEmit = at;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
    opts.onProgress?.({ done, total, pct, name: currentName, fileDone: currentDone, fileTotal: currentTotal });
  };

  const todo: VoiceModelFile[] = [];
  for (const f of files) {
    if (upToDate(f, dir, state)) {
      skipped += 1;
      done += f.size;
      continue;
    }
    todo.push(f);
  }
  emit(true);

  const fetchOne = async (file: VoiceModelFile): Promise<void> => {
    const dest = destFor(file, dir);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    let start = fileSize(part);
    if (start < 0 || start > file.size) start = 0;
    if (start === file.size) {
      // A complete .part from an interrupted run: rename it after verification below.
    } else if (start > 0) {
      log(`[voice-models] resuming ${file.name} at ${start}/${file.size} bytes`);
    }
    currentName = `${file.model}/${file.path}`;
    currentTotal = file.size;
    currentDone = start;

    let headers: Record<string, string> = {};
    if (start > 0) headers = { Range: `bytes=${start}-` };
    if (start < file.size) {
      const timeout = AbortSignal.timeout(120_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const res = await fetchImpl(urlFor(file), { headers, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${file.name}`);
      if (start > 0 && res.status !== 206) start = 0; // server ignored the Range: rewrite from scratch
      if (!res.body) throw new Error(`empty response for ${file.name}`);
      // Bytes resumed from an earlier attempt still count towards this run's progress.
      done += start;

      const handle = await fsp.open(part, start > 0 ? 'a' : 'w');
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          if (!value?.length) continue;
          await handle.write(value);
          currentDone += value.length;
          done += value.length;
          emit();
        }
      } finally {
        await handle.close();
      }
    }

    const written = fileSize(part);
    if (written !== file.size) throw new Error(`${file.name}: expected ${file.size} bytes, got ${written}`);
    if (file.sha256) {
      const actual = await sha256File(part);
      if (actual !== file.sha256) {
        await fsp.rm(part, { force: true });
        throw new Error(`${file.name}: sha256 mismatch (expected ${file.sha256}, got ${actual})`);
      }
      state.files[file.name] = actual;
    }
    await fsp.rename(part, dest);
    downloaded += 1;
    emit(true);
  };

  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const i = index++;
      if (i >= todo.length) return;
      try {
        await fetchOne(todo[i]);
      } catch (e) {
        const message = String((e as { message?: string })?.message ?? e);
        failure ??= message;
        if (!opts.signal?.aborted) log(`[voice-models] download failed: ${message}`);
        // Keep the .part file: the next attempt resumes from it.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));

  if (downloaded > 0 || state.verifiedAt === 0) {
    writeState({ verifiedAt: Date.now(), files: state.files, errors: state.errors }, dir);
  }
  currentName = null;
  currentDone = currentTotal = 0;
  emit(true);

  return { ok: !failure, error: failure ?? undefined, downloaded, skipped, bytes: done };
}

// ---------- background jobs ----------

/**
 * Models queued or being downloaded, each with the token of the request that queued it. A cancel
 * drops the entry; a queued job whose token no longer matches has been cancelled (or superseded by
 * a newer request) and does nothing.
 */
const busyModels = new Map<string, symbol>();
/** The running download's abort handle and the promise that settles when it has stopped. */
const running = new Map<string, { controller: AbortController; settled: Promise<void> }>();
/** Live percentage of each running download, from the downloader's progress events. */
const liveProgress = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();
let live: { pct: number; name: string | null } = { pct: 0, name: null };

/** What `/status` shows under `download`. */
export function downloadProgress(): { active: boolean; pct: number; name: string | null } {
  return { active: busyModels.size > 0, pct: busyModels.size ? live.pct : 0, name: busyModels.size ? live.name : null };
}

export function downloading(): string[] {
  return [...busyModels.keys()];
}

export interface EnsureOptions {
  onProgress?: (progress: VoiceDownloadProgress) => void;
  /** Overridable in tests: where each file comes from. */
  urlFor?: (file: VoiceModelFile) => string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
}

/**
 * TEST-ONLY seam for the *route's* fire-and-forget download: `POST /local/models/download` calls
 * ensureModels() with no options, so a test that wants to watch a real download without touching
 * huggingface.co installs a URL builder here. `null` (production) keeps defaultUrlFor().
 */
let testUrlFor: ((file: VoiceModelFile) => string) | null = null;

export function __setDownloadUrlForTests(urlFor: ((file: VoiceModelFile) => string) | null): void {
  testUrlFor = urlFor;
}

/**
 * Resolve `kindOrModel` to the models it names.
 *  - nothing → the required set (stt + vad); a voice is never fetched implicitly
 *  - a kind → that kind's model (tts → the default voice, Piper)
 *  - a model id → that model, optional tiers included
 */
export function modelsForTarget(kindOrModel?: VoiceKind | string): VoiceModelSpec[] {
  if (kindOrModel === undefined) return REQUIRED_MODELS.slice();
  if (VOICE_KINDS.includes(kindOrModel as VoiceKind)) return [modelSpec(REQUIRED_MODEL_FOR[kindOrModel as VoiceKind])!];
  const spec = modelSpec(kindOrModel);
  if (!spec) throw new Error(`unknown voice model or kind: ${kindOrModel}`);
  return [spec];
}

/**
 * Make sure the named models are on disk. Returns a promise that settles when the work finishes; it
 * never rejects for a download failure. Calling it again while a download runs queues behind it
 * (idempotent), and a model that is already complete is skipped without touching the network.
 *
 * An unknown `kindOrModel` does throw — that is a caller bug, not a network condition.
 */
export function ensureModels(kindOrModel?: VoiceKind | string, opts: EnsureOptions = {}): Promise<void> {
  const targets = modelsForTarget(kindOrModel).filter((m) => !modelReady(m.id));
  if (!targets.length) return Promise.resolve();
  // A model already queued keeps its place; the caller waits for the queue it is in.
  const needed = targets.filter((m) => !busyModels.has(m.id));
  if (!needed.length) return queue;
  const jobs = needed.map((model) => {
    const token = Symbol(model.id);
    busyModels.set(model.id, token);
    return { model, token };
  });
  live = { pct: 0, name: null };

  queue = queue
    .then(async () => {
      for (const job of jobs) await runDownload(job.model, job.token, opts);
    })
    // Keep the chain alive: one failed job must not reject every later ensureModels().
    .catch((e) => console.warn('[voice-models] background download error:', e?.message));
  return queue;
}

async function runDownload(model: VoiceModelSpec, token: symbol, opts: EnsureOptions): Promise<void> {
  if (busyModels.get(model.id) !== token) return;
  const controller = new AbortController();
  let settle!: () => void;
  running.set(model.id, { controller, settled: new Promise<void>((r) => (settle = r)) });
  try {
    if (modelReady(model.id)) {
      clearError(model.id);
      return;
    }
    const result = await downloadVoiceFiles({
      dir: modelsRoot(),
      files: filesNeededBy(model.id),
      urlFor: opts.urlFor ?? testUrlFor ?? undefined,
      fetchImpl: opts.fetchImpl,
      concurrency: opts.concurrency ?? 4,
      signal: controller.signal,
      onProgress: (p) => {
        live = { pct: p.pct, name: p.name };
        liveProgress.set(model.id, p.pct);
        opts.onProgress?.(p);
      },
    });
    // A cancelled download is the person's choice, not a failure worth reporting.
    if (result.ok || controller.signal.aborted) clearError(model.id);
    else recordError(model.id, result.error ?? 'download failed');
  } catch (e) {
    recordError(model.id, String((e as { message?: string })?.message ?? e));
  } finally {
    scan(modelsRoot(), true);
    if (busyModels.get(model.id) === token) busyModels.delete(model.id);
    running.delete(model.id);
    liveProgress.delete(model.id);
    live = { pct: 0, name: null };
    settle();
  }
}

/**
 * Stop a queued or running download. The files it finished and its `.part` stay on disk, so a later
 * download resumes; deleteModel() is what reclaims the space. Resolves once nothing is writing.
 * Returns false when the model was not downloading.
 */
export async function cancelDownload(id: string): Promise<boolean> {
  if (!busyModels.has(id)) return false;
  busyModels.delete(id);
  const job = running.get(id);
  job?.controller.abort();
  await job?.settled;
  scan(modelsRoot(), true);
  return true;
}

function pruneEmptyDirs(dir: string, stopAt: string): void {
  for (let d = dir; d.startsWith(stopAt + path.sep); d = path.dirname(d)) {
    try {
      fs.rmdirSync(d);
    } catch {
      return; // not empty, or already gone
    }
  }
}

export interface DeleteResult {
  removed: number;
  bytes: number;
}

/**
 * Remove a model's files from disk, `.part` downloads included, cancelling its download first.
 * Files another installed (or downloading) model still needs stay: deleting Piper keeps the
 * espeak-ng data while Kokoro is installed. Idempotent: deleting a missing model removes nothing.
 */
export async function deleteModel(id: VoiceModelId, root = modelsRoot()): Promise<DeleteResult> {
  await cancelDownload(id);
  const states = modelStatesById();
  const keep = new Set<string>();
  for (const spec of VOICE_MODELS) {
    if (spec.id === id || (states[spec.id] !== 'ready' && states[spec.id] !== 'downloading')) continue;
    for (const f of filesNeededBy(spec.id)) keep.add(f.name);
  }
  const result: DeleteResult = { removed: 0, bytes: 0 };
  const state = readState(root);
  const files = { ...state.files };
  const dirs = new Set<string>();
  for (const f of filesNeededBy(id)) {
    if (keep.has(f.name)) continue;
    const dest = destFor(f, root);
    for (const p of [dest, `${dest}.part`]) {
      const size = fileSize(p);
      if (size < 0) continue;
      fs.rmSync(p, { force: true });
      result.removed += 1;
      result.bytes += size;
    }
    delete files[f.name];
    dirs.add(path.dirname(dest));
    // The phase-1/2 compatibility link at the flat path now points at nothing.
    const legacy = path.join(root, KIND_DIR[f.kind], f.path);
    try {
      if (fs.lstatSync(legacy).isSymbolicLink() && !fs.existsSync(legacy)) fs.unlinkSync(legacy);
    } catch {
      // no link there
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) pruneEmptyDirs(d, root);
  const errors = { ...state.errors };
  delete errors[id];
  writeState({ ...state, files, errors }, root);
  scan(root, true);
  return result;
}

/** Test/desktop helper: forget the scan, state and migration caches after files appear or vanish. */
export function resetVoiceModelCaches(): void {
  scanCache = null;
  stateCache = null;
  live = { pct: 0, name: null };
  migrated.clear();
  migrationByRoot.clear();
}
