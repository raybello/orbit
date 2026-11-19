import { Hono, type Context } from 'hono';
import type { SkillAuthor } from '@orbit/contracts';
import { requireUser, type AuthVars } from './lib/auth.js';
import { hub } from './lib/hub.js';
import { GithubSkillSchema, NewSkillSchema, SkillAccessSchema, SkillPatchSchema, requireBody } from './api/schemas.js';
import { SkillError, createSkill, deleteSkill, listLibrary, setSkillAccess, updateSkill } from './core/skill-library.js';
import { inspectGithub, installGithub } from './core/github-skills.js';

/**
 * /api/skill-library: the person's shared skills. Every route acts on the signed-in person's own
 * library; a skill or Bot of anyone else's answers 404.
 */
export const skillLibraryApi = new Hono<AuthVars>();
skillLibraryApi.use('/skill-library', requireUser);
skillLibraryApi.use('/skill-library/*', requireUser);

const me = (c: Context<AuthVars>): SkillAuthor => {
  const u = c.get('user');
  return { kind: 'user', id: u.id, name: u.name || u.email || 'You' };
};

/** A refused change answers with its reason and status; anything else is the server's fault. */
async function answer<T>(c: Context<AuthVars>, run: () => T | Promise<T>, changes = true) {
  try {
    const out = await run();
    if (changes) hub.emit(c.get('user').id, { type: 'skills' });
    return c.json(out);
  } catch (e) {
    if (e instanceof SkillError) return c.json({ error: e.message }, e.status);
    throw e;
  }
}

skillLibraryApi.get('/skill-library', (c) => c.json({ skills: listLibrary(c.get('user').id) }));

skillLibraryApi.post('/skill-library', async (c) => {
  const p = await requireBody(c, NewSkillSchema);
  return answer(c, () => ({ skill: createSkill(c.get('user').id, me(c), { ...p, name: p.name.trim() }) }));
});

skillLibraryApi.post('/skill-library/github/inspect', async (c) => {
  const { source } = await requireBody(c, GithubSkillSchema);
  return answer(c, () => inspectGithub(source), false);
});

skillLibraryApi.post('/skill-library/github', async (c) => {
  const { source, pick } = await requireBody(c, GithubSkillSchema);
  return answer(c, async () => ({ skill: await installGithub(c.get('user').id, me(c), source, pick) }));
});

skillLibraryApi.patch('/skill-library/:id', async (c) => {
  const p = await requireBody(c, SkillPatchSchema);
  return answer(c, () => ({ skill: updateSkill(c.get('user').id, c.req.param('id'), { ...p, ...(p.name !== undefined ? { name: p.name.trim() } : {}) }) }));
});

skillLibraryApi.delete('/skill-library/:id', (c) => answer(c, () => { deleteSkill(c.get('user').id, c.req.param('id')); return { ok: true }; }));

skillLibraryApi.put('/skill-library/:id/access/:botId', async (c) => {
  const { allowed } = await requireBody(c, SkillAccessSchema);
  return answer(c, () => ({ skill: setSkillAccess(c.get('user').id, c.req.param('id'), c.req.param('botId'), allowed) }));
});
