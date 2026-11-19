import type { ActivityKind, SkillSource } from '@orbit/contracts';
import { db } from '../db.js';
import { hub } from '../lib/hub.js';
import { SkillError, botSkill, botSkillFile, createSkill, skillsForBot } from '../core/skill-library.js';
import { slugifySkillName } from '../domain/skill-md.js';
import type { ToolCtx, ToolResult } from './tools/index.js';

/**
 * Skills as tools. Any Bot may add a skill to the shared library (every Bot gets it; the person can
 * turn it off per Bot or delete it), and read a skill it has, with the files that came with it.
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** File contents a bot is handed as text: anything that is not valid UTF-8 is described instead. */
const MAX_FILE_TEXT = 60_000;

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: 'create_skill',
    description:
      'Add a skill to the team\'s shared library, so every Bot can use it (as /<name> in a message, or with read_skill). '
      + 'Use it for a repeatable way of doing something you worked out or were taught. `name` is lowercase-with-hyphens (like weekly-report); '
      + '`description` says when to use it; `instructions` is the SKILL.md body: the steps to follow, in Markdown.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase letters, digits and hyphens, at most 64 characters' },
        description: { type: 'string', description: 'When to use this skill, in one or two sentences' },
        instructions: { type: 'string', description: 'The steps to follow, in Markdown' },
      },
      required: ['name', 'description', 'instructions'],
    },
    activity: 'working',
    label: 'Adding a skill',
    impl: async (a, ctx) => {
      const bot = db.prepare('SELECT name FROM bots WHERE id=?').get(ctx.botId) as { name: string } | undefined;
      const name = slugifySkillName(str(a.name));
      try {
        const s = createSkill(ctx.userId, { kind: 'bot', id: ctx.botId, name: bot?.name ?? 'A Bot' }, {
          name, description: str(a.description), content: str(a.instructions),
        });
        hub.emit(ctx.userId, { type: 'skills' });
        return { output: `Added the skill ${s.name} to the shared library. Every Bot can now use it as /${s.name}.`, summary: `Added skill ${s.name}` };
      } catch (e) {
        if (e instanceof SkillError) return { output: `Could not add the skill: ${e.message}.` };
        throw e;
      }
    },
  },
  {
    name: 'list_skills',
    description: 'List the skills you have: each one\'s name (use it as /<name> or with read_skill), what it is for, where it came from, and how many files came with it.',
    parameters: { type: 'object', properties: {} },
    activity: 'working',
    label: 'Checking skills',
    impl: async (_a, ctx) => {
      const skills = skillsForBot(ctx.botId).map((s) => {
        const source = JSON.parse(s.source) as SkillSource;
        const files = (db.prepare('SELECT COUNT(*) n FROM skill_files WHERE skill_id=?').get(s.id) as { n: number }).n;
        return {
          name: s.name,
          description: s.description,
          source: source.type === 'github' ? `github:${source.repo}${source.path ? `/${source.path}` : ''}@${source.commit.slice(0, 7)}` : 'written in the app',
          added_by: `${s.created_by_kind === 'bot' ? 'Bot ' : ''}${s.created_by_name}`,
          ...(files ? { files } : {}),
        };
      });
      return { output: skills.length ? JSON.stringify(skills) : 'You have no skills yet. create_skill adds one for the whole team.', summary: `${skills.length} skill${skills.length === 1 ? '' : 's'}` };
    },
  },
  {
    name: 'read_skill',
    description: 'Read a skill you have (its SKILL.md), or one of the files that came with it. Skills you have are listed under Skills in your instructions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        file: { type: 'string', description: 'A file listed with the skill, e.g. scripts/build.py. Leave out for the SKILL.md.' },
      },
      required: ['name'],
    },
    activity: 'working',
    label: 'Reading a skill',
    impl: async (a, ctx) => {
      // Models name the file argument several ways (file, file_path, path) or write it into the
      // name ("pdf/scripts/fill.py"); all of them mean the same file.
      const [named, ...inName] = str(a.name).trim().replace(/^\//, '').split('/');
      const s = botSkill(ctx.botId, named);
      if (!s) return { output: `You have no skill named ${named}. Your skills are listed under Skills in your instructions.` };
      const file = (str(a.file) || str(a.file_path) || str(a.path) || inName.join('/')).trim().replace(/^\.?\//, '');
      if (!file) {
        const files = s.files.length ? `\n\nFiles that came with it (read one with read_skill, passing its path as "file"):\n${s.files.map((f) => `- ${f}`).join('\n')}` : '';
        return { output: `${s.content}${files}`, summary: `Read skill ${s.name}` };
      }
      const buf = botSkillFile(s.id, file);
      if (!buf) return { output: `${s.name} has no file ${file}. Its files: ${s.files.join(', ') || 'none'}.` };
      const text = buf.toString('utf8');
      if (text.includes('�')) return { output: `${file} is a binary file (${buf.length} bytes); it cannot be shown as text.` };
      return { output: text.length > MAX_FILE_TEXT ? `${text.slice(0, MAX_FILE_TEXT)}\n…(truncated)` : text, summary: `Read ${s.name}/${file}` };
    },
  },
];
