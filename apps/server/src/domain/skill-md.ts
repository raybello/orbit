import YAML from 'yaml';

/**
 * SKILL.md: the Agent Skills format. YAML frontmatter with `name` and `description`, then the
 * instructions. A skill's name is also how a message invokes it (`/<name>`), so it follows the
 * format's rule: lowercase letters, digits and single hyphens, at most 64 characters.
 */

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_SKILL_MD = 100_000;

export interface ParsedSkillMd { frontmatter: Record<string, unknown>; body: string }

/** The frontmatter and body of a SKILL.md. Text without frontmatter is all body. */
export function parseSkillMd(text: string): ParsedSkillMd | { error: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { frontmatter: {}, body: src.trim() };
  let fm: unknown;
  try {
    fm = YAML.parse(m[1]);
  } catch (e) {
    return { error: `The frontmatter is not valid YAML: ${String((e as Error).message).split('\n')[0]}` };
  }
  if (fm !== null && fm !== undefined && (typeof fm !== 'object' || Array.isArray(fm))) return { error: 'The frontmatter must be a set of key: value lines' };
  return { frontmatter: (fm ?? {}) as Record<string, unknown>, body: src.slice(m[0].length).trim() };
}

/** Why this is not a usable skill name, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return 'Give the skill a name';
  if (name.length > MAX_SKILL_NAME) return `A skill name is at most ${MAX_SKILL_NAME} characters`;
  if (!SKILL_NAME.test(name)) return 'A skill name uses lowercase letters, digits and single hyphens, like weekly-report';
  return null;
}

/** A free-text title as a skill name: "Weekly Report!" → "weekly-report". */
export function slugifySkillName(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SKILL_NAME).replace(/-+$/, '') || 'skill';
}

/**
 * A complete SKILL.md for this name and description. The given content's own frontmatter is kept,
 * with `name` and `description` set to what the library holds, so the file always agrees with it.
 */
export function skillMdFor(name: string, description: string, content: string): string {
  const parsed = parseSkillMd(content);
  const fm = 'error' in parsed ? {} : parsed.frontmatter;
  const body = 'error' in parsed ? content.trim() : parsed.body;
  const front = YAML.stringify({ ...fm, name, description }, { lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n\n${body}\n`;
}

/** The instructions of a SKILL.md, without its frontmatter. */
export function skillBody(content: string): string {
  const parsed = parseSkillMd(content);
  return 'error' in parsed ? content.trim() : parsed.body;
}

/**
 * Replace each `/<name>` in a message with that skill's instructions. Only whole tokens count: the
 * slash starts the message or follows whitespace, and the name ends at whitespace or punctuation,
 * so a path (`/usr/bin`) or a URL is never mistaken for one. Names not in `skills` are left as typed.
 */
export function expandSkillCommands(text: string, skills: ReadonlyMap<string, string>): { text: string; used: string[] } {
  const used: string[] = [];
  if (!skills.size || !text.includes('/')) return { text, used };
  const out = text.replace(/(^|\s)\/([a-z0-9][a-z0-9-]{0,63})(?=$|[\s.,;:!?)\]])/g, (whole, lead: string, name: string) => {
    const body = skills.get(name);
    if (body === undefined) return whole;
    if (!used.includes(name)) used.push(name);
    return `${lead}<skill name="${name}">\n${body}\n</skill>\n`;
  });
  return { text: out, used };
}

/** A GitHub skill source the person typed, read into its parts. */
export interface GithubSource { owner: string; repo: string; ref?: string; path?: string }

const SEG = /^[A-Za-z0-9_.-]+$/;

/**
 * Read a GitHub skill source: `owner/repo`, `owner/repo/path/to/skill`, `github:owner/repo`, or a
 * github.com URL (`/tree/<ref>/<path>` or `/blob/<ref>/<path>/SKILL.md`). Null when it is not one.
 */
export function parseGithubSource(input: string): GithubSource | null {
  let s = input.trim().replace(/^github:/i, '');
  let ref: string | undefined;
  let rest: string[];
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(s);
  if (url) s = url[1];
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  if (!SEG.test(owner) || !SEG.test(repo)) return null;
  rest = parts.slice(2);
  if (url && (rest[0] === 'tree' || rest[0] === 'blob')) {
    if (!rest[1]) return null;
    ref = rest[1];
    rest = rest.slice(2);
  }
  if (rest.some((p) => p === '..' || p === '.')) return null;
  if (rest.at(-1)?.toLowerCase() === 'skill.md') rest = rest.slice(0, -1);
  const path = rest.join('/');
  return { owner, repo, ...(ref ? { ref } : {}), ...(path ? { path } : {}) };
}
