/**
 * Model cache manager for the on-device voice stack: a resumable, checksum-verified downloader over
 * the generated file list in voice-model-files.ts (250 files, 263 MB), plus the state the UI polls.
 *
 * Layout (docs/voice-local-conventions.md):
 *
 *   voice-models/
 *     stt/{encoder,decoder,joiner}-epoch-99-avg-1.int8.onnx, tokens.txt
 *     tts/en_US-lessac-medium.onnx, tokens.txt, espeak-ng-data/**
 *     vad/silero_vad.onnx
 *     .state.json          { verifiedAt, files: { name: sha256 }, errors: { kind: message } }
 *
 * Two rules that matter:
 *  - A download runs in the background and NEVER throws at its caller. A failure is recorded as an
 *    `error` state with a message, so a phone on hotel wifi sees the reason in `/local/status`
 *    instead of a crashed request.
 *  - Files are written as `<dest>.part` and renamed only after their sha256 matches, so a reader can
 *    never load a half-written ONNX file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';
import { VOICE_MODEL_BYTES, VOICE_MODEL_FILES, type VoiceModelFile } from './voice-model-files.js';
import type { VoiceModelState, VoiceModelStateValue } from '@orbit/contracts';

export type VoiceKind = 'stt' | 'tts' | 'vad';
/** The three groups `/status` reports. espeak-ng data belongs to TTS and lives under tts/. */
export const VOICE_KINDS: VoiceKind[] = ['stt', 'tts', 'vad'];

const KIND_DIR: Record<VoiceModelFile['kind'], VoiceKind> = { stt: 'stt', tts: 'tts', espeak: 'tts', vad: 'vad' };

export interface VoiceDownloadProgress {
  /** Bytes of the requested set already on disk (verified or written this run). */
  done: number;
  /** Bytes of the requested set in total. */
  total: number;
  pct: number;
  /** The file currently being written, or null between files. */
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

/** Absolute destination for one listed file, e.g. <root>/tts/espeak-ng-data/en_dict. */
export function destFor(file: VoiceModelFile, root = modelsRoot()): string {
  return path.join(root, KIND_DIR[file.kind], file.path);
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
  } catch (e: any) {
    console.warn('[voice-models] could not write .state.json:', e?.message);
  }
}

function recordError(kind: VoiceKind, message: string): void {
  const state = readState();
  writeState({ ...state, errors: { ...state.errors, [kind]: { at: Date.now(), message: message.slice(0, 500) } } });
}

function clearError(kind: VoiceKind): void {
  const state = readState();
  if (!state.errors?.[kind]) return;
  const errors = { ...state.errors };
  delete errors[kind];
  writeState({ ...state, errors });
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

interface Scan {
  at: number;
  have: number;
  total: number;
  missing: VoiceModelFile[];
  perKind: Record<VoiceKind, { total: number; have: number; missing: number }>;
}

let scanCache: { at: number; root: string; value: Scan } | null = null;

function scan(root = modelsRoot(), fresh = false): Scan {
  if (!fresh && scanCache && scanCache.root === root && Date.now() - scanCache.at < 750) return scanCache.value;
  const perKind: Scan['perKind'] = {
    stt: { total: 0, have: 0, missing: 0 },
    tts: { total: 0, have: 0, missing: 0 },
    vad: { total: 0, have: 0, missing: 0 },
  };
  const missing: VoiceModelFile[] = [];
  let have = 0;
  let total = 0;
  for (const f of VOICE_MODEL_FILES) {
    const kind = KIND_DIR[f.kind];
    const size = fileSize(destFor(f, root));
    const ok = size === f.size;
    perKind[kind].total += f.size;
    total += f.size;
    if (ok) {
      perKind[kind].have += f.size;
      have += Math.min(size, f.size);
    } else {
      perKind[kind].missing += 1;
      missing.push(f);
      if (size > 0) have += Math.min(size, f.size);
    }
  }
  const value: Scan = { at: Date.now(), have, total, missing, perKind };
  scanCache = { at: Date.now(), root, value };
  return value;
}

/** Downloaded bytes vs. the full 263 MB, for the progress bar. */
export function modelBytes(): { total: number; have: number } {
  const s = scan();
  return { total: s.total || VOICE_MODEL_BYTES, have: s.have };
}

/** Per-kind state for `/status`: ready, downloading, error (last attempt failed), or missing. */
export function modelStates(): VoiceModelState {
  const s = scan();
  const state = readState();
  const out = {} as VoiceModelState;
  for (const kind of VOICE_KINDS) {
    const value: VoiceModelStateValue = busy.has(kind)
      ? 'downloading'
      : s.perKind[kind].missing === 0
        ? 'ready'
        : state.errors?.[kind]
          ? 'error'
          : 'missing';
    out[kind] = value;
  }
  return out;
}

/** True when every file of all three models is on disk at its expected size. */
export function modelsReady(): boolean {
  return scan().missing.length === 0;
}

export interface VoiceModelGroup {
  kind: VoiceKind;
  /** Repo the files came from — a stable, honest label for the UI (there is one voice per kind). */
  name: string;
  size: number;
  have: number;
  files: number;
  state: VoiceModelStateValue;
}

/** One row per model for `GET /local/models`. */
export function modelGroups(): VoiceModelGroup[] {
  const states = modelStates();
  const s = scan();
  return VOICE_KINDS.map((kind) => {
    const files = VOICE_MODEL_FILES.filter((f) => KIND_DIR[f.kind] === kind);
    return {
      kind,
      name: files[0]?.repo ?? kind,
      size: s.perKind[kind].total,
      have: s.perKind[kind].have,
      files: files.length,
      state: states[kind],
    };
  });
}

/** Whether one kind is complete; used by the router before it loads an engine. */
export function kindReady(kind: VoiceKind): boolean {
  return scan().perKind[kind].missing === 0;
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
  /** Root of the model cache to write into. */
  dir: string;
  /** The file list to satisfy (injectable so tests can serve tiny fakes). */
  files: VoiceModelFile[];
  /** Where each file comes from. Defaults to defaultUrlFor(). */
  urlFor?: (file: VoiceModelFile) => string;
  onProgress?: (progress: VoiceDownloadProgress) => void;
  /** Parallel file downloads. 4 saturates a home connection without tripping HF rate limits. */
  concurrency?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/**
 * Download (or verify) every file in `files` into `dir`, four at a time.
 *
 * A file is skipped when its size matches and, if the manifest has a sha256, the recorded checksum
 * matches too — so a warm cache costs one stat per file, not 263 MB of hashing. A file is resumed
 * from `<dest>.part` with a Range request when one is left behind. Resolves with `ok: false` and a
 * message instead of rejecting, so the caller can always record a state.
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
    const dest = destFor(f, dir);
    if (present(f, dir) && (!f.sha256 || state.files[f.name] === f.sha256)) {
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
    currentName = file.name;
    currentTotal = file.size;
    currentDone = start;

    let headers: Record<string, string> = {};
    if (start > 0) headers = { Range: `bytes=${start}-` };
    if (start < file.size) {
      const res = await fetchImpl(urlFor(file), { headers, signal: AbortSignal.timeout(120_000) });
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
      const i = index++;
      if (i >= todo.length) return;
      try {
        await fetchOne(todo[i]);
      } catch (e: any) {
        const message = String(e?.message ?? e);
        failure ??= message;
        log(`[voice-models] download failed: ${message}`);
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

/** Kinds queued or being downloaded right now; drives the 'downloading' state. */
const busy = new Set<VoiceKind>();
let queue: Promise<void> = Promise.resolve();
let live: { pct: number; name: string | null } = { pct: 0, name: null };

/** What `/status` shows under `download`. */
export function downloadProgress(): { active: boolean; pct: number; name: string | null } {
  return { active: busy.size > 0, pct: busy.size ? live.pct : 0, name: busy.size ? live.name : null };
}

export interface EnsureOptions {
  onProgress?: (progress: VoiceDownloadProgress) => void;
  /** Overridable in tests: where each file comes from. */
  urlFor?: (file: VoiceModelFile) => string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
}

/**
 * Make sure the models are on disk. Returns a promise that settles when the work finishes; it never
 * rejects. Calling it again while a download runs queues behind it (idempotent), and a kind that is
 * already complete is skipped without touching the network.
 */
export function ensureModels(kind?: VoiceKind, opts: EnsureOptions = {}): Promise<void> {
  const kinds = kind ? [kind] : VOICE_KINDS.slice();
  const needed = kinds.filter((k) => !kindReady(k));
  if (!needed.length) return Promise.resolve();
  for (const k of needed) busy.add(k);
  live = { pct: 0, name: null };

  queue = queue
    .then(async () => {
      for (const k of needed) {
        try {
          if (kindReady(k)) {
            clearError(k);
            continue;
          }
          const files = VOICE_MODEL_FILES.filter((f) => KIND_DIR[f.kind] === k);
          const result = await downloadVoiceFiles({
            dir: modelsRoot(),
            files,
            urlFor: opts.urlFor,
            fetchImpl: opts.fetchImpl,
            concurrency: opts.concurrency ?? 4,
            onProgress: (p) => {
              live = { pct: p.pct, name: p.name };
              opts.onProgress?.(p);
            },
          });
          if (result.ok) clearError(k);
          else recordError(k, result.error ?? 'download failed');
        } catch (e: any) {
          recordError(k, String(e?.message ?? e));
        } finally {
          scan(modelsRoot(), true);
          busy.delete(k);
          live = { pct: 0, name: null };
        }
      }
    })
    // Keep the chain alive: one failed job must not reject every later ensureModels().
    .catch((e) => console.warn('[voice-models] background download error:', e?.message));
  return queue;
}

/** Test/desktop helper: forget the scan and state caches after files appear or vanish. */
export function resetVoiceModelCaches(): void {
  scanCache = null;
  stateCache = null;
  live = { pct: 0, name: null };
}
