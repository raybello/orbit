import { Hono } from 'hono';
import { z } from 'zod';
import type { DuplicateBotResponse, InstallTemplateResponse, ShareTemplateResponse, TemplateResponse, TemplatesResponse } from '@orbit/contracts';
import { requireUser, type AuthVars } from './lib/auth.js';
import { optionalBody, requireBody } from './api/schemas.js';
import { duplicateBotFor } from './bot-blueprint.js';
import { deleteTemplateFor, getTemplate, installTemplate, listPublicTemplates, shareBotAsTemplate, shareUrlFor } from './templates.js';

/**
 * Bot duplication (F2) and templates (F6, F7).
 *
 * routes.ts mounts this ahead of its own sign-in middleware because the two GETs are public: a share
 * link has to show what it installs before the person signs in. Every other route takes requireUser
 * per route, never through `use('*')`, which would reach every path routes.ts serves.
 */
export const templatesApi = new Hono<AuthVars>();

const ShareTemplateSchema = z.object({ visibility: z.enum(['link', 'public']).optional() }).loose();
const InstallTemplateSchema = z.object({ name: z.string().optional(), timezone: z.string().optional() }).loose();

templatesApi.post('/bots/:id/duplicate', requireUser, (c) => {
  return c.json({ bot: duplicateBotFor(c.get('user').id, c.req.param('id')) } satisfies DuplicateBotResponse);
});

// requireBody, not optionalBody: an unknown visibility must be refused, not quietly kept as it was.
templatesApi.post('/bots/:id/template', requireUser, async (c) => {
  const body = await requireBody(c, ShareTemplateSchema);
  const template = shareBotAsTemplate(c.get('user').id, c.req.param('id'), { visibility: body.visibility });
  return c.json({ template, shareUrl: shareUrlFor(template.id) } satisfies ShareTemplateResponse);
});

templatesApi.get('/templates', (c) => {
  const templates = listPublicTemplates();
  const categories = [...new Set(templates.map((t) => t.category).filter(Boolean))].sort();
  return c.json({ templates, categories } satisfies TemplatesResponse);
});

templatesApi.get('/templates/:id', (c) => {
  const template = getTemplate(c.req.param('id'));
  return template ? c.json({ template } satisfies TemplateResponse) : c.json({ error: 'No such template.' }, 404);
});

templatesApi.post('/templates/:id/install', requireUser, async (c) => {
  const body = await optionalBody(c, InstallTemplateSchema, {});
  return c.json({ bot: installTemplate(c.req.param('id'), c.get('user').id, body) } satisfies InstallTemplateResponse);
});

templatesApi.delete('/templates/:id', requireUser, (c) => {
  deleteTemplateFor(c.get('user').id, c.req.param('id'));
  return c.json({ ok: true });
});
