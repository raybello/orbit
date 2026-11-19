// tmp-env must be the FIRST import: it points env.ts at a temp DB and Hermes homes.
import { cleanupTmpEnv, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';

const { checkSettings, readSharedSettings, saveSharedSettings } = await import('../hermes-settings.js');
const { managedHome } = await import('../engine.js');
const { readDotenv, readYaml } = await import('../hermes-files.js');
const { db } = await import('../db.js');

/**
 * Settings → API keys: the person edits the primary agent's .env and config.yaml as text, and a save
 * reaches every managed bot. Only what the save changed is copied; what a bot holds on its own, and
 * what belongs to one agent, stays as it was.
 */

const NOW = 1_700_000_000_000;
const USER = 'usr_settings';
after(() => cleanupTmpEnv());

function seed() {
  db.prepare('DELETE FROM bots').run();
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 's@test.local', 'S', NOW);
  for (const [id, engine] of [['bot_primary', 'primary'], ['bot_quill', 'managed'], ['bot_atlas', 'managed']] as const) {
    db.prepare('INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, USER, id, engine, 8700, engine === 'primary' ? 1 : 0, NOW, NOW);
  }
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(path.join(primaryHome, '.env'), '# model keys\nOPENROUTER_API_KEY=sk-or-old\nTELEGRAM_BOT_TOKEN=tg-primary\nAPI_SERVER_KEY=primary-key\n');
  fs.writeFileSync(path.join(primaryHome, 'config.yaml'), YAML.stringify({
    model: { provider: 'anthropic', default: 'claude-sonnet-4-6' },
    search_backend: 'searxng',
    platforms: { telegram: { enabled: true } },
    mcp_servers: { hq: { url: 'http://hq/mcp/primary' }, notes: { url: 'http://notes' } },
  }));
  for (const id of ['bot_quill', 'bot_atlas']) {
    const home = managedHome(id);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.env'), `OPENROUTER_API_KEY=sk-or-old\nAPI_SERVER_KEY=${id}-key\nXAI_API_KEY=${id}-own-xai\n`);
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({
      model: { provider: 'deepseek', default: 'deepseek-flash' },
      search_backend: 'searxng',
      mcp_servers: { hq: { url: `http://hq/mcp/${id}` }, notes: { url: 'http://notes' } },
    }));
  }
}

const botEnv = (id: string) => readDotenv(path.join(managedHome(id), '.env'));
const botCfg = (id: string) => readYaml(path.join(managedHome(id), 'config.yaml'));

test('a save writes the text as typed and copies only the changed keys into every managed bot', () => {
  seed();
  const { env: envText, config } = readSharedSettings();
  const nextEnv = envText.replace('sk-or-old', 'sk-or-new').replace('TELEGRAM_BOT_TOKEN=tg-primary', 'TELEGRAM_BOT_TOKEN=tg-rotated') + 'TAVILY_API_KEY=tv-1\n';
  const cfg = YAML.parse(config);
  cfg.search_backend = 'tavily';
  cfg.mcp_servers.calendar = { url: 'http://cal' };
  cfg.mcp_servers.hq = { url: 'http://elsewhere' };
  cfg.platforms.telegram.enabled = false;

  const r = saveSharedSettings({ env: nextEnv, config: YAML.stringify(cfg) });

  assert.deepEqual(r.updated.sort(), ['bot_atlas', 'bot_quill']);
  assert.equal(readSharedSettings().env, nextEnv, 'the primary keeps exactly what was typed, comments included');
  for (const id of ['bot_quill', 'bot_atlas']) {
    const e = botEnv(id);
    assert.equal(e.OPENROUTER_API_KEY, 'sk-or-new', 'a changed key reaches every bot');
    assert.equal(e.TAVILY_API_KEY, 'tv-1', 'an added key reaches every bot');
    assert.equal(e.XAI_API_KEY, `${id}-own-xai`, 'a key the save did not touch stays the bot\'s own');
    assert.equal(e.API_SERVER_KEY, `${id}-key`, 'the bot keeps its own API server key');
    assert.equal(e.TELEGRAM_BOT_TOKEN, undefined, 'chat-platform tokens are never copied to a bot');
    const c = botCfg(id);
    assert.equal(c.search_backend, 'tavily');
    assert.deepEqual(c.model, { provider: 'deepseek', default: 'deepseek-flash' }, 'the bot keeps the model it chose');
    assert.deepEqual((c.mcp_servers as any).hq, { url: `http://hq/mcp/${id}` }, 'the bot keeps its own app connection');
    assert.deepEqual((c.mcp_servers as any).calendar, { url: 'http://cal' });
    assert.equal(c.platforms, undefined, 'chat platforms stay with the primary');
  }
});

test('a key removed from the shared settings leaves only the bots that held the shared value', () => {
  seed();
  const atlasEnv = path.join(managedHome('bot_atlas'), '.env');
  fs.writeFileSync(atlasEnv, fs.readFileSync(atlasEnv, 'utf8').replace('sk-or-old', 'sk-or-atlas-own'));
  const { env: envText, config } = readSharedSettings();
  const cfg = YAML.parse(config);
  delete cfg.mcp_servers.notes;

  saveSharedSettings({ env: envText.replace('OPENROUTER_API_KEY=sk-or-old\n', ''), config: YAML.stringify(cfg) });

  assert.equal(botEnv('bot_quill').OPENROUTER_API_KEY, undefined);
  assert.equal(botEnv('bot_atlas').OPENROUTER_API_KEY, 'sk-or-atlas-own');
  assert.equal((botCfg('bot_quill').mcp_servers as any).notes, undefined);
  assert.ok((botCfg('bot_quill').mcp_servers as any).hq);
});

test('a save that changes nothing touches no bot', () => {
  seed();
  const before = fs.readFileSync(path.join(managedHome('bot_quill'), '.env'), 'utf8');
  const r = saveSharedSettings(readSharedSettings());
  assert.deepEqual(r, { updated: [], restarting: 0 });
  assert.equal(fs.readFileSync(path.join(managedHome('bot_quill'), '.env'), 'utf8'), before);
});

test('text that is not a valid .env or config is named with its line and never written', () => {
  assert.deepEqual(checkSettings({ env: 'A=1\nnot a pair\n' }), { file: 'env', line: 2, message: 'Expected KEY=value' });
  const bad = checkSettings({ config: 'model:\n  provider: [unclosed\n' });
  assert.equal(bad?.file, 'config');
  assert.ok(bad?.line);
  assert.equal(checkSettings({ config: '- a list\n' })?.message, 'The config must be a mapping of keys to values');
  assert.equal(checkSettings({ env: '# only a comment\n\nexport K=v\n', config: '' }), null);
});
