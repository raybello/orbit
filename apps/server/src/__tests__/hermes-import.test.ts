import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';
import { IMPORT_MARKER, importHostHermes } from '../hermes-import.js';
import { readDotenv, readYaml } from '../hermes-files.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-import-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A person's own Hermes home, with everything a real one holds. */
function hostHome(): string {
  const src = fs.mkdtempSync(path.join(root, 'host-'));
  fs.writeFileSync(path.join(src, '.env'), [
    'ANTHROPIC_API_KEY=sk-ant-host',
    'DEEPSEEK_API_KEY=sk-deepseek-host',
    'TELEGRAM_BOT_TOKEN=123:telegram',
    'DISCORD_BOT_TOKEN=discord',
    'API_SERVER_KEY=host-api-key',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(src, 'config.yaml'), YAML.stringify({
    model: { provider: 'anthropic', default: 'claude-sonnet' },
    providers: { local: { base_url: 'http://localhost:1234/v1' } },
    mcp_servers: { github: { url: 'https://github.example/mcp' } },
    platforms: { telegram: { enabled: true } },
  }));
  fs.writeFileSync(path.join(src, 'SOUL.md'), 'I am the person\'s own agent.\n');
  fs.mkdirSync(path.join(src, 'memories'));
  fs.writeFileSync(path.join(src, 'memories', 'MEMORY.md'), 'Likes short answers.\n');
  fs.mkdirSync(path.join(src, 'skills', 'triage'), { recursive: true });
  fs.writeFileSync(path.join(src, 'skills', 'triage', 'SKILL.md'), '# Triage\n');
  fs.writeFileSync(path.join(src, 'auth.json'), JSON.stringify({ credential_pool: { anthropic: [{ refresh_token: 'single-use' }] } }));
  fs.writeFileSync(path.join(src, '.anthropic_oauth.json'), '{"refresh_token":"single-use"}');
  return src;
}

test('the import copies model keys, model config, persona, memories and skills', () => {
  const src = hostHome();
  const dest = path.join(root, 'primary-a');
  assert.equal(importHostHermes(src, dest), 'imported');

  assert.deepEqual(readDotenv(path.join(dest, '.env')), { ANTHROPIC_API_KEY: 'sk-ant-host', DEEPSEEK_API_KEY: 'sk-deepseek-host' });
  assert.deepEqual(readYaml(path.join(dest, 'config.yaml')), {
    model: { provider: 'anthropic', default: 'claude-sonnet' },
    providers: { local: { base_url: 'http://localhost:1234/v1' } },
  });
  assert.equal(fs.readFileSync(path.join(dest, 'SOUL.md'), 'utf8'), 'I am the person\'s own agent.\n');
  assert.equal(fs.readFileSync(path.join(dest, 'memories', 'MEMORY.md'), 'utf8'), 'Likes short answers.\n');
  assert.equal(fs.readFileSync(path.join(dest, 'skills', 'triage', 'SKILL.md'), 'utf8'), '# Triage\n');
});

test('the import carries sign-ins but never a messaging token or the person\'s tools', () => {
  const src = hostHome();
  const dest = path.join(root, 'primary-b');
  importHostHermes(src, dest);

  assert.ok(fs.existsSync(path.join(dest, 'auth.json')), 'subscription sign-ins come across');
  assert.ok(fs.existsSync(path.join(dest, '.anthropic_oauth.json')));
  const vars = readDotenv(path.join(dest, '.env'));
  for (const k of ['TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'API_SERVER_KEY']) assert.equal(vars[k], undefined, `${k} must stay behind`);
  const cfg = readYaml(path.join(dest, 'config.yaml'));
  assert.equal(cfg.mcp_servers, undefined);
  assert.equal(cfg.platforms, undefined);
  assert.equal(fs.statSync(path.join(dest, '.env')).mode & 0o777, 0o600);
});

test('the import runs once and never overwrites what the primary already has', () => {
  const src = hostHome();
  const dest = path.join(root, 'primary-c');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, '.env'), 'ANTHROPIC_API_KEY=sk-ant-signed-in-here\n');
  fs.writeFileSync(path.join(dest, 'SOUL.md'), 'Already mine.\n');

  assert.equal(importHostHermes(src, dest), 'imported');
  assert.equal(readDotenv(path.join(dest, '.env')).ANTHROPIC_API_KEY, 'sk-ant-signed-in-here');
  assert.equal(fs.readFileSync(path.join(dest, 'SOUL.md'), 'utf8'), 'Already mine.\n');
  assert.ok(fs.existsSync(path.join(dest, IMPORT_MARKER)));

  fs.writeFileSync(path.join(src, '.env'), 'OPENAI_API_KEY=sk-openai-later\n');
  assert.equal(importHostHermes(src, dest), 'already-imported');
  assert.equal(readDotenv(path.join(dest, '.env')).OPENAI_API_KEY, undefined, 'a second run changes nothing');
});

test('no Hermes home to import from leaves the primary untouched and the import still pending', () => {
  const dest = path.join(root, 'primary-d');
  assert.equal(importHostHermes(path.join(root, 'missing'), dest), 'no-source');
  assert.ok(!fs.existsSync(dest));
});
