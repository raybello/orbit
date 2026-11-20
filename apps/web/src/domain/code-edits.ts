import type { Row } from '@orbit/contracts';

/** One file change a Bot made, as its tool call described it. */
export type CodeEdit =
  /** `previous` is the file before this write when it was known, so an overwrite can show what changed. */
  | { kind: 'write'; seq: number; path: string; content: string; previous: string | null }
  | { kind: 'replace'; seq: number; path: string; before: string; after: string; all: boolean }
  /** A V4A patch (OpenAI's apply_patch dialect). It can touch several files, so it is listed under each. */
  | { kind: 'patch'; seq: number; path: string; patch: string };

export interface CodeFile {
  path: string;
  /** Oldest first. */
  edits: CodeEdit[];
  /** The file after the last edit, when every edit could be replayed exactly; null once one could not. */
  content: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const V4A_PATH = /^\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s*Move\s+File:\s*.+?\s*->\s*(.+?)\s*$/gm;

function editsOf(row: Row): CodeEdit[] {
  const b = row.body;
  if (b.type !== 'tool-call' || b.status !== 'done') return [];
  const a = (b.args ?? {}) as Record<string, unknown>;
  const path = str(a.path);
  if (b.name === 'write_file' && path && str(a.content) !== null) return [{ kind: 'write', seq: row.seq, path, content: a.content as string, previous: null }];
  if (b.name !== 'patch') return [];
  const patch = str(a.patch);
  if (a.mode === 'patch' && patch) {
    const paths = [...new Set([...patch.matchAll(V4A_PATH)].map((m) => (m[1] ?? m[2]).trim()))];
    return paths.map((p) => ({ kind: 'patch', seq: row.seq, path: p, patch }));
  }
  const before = str(a.old_string);
  const after = str(a.new_string);
  if (path && before !== null && after !== null) return [{ kind: 'replace', seq: row.seq, path, before, after, all: a.replace_all === true }];
  return [];
}

/** Replays one edit over the file as last known. `undefined` means not known before this edit. */
function apply(content: string | null | undefined, e: CodeEdit): string | null {
  if (e.kind === 'write') return e.content;
  if (e.kind === 'patch' || content == null || !content.includes(e.before)) return null;
  return e.all ? content.split(e.before).join(e.after) : content.replace(e.before, () => e.after);
}

/** Every file a Bot wrote or edited in a transcript, in the order first touched. */
export function codeEditsOf(rows: readonly Row[]): CodeFile[] {
  const files = new Map<string, { edits: CodeEdit[]; content: string | null | undefined }>();
  for (const row of [...rows].sort((x, y) => x.seq - y.seq)) {
    for (const e of editsOf(row)) {
      const f = files.get(e.path) ?? { edits: [], content: undefined };
      f.edits.push(e.kind === 'write' ? { ...e, previous: f.content ?? null } : e);
      f.content = apply(f.content, e);
      files.set(e.path, f);
    }
  }
  return [...files].map(([path, f]) => ({ path, edits: f.edits, content: f.content ?? null }));
}

export interface DiffLine { op: ' ' | '+' | '-'; text: string }

/** Past this many line pairs in the changed middle, a diff shows it as removed then added instead of aligning it. */
const LCS_BUDGET = 4_000_000;

/** A line diff: common prefix and suffix kept, the changed middle aligned by longest common subsequence. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text): DiffLine => ({ op: ' ', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ op: ' ', text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > LCS_BUDGET) {
    return [...head, ...ma.map((text): DiffLine => ({ op: '-', text })), ...mb.map((text): DiffLine => ({ op: '+', text })), ...tail];
  }
  const n = ma.length;
  const m = mb.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = ma[i] === mb[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { mid.push({ op: ' ', text: ma[i] }); i++; j++; }
    else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) mid.push({ op: '-', text: ma[i++] });
    else mid.push({ op: '+', text: mb[j++] });
  }
  while (i < n) mid.push({ op: '-', text: ma[i++] });
  while (j < m) mid.push({ op: '+', text: mb[j++] });
  return [...head, ...mid, ...tail];
}

export type DiffItem = DiffLine | { op: 'gap'; count: number };

/** Folds unchanged runs longer than twice `context` down to `context` lines either side of each change. */
export function withContext(lines: readonly DiffLine[], context = 3): DiffItem[] {
  const near = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = 1;
  });
  const out: DiffItem[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (near[i]) {
      if (gap) { out.push({ op: 'gap', count: gap }); gap = 0; }
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ op: 'gap', count: gap });
  return out;
}
