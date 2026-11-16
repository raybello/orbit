import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AuthVars } from './lib/auth.js';
import { requireBody } from './api/schemas.js';
import { MAX_IDLE_HOURS } from './domain/initiative.js';
import { getInitiativeSettings, InitiativeSettingsError, setInitiativeSettings } from './proactive.js';

/** /api/initiative: the primary Bot's morning briefing and the idle threshold for its check-ins. */
export const initiativeApi = new Hono<AuthVars>();
initiativeApi.use('*', requireUser);

const InitiativeSettingsSchema = z.object({
  idleHours: z.number().int().min(0).max(MAX_IDLE_HOURS).optional(),
  briefing: z
    .object({
      enabled: z.boolean().optional(),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM').optional(),
      timezone: z.string().min(1).optional(),
    })
    .optional(),
});

initiativeApi.get('/', (c) => c.json(getInitiativeSettings(c.get('user').id)));

initiativeApi.put('/', async (c) => {
  const body = await requireBody(c, InitiativeSettingsSchema);
  try {
    return c.json(setInitiativeSettings(c.get('user').id, body));
  } catch (e) {
    if (e instanceof InitiativeSettingsError) return c.json({ error: e.message }, 400);
    throw e;
  }
});
