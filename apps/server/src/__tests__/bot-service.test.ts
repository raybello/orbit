import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { asUserId } from '@orbit/contracts';
import { beginProvisioning, type BotCreationDeps, type BotCreationInput, planBotCreation, TeamFullError } from '../core/bot-service.js';
import { COLORS, HASH_COLORS, HASH_SHAPES, pickAvatar, SHAPES } from '../core/avatar.js';

/**
 * The create-bot rules, pinned to what routes.ts used to do inline: same capacity message, same name
 * fallback, same two-value normalisations, same avatar palette. Also the created -> provisioning
 * handoff, which must go through the lifecycle machine rather than a hand-written status string.
 */

const userId = asUserId('usr_1');

function deps(over: Partial<BotCreationDeps> = {}): BotCreationDeps {
  let n = 0;
  return {
    canAddBot: () => true,
    maxBots: 4,
    newBotId: () => `bot_${++n}`,
    pickAvatar: (_id, shape, color) => pickAvatar('bot_hash', shape, color),
    defaultModel: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ...over,
  };
}

const input = (over: Partial<BotCreationInput> = {}): BotCreationInput => ({ userId, ...over });

/** assert.throws does not return the error; this does, so its fields can be inspected. */
function threw(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the call to throw');
}

describe('planBotCreation', () => {
  test('a full team throws TeamFullError with the message the route shows', () => {
    const err = threw(() => planBotCreation(input({ name: 'Ada' }), deps({ canAddBot: () => false, maxBots: 4 }))) as TeamFullError;
    assert.ok(err instanceof TeamFullError);
    assert.equal(err.message, 'The team is full: the computer has room for 4 bots. Remove one to add another.');
    assert.equal(err.name, 'TeamFullError');
    assert.equal(err.maxBots, 4);
  });

  test('the ceiling in the message is the one the deps report, not a hard-coded 4', () => {
    const err = threw(() => planBotCreation(input(), deps({ canAddBot: () => false, maxBots: 9 }))) as TeamFullError;
    assert.match(err.message, /room for 9 bots/);
  });

  test('capacity is checked before an id is allocated, so a rejected request leaves no trace', () => {
    let allocated = 0;
    assert.throws(
      () => planBotCreation(input(), deps({ canAddBot: () => false, newBotId: () => (allocated++, 'bot_x') })),
      TeamFullError,
    );
    assert.equal(allocated, 0);
  });

  test('the owner id reaches canAddBot', () => {
    let seen = '';
    planBotCreation(input(), deps({ canAddBot: (id) => ((seen = id), true) }));
    assert.equal(seen, userId);
  });

  test('the name is trimmed, sliced to 60 and falls back to "New Bot"', () => {
    const plan = (name?: string) => planBotCreation(input({ name }), deps()).name;
    assert.equal(plan('  Ada Lovelace  '), 'Ada Lovelace');
    assert.equal(plan(''), 'New Bot');
    assert.equal(plan('   '), 'New Bot');
    assert.equal(plan(undefined), 'New Bot');
    assert.equal(plan('x'.repeat(100)).length, 60);
    assert.equal(plan('x'.repeat(100)), 'x'.repeat(60));
    // Trimming happens before the slice, so trailing spaces cannot eat into the 60 characters.
    assert.equal(plan(`  ${'y'.repeat(60)}  `), 'y'.repeat(60));
  });

  test('label, description and instructions default to empty strings', () => {
    const plan = planBotCreation(input(), deps());
    assert.equal(plan.label, '');
    assert.equal(plan.description, '');
    assert.equal(plan.instructions, '');
    const filled = planBotCreation(input({ label: 'Chief of Staff', description: 'd', instructions: 'i' }), deps());
    assert.equal(filled.label, 'Chief of Staff');
    assert.equal(filled.description, 'd');
    assert.equal(filled.instructions, 'i');
  });

  test('only the exact word "teammate" makes a teammate, and only exact "cloud" keeps cloud voice', () => {
    const mode = (m?: string) => planBotCreation(input({ mode: m }), deps()).mode;
    assert.equal(mode('teammate'), 'teammate');
    assert.equal(mode('personal'), 'personal');
    assert.equal(mode('TEAMMATE'), 'personal');
    assert.equal(mode(' teammate '), 'personal');
    assert.equal(mode(undefined), 'personal');

    const provider = (p?: string) => planBotCreation(input({ voiceProvider: p }), deps()).voiceProvider;
    assert.equal(provider('local'), 'local');
    assert.equal(provider('cloud'), 'cloud');
    assert.equal(provider('CLOUD'), 'local');
    assert.equal(provider(undefined), 'local');
  });

  test('the voice model is stringified, sliced to 80, and defaults to Piper', () => {
    const model = (m?: string) => planBotCreation(input({ voiceModel: m }), deps()).voiceModel;
    assert.equal(model(undefined), 'piper-lessac-medium');
    assert.equal(model(''), 'piper-lessac-medium');
    // Only an empty string falls back: the old expression was String(x ?? '').slice(0, 80) || default,
    // and a whitespace-only id is truthy, so it is kept as-is.
    assert.equal(model('  '), '  ');
    assert.equal(model('amy'), 'amy');
    assert.equal(model('m'.repeat(100)), 'm'.repeat(80));
  });

  test('isPrimary is a boolean, and a new plan starts in "created"', () => {
    const plan = planBotCreation(input({ isPrimary: true }), deps());
    assert.equal(plan.isPrimary, true);
    assert.equal(planBotCreation(input(), deps()).isPrimary, false);
    assert.deepEqual(plan.state, { status: 'created', botId: plan.botId });
    assert.equal(plan.botId, 'bot_1');
  });

  test('the requested avatar values are passed through to the picker', () => {
    const calls: (string | undefined)[][] = [];
    planBotCreation(input({ avatarShape: 'star', avatarColor: 'red' }), deps({
      pickAvatar: (id, shape, color) => (calls.push([id, shape, color]), { shape: 'star', color: 'red' }),
    }));
    assert.deepEqual(calls, [['bot_1', 'star', 'red']]);
  });
});

describe('pickAvatar', () => {
  test('an explicit value the palette has wins', () => {
    assert.deepEqual(pickAvatar('bot_1', 'star', 'magenta'), { shape: 'star', color: 'magenta' });
    assert.deepEqual(pickAvatar('bot_1', 'blob', 'black'), { shape: 'blob', color: 'black' });
  });

  test('anything else falls back to the id hash, deterministically', () => {
    const a = pickAvatar('bot_abc', 'not-a-shape', 'not-a-colour');
    const b = pickAvatar('bot_abc', 'not-a-shape', 'not-a-colour');
    assert.deepEqual(a, b);
    assert.ok(SHAPES.includes(a.shape));
    assert.ok(COLORS.includes(a.color));
  });

  test('the hash fallback only uses the original 13 shapes and never black', () => {
    // Every id in a wide sample, because the rule is about the list the hash indexes.
    for (let i = 0; i < 500; i++) {
      const { shape, color } = pickAvatar(`bot_${i}`);
      assert.ok(HASH_SHAPES.includes(shape), `shape ${shape} is outside the hash palette`);
      assert.notEqual(color, 'black');
      assert.ok((HASH_COLORS as readonly string[]).includes(color));
    }
    assert.equal(HASH_SHAPES.length, 13);
    assert.deepEqual(HASH_SHAPES, SHAPES.slice(0, 13));
    assert.equal(HASH_COLORS.length, COLORS.length - 1);
  });

  test('a different id can produce a different look', () => {
    const looks = new Set(Array.from({ length: 50 }, (_, i) => JSON.stringify(pickAvatar(`bot_${i}`))));
    assert.ok(looks.size > 1);
  });
});

describe('the model a new bot runs', () => {
  test('no choice in the request means the stack default', () => {
    assert.deepEqual(planBotCreation(input(), deps()).modelChoice, { provider: 'anthropic', model: 'claude-sonnet-4-6' });
  });

  test('a chosen provider and model are kept as they are', () => {
    const plan = planBotCreation(input({ modelChoice: { provider: 'strata', model: 'qwen3' } }), deps());
    assert.deepEqual(plan.modelChoice, { provider: 'strata', model: 'qwen3' });
  });
});

describe('beginProvisioning', () => {
  test('a created bot moves to provisioning with the engine kind it will start', () => {
    const plan = planBotCreation(input(), deps());
    assert.deepEqual(beginProvisioning(plan.state, 'managed'), { status: 'provisioning', botId: plan.botId, engineKind: 'managed' });
    assert.deepEqual(beginProvisioning(plan.state, 'primary'), { status: 'provisioning', botId: plan.botId, engineKind: 'primary' });
  });

  test('it is the state machine doing the move: any non-created state is returned unchanged', () => {
    const ready = { status: 'ready' as const, botId: 'bot_1', engine: { kind: 'managed' as const, url: 'http://x' }, screen: { screenId: 's1' } };
    assert.equal(beginProvisioning(ready, 'managed'), ready);
  });
});
