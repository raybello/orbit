#!/usr/bin/env node
// Walks apps/server/src's runtime import graph, prints every cycle group, and exits 1
// when one includes agent/loop.ts. Type-only imports are erased at build time and
// dynamic import() runs after load, so neither can form a load-order cycle.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/server/src');
const guarded = 'agent/loop.ts';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const STATIC = /^\s*(import|export)\s+(?!type\b)([^'"]*?)\s*from\s*['"](\.[^'"]+)['"]|^\s*import\s+['"](\.[^'"]+)['"]/gm;

function edgesOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(STATIC)) {
    const clause = m[2] ?? '';
    if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type '))) continue;
    const spec = m[3] ?? m[4];
    const base = resolve(dirname(file), spec.replace(/\.js$/, ''));
    const target = [`${base}.ts`, join(base, 'index.ts')].find(existsSync);
    if (target) out.add(target);
  }
  return [...out];
}

const files = walk(root);
const graph = new Map(files.map((f) => [f, edgesOf(f)]));

// Tarjan's strongly connected components.
let index = 0;
const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], groups = [];
function connect(v) {
  idx.set(v, index); low.set(v, index); index++;
  stack.push(v); onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const group = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); group.push(w); } while (w !== v);
    if (group.length > 1) groups.push(group);
  }
}
for (const f of files) if (!idx.has(f)) connect(f);

// One concrete loop through a group's first member, for a readable report.
function sampleCycle(group) {
  const members = new Set(group);
  const start = group.includes(join(root, guarded)) ? join(root, guarded) : group[0];
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const w of graph.get(v) ?? []) {
      if (!members.has(w)) continue;
      if (w === start) {
        const path = [v];
        for (let p = prev.get(v); p; p = prev.get(p)) path.unshift(p);
        return [...path, start];
      }
      if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
    }
  }
  return [start];
}

const rel = (f) => relative(root, f);
let failed = false;
for (const group of groups) {
  const names = group.map(rel).sort();
  const hit = names.includes(guarded);
  failed ||= hit;
  console.log(`${hit ? 'FAIL' : 'note'}: cycle group of ${names.length} files${hit ? ` (includes ${guarded})` : ''}`);
  console.log(`  e.g. ${sampleCycle(group).map(rel).join(' -> ')}`);
  for (const n of names) console.log(`  ${n}`);
}
console.log(groups.length ? `${groups.length} cycle group(s).` : 'No import cycles.');
process.exit(failed ? 1 : 0);
