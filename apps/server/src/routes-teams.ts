import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { requireBody } from './api/schemas.js';
import { createTeam, listTeamTemplates, getTeamTemplate } from './teams.js';

export const teamsApi = new Hono<AuthVars>();

const CreateTeamSchema = z.object({
  slug: z.string(),
  name: z.string().optional(),
  schedule: z.string().optional(),
  timezone: z.string().optional(),
}).strict();

interface TeamTemplateSummary {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  schedule: string;
  memberCount: number;
}

teamsApi.get('/team-templates', (c) => {
  const templates: TeamTemplateSummary[] = listTeamTemplates().map((t) => ({
    slug: t.slug,
    name: t.name,
    tagline: t.tagline,
    description: t.description,
    schedule: t.schedule,
    memberCount: t.members.length,
  }));
  return c.json({ templates });
});

teamsApi.get('/team-templates/:slug', (c) => {
  const t = getTeamTemplate(c.req.param('slug'));
  if (!t) return c.json({ error: 'Template not found' }, 404);
  return c.json({ template: t });
});

teamsApi.post('/teams', requireUser, async (c) => {
  const body = await requireBody(c, CreateTeamSchema);
  const userId = c.get('user').id;
  try {
    const result = createTeam(userId, body.slug, {
      name: body.name,
      schedule: body.schedule,
      timezone: body.timezone,
    });
    return c.json({ bots: result.bots, roomId: result.roomId, routineId: result.routineId }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return c.json({ error: msg }, 400);
  }
});
