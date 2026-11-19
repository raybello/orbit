// api-env must be the FIRST import: it isolates env.ts, the DB and the Hermes homes, and makes
// HERMES_BIN `true` so a gateway start writes the home and then fails at once.
import { cleanupTmpEnv } from './helpers/api-env.js';
import { enginesDir, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import YAML from 'yaml';

process.env.MAX_BOTS = '6';
delete process.env.DEFAULT_BOT_PROVIDER;
delete process.env.DEFAULT_BOT_MODEL;

const { applyModelChoice, readYaml } = await import('../hermes-files.js');
const { createBotFor } = await import('../bot-admin.js');
const { engineFor } = await import('../engine.js');
const { BOT_TOOLS } = await import('../agent/bot-tools.js');
const { db } = await import('../db.js');
await import('../db-config.js');
// The bots table gets `kind` and `hidden` from these, as the server does at start.
(await import('../agent/subagents.js')).initSubagents();
(await import('../agent/rooms.js')).initRooms();

after(() => cleanupTmpEnv());

const STRATA = { base_url: 'http://10.0.0.92:8080/v1', key_env: 'HERMES_CUSTOM_STRATA_API_KEY', api_mode: 'chat_completions' };

describe('applyModelChoice', () => {
  test('switching to a provider the config does not define drops the old endpoint', () => {
    const cfg = { model: { provider: 'strata', default: 'qwen3', base_url: STRATA.base_url, api_mode: 'chat_completions' }, providers: { strata: STRATA } };
    applyModelChoice(cfg, 'anthropic', 'claude-sonnet-4-6');
    assert.deepEqual(cfg.model, { provider: 'anthropic', default: 'claude-sonnet-4-6' });
  });

  test('a provider the config defines brings its base_url and api_mode, never its key', () => {
    const cfg = { model: { provider: 'anthropic', default: 'claude-sonnet-4-6' }, providers: { strata: STRATA } };
    applyModelChoice(cfg, 'strata', 'qwen3');
    assert.deepEqual(cfg.model, { provider: 'strata', default: 'qwen3', base_url: STRATA.base_url, api_mode: 'chat_completions' });
  });

  test('a custom_providers entry is found by name, as a list or a map', () => {
    const list: Record<string, unknown> = { custom_providers: [{ name: 'lab', base_url: 'http://lab/v1' }] };
    applyModelChoice(list, 'custom:lab', 'm1');
    assert.deepEqual(list.model, { provider: 'custom:lab', default: 'm1', base_url: 'http://lab/v1' });
    const map: Record<string, unknown> = { custom_providers: { lab: { base_url: 'http://lab/v1', api_mode: 'responses' } } };
    applyModelChoice(map, 'lab', 'm1');
    assert.deepEqual(map.model, { provider: 'lab', default: 'm1', base_url: 'http://lab/v1', api_mode: 'responses' });
  });
});

const USER = 'usr_model_choice';
db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'model@test.local', 'Model Test', Date.now());
fs.writeFileSync(path.join(primaryHome, 'config.yaml'), YAML.stringify({ model: { provider: 'anthropic', default: 'claude-sonnet-4-6' }, providers: { strata: STRATA } }));

const primary = createBotFor(USER, { name: 'Atlas', isPrimary: true });
const row = (id: string) => db.prepare('SELECT provider, model FROM bots WHERE id=?').get(id) as { provider: string | null; model: string | null };

describe('creating a bot', () => {
  test('the primary and any bot created without a choice get Claude Sonnet 4.6', () => {
    assert.deepEqual(row(primary.id), { provider: 'anthropic', model: 'claude-sonnet-4-6' });
    const plain = createBotFor(USER, { name: 'Plain' });
    assert.deepEqual(row(plain.id), { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  test('a chosen model is stored, and starting the bot writes it into its config.yaml', async () => {
    const bot = createBotFor(USER, { name: 'Local', modelChoice: { provider: 'strata', model: 'qwen3' } });
    assert.deepEqual(row(bot.id), { provider: 'strata', model: 'qwen3' });
    await assert.rejects(engineFor(bot.id));
    const cfg = readYaml(path.join(enginesDir, bot.id, 'config.yaml'));
    assert.deepEqual(cfg.model, { provider: 'strata', default: 'qwen3', base_url: STRATA.base_url, api_mode: 'chat_completions' });
  });
});

const tool = (name: string) => BOT_TOOLS.find((t) => t.name === name)!;
const ctx = { userId: USER, botId: primary.id, enqueueBotMessage: () => {}, depth: 0 };

describe('create_bot', () => {
  test('passes provider and model through to the new bot', async () => {
    const res = await tool('create_bot').impl({ name: 'Scout', provider: 'openai-codex', model: 'gpt-5.5' }, ctx);
    assert.equal(JSON.parse(res.output).bot.model, 'gpt-5.5');
    const id = (db.prepare("SELECT id FROM bots WHERE name='Scout'").get() as { id: string }).id;
    assert.deepEqual(row(id), { provider: 'openai-codex', model: 'gpt-5.5' });
  });

  test('refuses half a choice and creates nothing', async () => {
    const res = await tool('create_bot').impl({ name: 'Half', model: 'gpt-5.5' }, ctx);
    assert.match(res.output, /provider and model go together/);
    assert.equal(db.prepare("SELECT 1 FROM bots WHERE name='Half'").get(), undefined);
  });
});

describe('list_models', () => {
  test('lists the connected providers only, with their models', async () => {
    await engineFor(primary.id).catch(() => {});
    const options = {
      providers: [
        { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-sonnet-4-6', 'claude-opus-4-1'] },
        { slug: 'openai-codex', name: 'OpenAI Codex', authenticated: false, models: ['gpt-5.5'] },
      ],
    };
    const gateway = http.createServer((req, res) => {
      req.resume();
      if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      if (req.url === '/api/model/options') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(options));
      res.writeHead(200).end('{}');
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      db.prepare('UPDATE bots SET engine_port=? WHERE id=?').run((gateway.address() as AddressInfo).port, primary.id);
      const { output } = await tool('list_models').impl({}, ctx);
      assert.match(output, /- anthropic \(Claude \(Anthropic\)\): claude-sonnet-4-6, claude-opus-4-1/);
      assert.doesNotMatch(output, /openai-codex/);
      assert.match(output, /Default for a new Bot: provider anthropic, model claude-sonnet-4-6/);
    } finally {
      gateway.close();
    }
  });
});

const { createApp } = await import('../api/app.js');
const { issueSessionToken } = await import('../lib/auth.js');
const app = createApp();
const authed = () => ({ authorization: `Bearer ${issueSessionToken(USER).token}`, 'content-type': 'application/json' });

describe('the HTTP routes', () => {
  test('GET /api/models names the model a new Bot gets', async () => {
    const res = await app.request('/api/models', { headers: authed() });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).default, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  test('POST /api/bots refuses a model without its provider', async () => {
    const res = await app.request('/api/bots', { method: 'POST', headers: authed(), body: JSON.stringify({ name: 'Half', model: 'gpt-5.5' }) });
    assert.equal(res.status, 400);
  });

  test('PUT engine-auth moving off a custom provider drops its base_url', async () => {
    const id = (db.prepare("SELECT id FROM bots WHERE name='Local'").get() as { id: string }).id;
    const res = await app.request(`/api/config/engine-auth/${id}`, { method: 'PUT', headers: authed(), body: JSON.stringify({ provider: 'anthropic', model: 'claude-opus-4-1' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(readYaml(path.join(enginesDir, id, 'config.yaml')).model, { provider: 'anthropic', default: 'claude-opus-4-1' });
    assert.deepEqual(row(id), { provider: 'anthropic', model: 'claude-opus-4-1' });
  });
});
