import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { asUserId } from '@orbit/contracts';
import { planBotCreation } from '../core/bot-service.js';
import { pickAvatar } from '../core/avatar.js';
import {
  AppConnectSchema,
  ApprovalDecisionSchema,
  CardAnswerSchema,
  CardDismissSchema,
  CreateBotSchema,
  DevLoginSchema,
  optionalBody,
  OwnerSignInSchema,
  PatchBotSchema,
  PushRegisterSchema,
  PushTokenQuerySchema,
  requireBody,
  RoutineEnableSchema,
  ScreenControlSchema,
  SendMessageSchema,
  SignInSchema,
} from '../api/schemas.js';

/**
 * The boundary: every JSON body routes.ts reads is parsed by a schema, and a body that is not JSON or
 * not the right shape becomes a 400 `{ error }` — not a 500, and not a value that reaches SQLite.
 *
 * The app below copies api/app.ts's onError exactly: HTTPException renders `{ error }` with its own
 * status. (createApp itself is not imported here on purpose — it opens the database.)
 */

const planDeps = {
  canAddBot: () => true,
  maxBots: 4,
  newBotId: () => 'bot_test',
  pickAvatar: (id: string, shape?: string, color?: string) => pickAvatar(id, shape, color),
  defaultModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

function errorApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.text('Internal Server Error', 500);
  });
  // POST /bots: the real boundary + the real core, so "an empty body creates New Bot" is proved end to end.
  app.post('/bots', async (c) => {
    const body = await requireBody(c, CreateBotSchema);
    const plan = planBotCreation({ ...body, userId: asUserId('usr_1') }, planDeps);
    return c.json({ name: plan.name, mode: plan.mode, voiceModel: plan.voiceModel, state: plan.state });
  });
  app.post('/approvals', async (c) => c.json({ body: await requireBody(c, ApprovalDecisionSchema) }));
  app.post('/routines', async (c) => c.json({ body: await requireBody(c, RoutineEnableSchema) }));
  app.post('/answer', async (c) => c.json({ body: await requireBody(c, CardAnswerSchema) }));
  app.post('/patch', async (c) => c.json({ body: await requireBody(c, PatchBotSchema) }));
  app.post('/messages', async (c) => c.json({ body: await requireBody(c, SendMessageSchema) }));
  app.post('/optional', async (c) => c.json({ body: await optionalBody(c, PushTokenQuerySchema, {}) }));
  return app;
}

const post = (app: Hono, path: string, body?: string) =>
  app.request(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });

describe('requireBody', () => {
  test('an empty object body is accepted by POST /bots and creates "New Bot"', async () => {
    const res = await post(errorApp(), '/bots', '{}');
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.name, 'New Bot');
    assert.equal(body.mode, 'personal');
    assert.equal(body.voiceModel, 'piper-lessac-medium');
    assert.deepEqual(body.state, { status: 'created', botId: 'bot_test' });
  });

  test('a named body keeps the name', async () => {
    const res = await post(errorApp(), '/bots', JSON.stringify({ name: '  Ada  ', mode: 'teammate', voiceProvider: 'local' }));
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.name, 'Ada');
    assert.equal(body.mode, 'teammate');
  });

  test('malformed JSON is a 400 with the error shape clients parse', async () => {
    const res = await post(errorApp(), '/bots', '{"name":');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
  });

  test('no body at all is a 400, not a 500', async () => {
    const res = await post(errorApp(), '/bots');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
  });

  test('a wrong type names the field', async () => {
    const res = await post(errorApp(), '/bots', JSON.stringify({ name: 5 }));
    assert.equal(res.status, 400);
    const body = await res.json() as any;
    assert.match(body.error, /name/);
  });

  test('a missing required field is a 400', async () => {
    const res = await post(errorApp(), '/approvals', '{}');
    assert.equal(res.status, 400);
    assert.match((await res.json() as any).error, /decision/);

    const enabled = await post(errorApp(), '/routines', JSON.stringify({ enabled: 'yes' }));
    assert.equal(enabled.status, 400);
    assert.match((await enabled.json() as any).error, /enabled/);

    const answer = await post(errorApp(), '/answer', JSON.stringify({}));
    assert.equal(answer.status, 400);
  });

  test('valid bodies parse', async () => {
    for (const [path, body] of [
      ['/approvals', { decision: 'always' }],
      ['/routines', { enabled: false }],
      ['/answer', { answer: 'Work' }],
      ['/messages', { text: 'hello' }],
      ['/messages', { text: 'hello', files: [{ path: 'attachments/a.png', filename: 'a.png', mediaType: 'image/png' }] }],
    ] as const) {
      const res = await post(errorApp(), path, JSON.stringify(body));
      assert.equal(res.status, 200, `${path} rejected ${JSON.stringify(body)}`);
    }
  });
});

describe('optionalBody', () => {
  test('no body yields the fallback instead of a 400', async () => {
    const res = await post(errorApp(), '/optional');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: {} });
  });

  test('malformed JSON yields the fallback, as the DELETE push route expects', async () => {
    const res = await post(errorApp(), '/optional', 'not json');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { body: {} });
  });

  test('a valid body is parsed', async () => {
    const res = await post(errorApp(), '/optional', JSON.stringify({ token: 'ExponentPushToken[1]' }));
    assert.deepEqual(await res.json(), { body: { token: 'ExponentPushToken[1]' } });
  });
});

describe('schemas', () => {
  test('CreateBotSchema is loose and optional in every field', () => {
    assert.equal(CreateBotSchema.safeParse({}).success, true);
    assert.equal(CreateBotSchema.safeParse({ name: 'Ada', extra: { anything: true } }).success, true);
    assert.equal(CreateBotSchema.safeParse({ isPrimary: true }).success, true);
    assert.equal(CreateBotSchema.safeParse({ isPrimary: 'yes' }).success, false);
    assert.equal(CreateBotSchema.safeParse({ name: null }).success, false);
    assert.equal(CreateBotSchema.safeParse([]).success, false);
  });

  test('CreateBotSchema takes a model choice only as a provider and model pair', () => {
    const both = CreateBotSchema.safeParse({ name: 'Ada', provider: ' openai ', model: 'gpt-5' });
    assert.deepEqual(both.success && both.data.modelChoice, { provider: 'openai', model: 'gpt-5' });
    const neither = CreateBotSchema.safeParse({ name: 'Ada' });
    assert.equal(neither.success && 'modelChoice' in neither.data, false);
    assert.equal(CreateBotSchema.safeParse({ provider: 'openai' }).success, false, 'a provider alone is refused');
    assert.equal(CreateBotSchema.safeParse({ model: 'gpt-5' }).success, false, 'a model alone is refused');
    assert.equal(CreateBotSchema.safeParse({ provider: 'openai', model: '' }).success, false);
    assert.equal(CreateBotSchema.safeParse({ provider: 'openai', model: 'gpt 5' }).success, false);
    assert.equal(CreateBotSchema.safeParse({ provider: 'openai', model: 'x'.repeat(121) }).success, false);
  });

  test('PatchBotSchema types each allow-listed key by its column', () => {
    assert.equal(PatchBotSchema.safeParse({ pinned: true }).success, true);
    assert.equal(PatchBotSchema.safeParse({ pinned: 1 }).success, true);
    assert.equal(PatchBotSchema.safeParse({ voiceSpeed: 1.25 }).success, true);
    assert.equal(PatchBotSchema.safeParse({ voiceSpeed: 'fast' }).success, false);
    assert.equal(PatchBotSchema.safeParse({ pinned: 'yes' }).success, false);
    assert.equal(PatchBotSchema.safeParse({ name: 42 }).success, false);
    // Loose: keys the route does not act on are not rejected.
    assert.equal(PatchBotSchema.safeParse({ name: 'Ada', unknownKey: { deep: true } }).success, true);
    assert.deepEqual(PatchBotSchema.parse({ name: 'Ada', unknownKey: 1 }).unknownKey, 1);
  });

  test('SendMessageSchema keeps text optional for the route\'s own "empty" answer', () => {
    assert.equal(SendMessageSchema.safeParse({}).success, true);
    assert.equal(SendMessageSchema.safeParse({ text: 5 }).success, false);
    assert.equal(SendMessageSchema.safeParse({ files: [{ path: 'a', filename: 'a', mediaType: 'text/plain' }] }).success, true);
    assert.equal(SendMessageSchema.safeParse({ files: [{ path: 'a' }] }).success, false);
  });

  test('ApprovalDecisionSchema only allows the three decisions the UI offers', () => {
    for (const decision of ['allow', 'always', 'deny']) assert.equal(ApprovalDecisionSchema.safeParse({ decision }).success, true);
    for (const decision of ['approved', 'ALLOW', '', undefined, 1]) assert.equal(ApprovalDecisionSchema.safeParse({ decision }).success, false);
  });

  test('the remaining bodies have the shape the routes read', () => {
    assert.equal(DevLoginSchema.safeParse({ email: 'a@b.c', name: 'A' }).success, true);
    assert.equal(DevLoginSchema.safeParse({}).success, true);
    assert.equal(SignInSchema.safeParse({ email: 'a@b.c', ownerKey: 'k' }).success, true);
    assert.equal(OwnerSignInSchema.safeParse({ email: 'a@b.c', link: true }).success, true);
    assert.equal(OwnerSignInSchema.safeParse({ email: 'a@b.c', link: 'yes' }).success, false);
    assert.equal(PushRegisterSchema.safeParse({ token: 't', platform: 'ios' }).success, true);
    assert.equal(PushTokenQuerySchema.safeParse({}).success, true);
    assert.equal(CardDismissSchema.safeParse({}).success, true);
    assert.equal(ScreenControlSchema.safeParse({ action: 'take' }).success, true);
    assert.equal(ScreenControlSchema.safeParse({}).success, true);
    assert.equal(AppConnectSchema.safeParse({ botId: 'bot_1', seq: 3 }).success, true);
    assert.equal(AppConnectSchema.safeParse({ seq: '3' }).success, false);
    assert.equal(AppConnectSchema.safeParse({}).success, true);
    assert.equal(CardAnswerSchema.safeParse({ answer: 'Work' }).success, true);
    assert.equal(CardAnswerSchema.safeParse({}).success, false);
    assert.equal(RoutineEnableSchema.safeParse({ enabled: true }).success, true);
    assert.equal(RoutineEnableSchema.safeParse({}).success, false);
  });
});
