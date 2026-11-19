import type { GithubSkillCandidate, GithubSkillInspect, LibrarySkill, SkillAuthor } from '@orbit/contracts';
import { nameProblem, parseGithubSource, parseSkillMd, type GithubSource } from '../domain/skill-md.js';
import { MAX_FILES, MAX_FILE_BYTES, SkillError, createSkill } from './skill-library.js';

/**
 * Installing a skill from a public GitHub repository. A skill there is a folder holding a SKILL.md
 * (the Agent Skills layout), alone or with scripts and references beside it. Nothing is installed
 * until the repository, the ref and the SKILL.md have all checked out; the skill keeps the exact
 * commit it came from.
 */

interface TreeEntry { path: string; type: 'blob' | 'tree' | string; size?: number }

/** Every request this module makes to GitHub. Tests replace these. */
export const githubIO = {
  async json(path: string): Promise<{ status: number; body: unknown }> {
    const token = process.env.GITHUB_TOKEN?.trim();
    const r = await fetch(`https://api.github.com${path}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'orbit-skills', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, body };
  },
  async raw(owner: string, repo: string, commit: string, path: string): Promise<Buffer | null> {
    const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'user-agent': 'orbit-skills' },
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  },
};

const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isSkillMd = (p: string) => (p.split('/').pop() ?? '').toLowerCase() === 'skill.md';

function refused(status: number, what: string): never {
  if (status === 403 || status === 429) throw new SkillError('GitHub is rate-limiting requests from this server. Try again in a few minutes, or set GITHUB_TOKEN on the server.');
  throw new SkillError(what);
}

interface Resolved { src: GithubSource; ref: string; commit: string; tree: TreeEntry[] }

async function resolve(input: string): Promise<Resolved> {
  const src = parseGithubSource(input);
  if (!src) throw new SkillError('Not a GitHub repository. Use owner/repo, owner/repo/path/to/skill, or a github.com link.');
  const repoPath = `/repos/${src.owner}/${src.repo}`;
  const repo = await githubIO.json(repoPath);
  if (repo.status !== 200) refused(repo.status, `There is no public GitHub repository ${src.owner}/${src.repo}.`);
  const ref = src.ref ?? String(rec(repo.body).default_branch ?? 'main');
  const commit = await githubIO.json(`${repoPath}/commits/${encodeURIComponent(ref)}`);
  const sha = String(rec(commit.body).sha ?? '');
  if (commit.status !== 200 || !/^[0-9a-f]{40}$/.test(sha)) refused(commit.status, `${src.owner}/${src.repo} has no branch, tag or commit named ${ref}.`);
  const tree = await githubIO.json(`${repoPath}/git/trees/${sha}?recursive=1`);
  if (tree.status !== 200) refused(tree.status, `Could not read the files of ${src.owner}/${src.repo} at ${ref}.`);
  const entries = (Array.isArray(rec(tree.body).tree) ? rec(tree.body).tree : []) as TreeEntry[];
  return { src, ref, commit: sha, tree: entries };
}

/** The folders under the source's path that hold a SKILL.md, nearest first. */
function skillDirs(r: Resolved): string[] {
  const base = r.src.path ?? '';
  const dirs = r.tree
    .filter((e) => e.type === 'blob' && isSkillMd(e.path))
    .map((e) => dirOf(e.path))
    .filter((d) => !base || d === base || d.startsWith(`${base}/`));
  // A path that names a skill folder means that skill, not the ones nested inside it.
  if (base && dirs.includes(base)) return [base];
  return [...new Set(dirs)].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

const skillMdPath = (r: Resolved, dir: string) => r.tree.find((e) => e.type === 'blob' && isSkillMd(e.path) && dirOf(e.path) === dir)!.path;
/**
 * A skill folder's supporting files: everything under it except its SKILL.md, the folders of other
 * skills nested inside it, and dot-folders (.github and the like).
 */
function filesIn(r: Resolved, dir: string): TreeEntry[] {
  const inside = (p: string, d: string) => d === '' || p.startsWith(`${d}/`);
  const nested = r.tree
    .filter((e) => e.type === 'blob' && isSkillMd(e.path))
    .map((e) => dirOf(e.path))
    .filter((d) => d !== dir && inside(d, dir));
  return r.tree.filter((e) =>
    e.type === 'blob'
    && inside(e.path, dir)
    && !(isSkillMd(e.path) && dirOf(e.path) === dir)
    && !nested.some((d) => inside(e.path, d))
    && !e.path.slice(dir ? dir.length + 1 : 0).split('/').some((seg) => seg.startsWith('.')));
}

/** Read one skill folder's SKILL.md and check it is a usable skill. */
async function readCandidate(r: Resolved, dir: string): Promise<{ candidate: GithubSkillCandidate; content: string } | { problem: string }> {
  const raw = await githubIO.raw(r.src.owner, r.src.repo, r.commit, skillMdPath(r, dir));
  const where = dir || 'the repository root';
  if (!raw) return { problem: `${where}: SKILL.md could not be downloaded` };
  const content = raw.toString('utf8');
  const parsed = parseSkillMd(content);
  if ('error' in parsed) return { problem: `${where}: ${parsed.error}` };
  const name = String(parsed.frontmatter.name ?? '').trim();
  const description = String(parsed.frontmatter.description ?? '').trim();
  if (!name) return { problem: `${where}: SKILL.md has no name in its frontmatter` };
  const bad = nameProblem(name);
  if (bad) return { problem: `${where}: ${bad} (got "${name}")` };
  if (!description) return { problem: `${where}: SKILL.md has no description in its frontmatter` };
  if (!parsed.body) return { problem: `${where}: SKILL.md has no instructions after its frontmatter` };
  return { candidate: { path: dir, name, description, files: filesIn(r, dir).length }, content };
}

/** What installing this source would add, without adding anything. Refuses a source with no usable skill. */
export async function inspectGithub(input: string): Promise<GithubSkillInspect> {
  const r = await resolve(input);
  const dirs = skillDirs(r).slice(0, 30);
  const where = `${r.src.owner}/${r.src.repo}${r.src.path ? `/${r.src.path}` : ''}`;
  if (!dirs.length) throw new SkillError(`No SKILL.md in ${where} at ${r.ref}.`);
  const read = await Promise.all(dirs.map((d) => readCandidate(r, d)));
  const candidates = read.flatMap((x) => ('candidate' in x ? [x.candidate] : []));
  if (!candidates.length) throw new SkillError(`${where} has no usable skill: ${read.map((x) => ('problem' in x ? x.problem : '')).join('; ')}`);
  return { repo: `${r.src.owner}/${r.src.repo}`, ref: r.ref, commit: r.commit, candidates };
}

/**
 * Install one skill from GitHub into this person's library, with its supporting files and where it
 * came from. A source with several skills needs `pick` (a candidate's path) to say which.
 */
export async function installGithub(userId: string, author: SkillAuthor, input: string, pick?: string): Promise<LibrarySkill> {
  const r = await resolve(input);
  const dirs = skillDirs(r);
  const dir = pick !== undefined ? dirs.find((d) => d === pick) : dirs.length === 1 ? dirs[0] : undefined;
  if (dir === undefined) {
    if (!dirs.length) throw new SkillError(`No SKILL.md in ${r.src.owner}/${r.src.repo} at ${r.ref}.`);
    throw new SkillError(pick !== undefined ? `${pick} is not a skill folder in ${r.src.owner}/${r.src.repo}.` : `${r.src.owner}/${r.src.repo} has ${dirs.length} skills. Pick one to install.`, 409);
  }
  const read = await readCandidate(r, dir);
  if ('problem' in read) throw new SkillError(read.problem);

  const entries = filesIn(r, dir);
  if (entries.length > MAX_FILES) throw new SkillError(`${read.candidate.name} has ${entries.length} files; a skill carries at most ${MAX_FILES}.`);
  const tooBig = entries.find((e) => (e.size ?? 0) > MAX_FILE_BYTES);
  if (tooBig) throw new SkillError(`${tooBig.path} is larger than ${MAX_FILE_BYTES / 1024} KB, so ${read.candidate.name} cannot be installed.`);
  const files = await Promise.all(entries.map(async (e) => {
    const content = await githubIO.raw(r.src.owner, r.src.repo, r.commit, e.path);
    if (!content) throw new SkillError(`${e.path} could not be downloaded from GitHub.`);
    return { path: dir ? e.path.slice(dir.length + 1) : e.path, content };
  }));

  const repo = `${r.src.owner}/${r.src.repo}`;
  return createSkill(userId, author, {
    name: read.candidate.name,
    content: read.content,
    description: read.candidate.description,
    files,
    source: { type: 'github', repo, ref: r.ref, commit: r.commit, path: dir, url: `https://github.com/${repo}/tree/${r.commit}${dir ? `/${dir}` : ''}` },
  });
}
