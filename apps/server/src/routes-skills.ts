import { Hono } from 'hono';
import { db } from './db.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { engineKind } from './engine.js';
import { getSkillEntries, getSkillEntry, setMcpServerEnabled } from './skills-config.js';

/** /api/skills: the primary agent's MCP servers, and which bots have each one. */
export const skillsApi = new Hono<AuthVars>();
skillsApi.use('*', requireUser);

skillsApi.get('/skills', (c) => {
  const user = c.get('user');
  return c.json({ skills: getSkillEntries(user.id) });
});

/** Toggle one skill for one bot: { enabled: boolean }. */
skillsApi.put('/skills/:botId/:skillName', async (c) => {
  const user = c.get('user');
  const botId = c.req.param('botId');
  const skillName = c.req.param('skillName');

  const bot = db.prepare('SELECT id FROM bots WHERE id=? AND user_id=?').get(botId, user.id);
  if (!bot) return c.json({ error: 'not found' }, 404);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Expected a JSON body: { "enabled": true | false }.' }, 400);
  }
  if (typeof body?.enabled !== 'boolean') return c.json({ error: '"enabled" must be true or false.' }, 400);

  if (engineKind(botId) === 'primary') {
    return c.json({ error: "The primary agent's skills are read-only. They come from its own Hermes config." }, 409);
  }

  try {
    setMcpServerEnabled(botId, skillName, body.enabled);
  } catch (e: any) {
    return c.json({ error: String(e?.message ?? e) }, 400);
  }

  const skill = getSkillEntry(user.id, skillName);
  if (!skill) return c.json({ error: `The primary agent does not define a skill named "${skillName}".` }, 404);
  return c.json({ skill });
});
