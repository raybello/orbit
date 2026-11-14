// tmp-env must be the FIRST import: it points env.ts at a temp DB and Hermes homes.
import { cleanupTmpEnv, primaryHome } from './helpers/tmp-env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import YAML from 'yaml';

// Loaded dynamically so env.ts (and the db it names) read the temp paths above.
const { inheritSubscriptions, managedHome, primarySubscriptions, readDotenv, readYaml, subscriptionEnv, syncAllManagedAuth, syncManagedAuth, writePrivate } = await import('../engine.js');
const { db } = await import('../db.js');

/**
 * Credential syncing: a managed bot must inherit the primary agent's model keys, but it must never
 * lose a key the primary does not have, and it must keep the config it chose for itself. These
 * tests run against a throwaway DB and throwaway homes (see helpers/tmp-env.ts).
 */

const NOW = 1_700_000_000_000;
const USER = 'usr_authtest';

const primaryEnvFile = path.join(primaryHome, '.env');
const primaryCfgFile = path.join(primaryHome, 'config.yaml');

function resetBots() {
  db.prepare('DELETE FROM bots').run();
  db.prepare('INSERT OR REPLACE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(USER, 'auth@test.local', 'Auth Test', NOW);
}

function addBot(id: string, engine: 'primary' | 'managed'): string {
  db.prepare(
    'INSERT INTO bots(id,user_id,name,engine,engine_port,is_primary,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, USER, id, engine, engine === 'managed' ? 8700 : null, engine === 'primary' ? 1 : 0, NOW, NOW);
  return id;
}

/** Write the primary agent's files: `vars` as .env, `cfg` as config.yaml. */
function primaryFiles(vars: Record<string, string>, cfg: any = {}) {
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(primaryEnvFile, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(primaryCfgFile, YAML.stringify(cfg));
}

/** Write a managed bot's .env and config.yaml. */
function managedFiles(botId: string, vars: Record<string, string>, cfg: any = {}) {
  const home = managedHome(botId);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify(cfg));
}

const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

test('a key the primary leaves empty is not copied over the managed value', () => {
  resetBots();
  const bot = addBot('bot_empty_primary', 'managed');
  primaryFiles({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'sk-primary-openai' }, {});
  managedFiles(bot, { ANTHROPIC_API_KEY: 'sk-managed-anthropic', API_SERVER_KEY: 'k' }, { model: { provider: 'own' } });

  const synced = syncManagedAuth(bot);

  const vars = readDotenv(path.join(managedHome(bot), '.env'));
  assert.equal(vars.ANTHROPIC_API_KEY, 'sk-managed-anthropic', 'the empty primary value must not wipe the bot key');
  assert.equal(vars.OPENAI_API_KEY, 'sk-primary-openai', 'the key the primary does have is shared');
  assert.equal(vars.API_SERVER_KEY, 'k', 'keys that are not shared stay as they were');
  assert.ok(synced.includes('OPENAI_API_KEY'));
  assert.ok(!synced.includes('ANTHROPIC_API_KEY'));
});

test('a populated primary key is written into the managed .env, mode 0600', () => {
  resetBots();
  const bot = addBot('bot_copy', 'managed');
  primaryFiles({ ANTHROPIC_API_KEY: 'sk-primary-new', DEEPSEEK_API_KEY: 'sk-deepseek' }, {});
  managedFiles(bot, { ANTHROPIC_API_KEY: 'sk-managed-old' }, { model: { provider: 'deepseek', default: 'deepseek-flash' } });

  const synced = syncManagedAuth(bot);

  const envFile = path.join(managedHome(bot), '.env');
  const vars = readDotenv(envFile);
  assert.equal(vars.ANTHROPIC_API_KEY, 'sk-primary-new');
  assert.equal(vars.DEEPSEEK_API_KEY, 'sk-deepseek');
  assert.equal(modeOf(envFile), 0o600);
  assert.deepEqual(synced.sort(), ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']);
});

test('a rotated env key is overwritten while the config the bot chose is preserved', () => {
  resetBots();
  const bot = addBot('bot_keep_config', 'managed');
  primaryFiles(
    { ANTHROPIC_API_KEY: 'sk-primary-rotated' },
    { model: { provider: 'anthropic', default: 'claude-sonnet' }, providers: { anthropic: { base_url: 'https://api.anthropic.com' } } },
  );
  managedFiles(
    bot,
    { ANTHROPIC_API_KEY: 'sk-stale' },
    { model: { provider: 'deepseek', default: 'deepseek-chat' }, platform_toolsets: { api_server: ['hermes-api-server'] } },
  );

  syncManagedAuth(bot);

  const home = managedHome(bot);
  assert.equal(readDotenv(path.join(home, '.env')).ANTHROPIC_API_KEY, 'sk-primary-rotated');
  const cfg = readYaml(path.join(home, 'config.yaml'));
  assert.deepEqual(cfg.model, { provider: 'deepseek', default: 'deepseek-chat' }, 'its own model must survive a sync');
  assert.deepEqual(cfg.providers, { anthropic: { base_url: 'https://api.anthropic.com' } }, 'a config key it never had is copied');
  assert.deepEqual(cfg.platform_toolsets, { api_server: ['hermes-api-server'] }, 'the rest of the config is untouched');
  assert.equal(modeOf(path.join(home, 'config.yaml')), 0o600);
});

test('a config key absent from the managed config is copied from the primary', () => {
  resetBots();
  const bot = addBot('bot_copy_config', 'managed');
  primaryFiles(
    {},
    { auxiliary: { title_model: 'claude-haiku' }, fallback_model: 'claude-sonnet', custom_providers: { mine: { base_url: 'http://x' } } },
  );
  managedFiles(bot, {}, { agent: { reasoning_effort: 'medium' } });

  const synced = syncManagedAuth(bot);

  const cfg = readYaml(path.join(managedHome(bot), 'config.yaml'));
  assert.deepEqual(cfg.auxiliary, { title_model: 'claude-haiku' });
  assert.equal(cfg.fallback_model, 'claude-sonnet');
  assert.deepEqual(cfg.custom_providers, { mine: { base_url: 'http://x' } });
  assert.deepEqual(cfg.agent, { reasoning_effort: 'medium' });
  assert.deepEqual(synced.sort(), ['auxiliary', 'custom_providers', 'fallback_model']);
});

test('the primary bot is never touched by a sync', () => {
  resetBots();
  const bot = addBot('bot_primary', 'primary');
  primaryFiles({ ANTHROPIC_API_KEY: 'sk-primary' }, { model: { provider: 'anthropic' } });

  const synced = syncManagedAuth(bot);

  assert.deepEqual(synced, []);
  assert.equal(readDotenv(primaryEnvFile).ANTHROPIC_API_KEY, 'sk-primary');
});

test('syncAllManagedAuth reaches every managed bot and is idempotent', async () => {
  resetBots();
  const a = addBot('bot_sync_a', 'managed');
  const b = addBot('bot_sync_b', 'managed');
  addBot('bot_sync_primary', 'primary');
  primaryFiles({ DEEPSEEK_API_KEY: 'sk-deepseek', XAI_API_KEY: 'xai-1' }, { model: { provider: 'deepseek', default: 'deepseek-flash' } });
  // Empty homes: this is what a freshly created bot looks like before its first sync.
  for (const id of [a, b]) managedFiles(id, {}, {});

  const first = await syncAllManagedAuth();
  assert.equal(first, 2, 'both managed bots are synced, the primary is not');

  for (const id of [a, b]) {
    const home = managedHome(id);
    const vars = readDotenv(path.join(home, '.env'));
    assert.equal(vars.DEEPSEEK_API_KEY, 'sk-deepseek');
    assert.equal(vars.XAI_API_KEY, 'xai-1');
    assert.deepEqual(readYaml(path.join(home, 'config.yaml')).model, { provider: 'deepseek', default: 'deepseek-flash' });
  }

  const second = await syncAllManagedAuth();
  assert.equal(second, 0, 'nothing left to bring in line');
});

test('a sync leaves a home that is already in line byte-for-byte alone', () => {
  resetBots();
  const bot = addBot('bot_idempotent', 'managed');
  primaryFiles({ ANTHROPIC_API_KEY: 'sk-same' }, { model: { provider: 'anthropic' } });
  managedFiles(bot, { ANTHROPIC_API_KEY: 'sk-same' }, { model: { provider: 'anthropic' } });

  // Readable file inside the managed home must not be rewritten by a no-change pass.
  writePrivate(path.join(managedHome(bot), '.env'), 'ANTHROPIC_API_KEY=sk-same\n');
  const before = fs.readFileSync(path.join(managedHome(bot), '.env'), 'utf8');

  const synced = syncManagedAuth(bot);

  assert.deepEqual(synced, []);
  assert.equal(fs.readFileSync(path.join(managedHome(bot), '.env'), 'utf8'), before);
});

test('a placeholder model does not shadow the primary model forever', () => {
  resetBots();
  const bot = addBot('bot_default_model', 'managed');
  primaryFiles({ DEEPSEEK_API_KEY: 'sk-deepseek' }, { model: { provider: 'deepseek', default: 'deepseek/deepseek-flash' } });
  // What the settings panel leaves behind when nobody has picked a model: the literal word Default.
  managedFiles(bot, {}, { model: { default: 'Default' } });

  const synced = syncManagedAuth(bot);

  const cfg = readYaml(path.join(managedHome(bot), 'config.yaml'));
  assert.deepEqual(cfg.model, { provider: 'deepseek', default: 'deepseek/deepseek-flash' });
  assert.ok(synced.includes('model'));
});

test('a server started with no primary .env still shares the stack .env keys', () => {
  resetBots();
  const bot = addBot('bot_from_process_env', 'managed');
  // The primary home is empty; the stack's own environment carries the key instead.
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(primaryEnvFile, '');
  fs.writeFileSync(primaryCfgFile, YAML.stringify({}));
  managedFiles(bot, {}, {});
  const before = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-from-container-env';
  try {
    syncManagedAuth(bot);
    assert.equal(readDotenv(path.join(managedHome(bot), '.env')).DEEPSEEK_API_KEY, 'sk-from-container-env');
  } finally {
    if (before === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = before;
  }
});

test('a stored Default model in the roster is repaired from the config', () => {
  resetBots();
  const bot = addBot('bot_roster_model', 'managed');
  db.prepare('UPDATE bots SET model=?, provider=? WHERE id=?').run('Default', 'deepseek', bot);
  primaryFiles({ DEEPSEEK_API_KEY: 'sk-deepseek' }, { model: { provider: 'anthropic', default: 'claude-sonnet-4-5' } });
  managedFiles(bot, {}, { model: { default: 'claude-sonnet-4-5', provider: 'anthropic' } });

  syncManagedAuth(bot);

  const row = db.prepare('SELECT model, provider FROM bots WHERE id=?').get(bot) as any;
  assert.equal(row.model, 'claude-sonnet-4-5', 'the roster must stop asking for a model named Default');
  assert.equal(row.provider, 'anthropic');
});

/** The primary's auth.json, as an OAuth subscription sign-in looks on disk. */
function primaryAuth(rows: { anthropic?: any[]; codex?: any[] } = {}) {
  fs.mkdirSync(primaryHome, { recursive: true });
  fs.writeFileSync(
    path.join(primaryHome, 'auth.json'),
    JSON.stringify({
      version: 1,
      providers: {},
      credential_pool: {
        anthropic: rows.anthropic ?? [{
          id: 'aaa001', label: 'anthropic-oauth-3', auth_type: 'oauth', source: 'manual:hermes_pkce',
          access_token: 'sk-ant-oat01-access', refresh_token: 'sk-ant-ort01-refresh',
          expires_at_ms: Date.now() + 6 * 3600_000,
        }],
        ...(rows.codex ? { 'openai-codex': rows.codex } : {}),
      },
    }, null, 2),
  );
}

const botAuth = (botId: string) => {
  const file = path.join(managedHome(botId), 'auth.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

test('a subscription is inherited as an access token, never the refresh token', () => {
  resetBots();
  const bot = addBot('bot_inherit', 'managed');
  managedFiles(bot, {}, {});
  primaryAuth();

  const subs = primarySubscriptions();
  assert.equal(subs.length, 1);
  assert.equal(subscriptionEnv(subs).ANTHROPIC_TOKEN, 'sk-ant-oat01-access');

  const changed = inheritSubscriptions(managedHome(bot));
  assert.ok(changed.includes('anthropic'));

  const rows = botAuth(bot).credential_pool.anthropic;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].access_token, 'sk-ant-oat01-access');
  assert.equal(rows[0].refresh_token, undefined, 'a refresh token would let a bot rotate the user sign-in away');
  assert.equal(rows[0].source, 'inherited:orbit');
});

test('an inherited token is refreshed in place when the primary signs in again', () => {
  resetBots();
  const bot = addBot('bot_refresh_token', 'managed');
  managedFiles(bot, {}, {});
  primaryAuth();
  inheritSubscriptions(managedHome(bot));

  primaryAuth({ anthropic: [{
    id: 'aaa001', label: 'anthropic-oauth-3', auth_type: 'oauth', source: 'manual:hermes_pkce',
    access_token: 'sk-ant-oat01-new', refresh_token: 'sk-ant-ort01-new', expires_at_ms: Date.now() + 6 * 3600_000,
  }] });
  const changed = inheritSubscriptions(managedHome(bot));

  assert.ok(changed.includes('anthropic'));
  assert.equal(botAuth(bot).credential_pool.anthropic[0].access_token, 'sk-ant-oat01-new');
});

test('a forked copy of the grant is dropped and replaced by the inherited token', () => {
  resetBots();
  const bot = addBot('bot_fork', 'managed');
  primaryAuth();
  // What an older build wrote: a full copy of the primary's grant (refresh token included).
  fs.mkdirSync(managedHome(bot), { recursive: true });
  fs.writeFileSync(path.join(managedHome(bot), 'auth.json'), JSON.stringify({
    version: 1,
    providers: {},
    credential_pool: {
      anthropic: [{
        label: 'anthropic-oauth-3', auth_type: 'oauth', source: 'manual:hermes_pkce',
        access_token: 'sk-ant-oat01-old', refresh_token: 'sk-ant-ort01-old',
        last_status: 'dead', last_error_reason: 'invalid_grant',
      }],
    },
  }, null, 2));

  const changed = inheritSubscriptions(managedHome(bot));

  assert.ok(changed.some((k) => k.startsWith('-fork:anthropic')));
  const rows = botAuth(bot).credential_pool.anthropic;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refresh_token, undefined);
  assert.equal(rows[0].access_token, 'sk-ant-oat01-access');
});

test("a bot's own sign-in is never overwritten by the primary's", () => {
  resetBots();
  const bot = addBot('bot_own_signin', 'managed');
  primaryAuth();
  fs.mkdirSync(managedHome(bot), { recursive: true });
  fs.writeFileSync(path.join(managedHome(bot), 'auth.json'), JSON.stringify({
    version: 1,
    providers: {},
    credential_pool: {
      anthropic: [{ label: 'my-own-key', auth_type: 'api_key', source: 'manual', access_token: '', api_key: 'sk-ant-api-own' }],
    },
  }, null, 2));

  inheritSubscriptions(managedHome(bot));

  const rows = botAuth(bot).credential_pool.anthropic;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'my-own-key', "a bot's own credential must survive a sync");
});

after(() => {
  cleanupTmpEnv();
});

