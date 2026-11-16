import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_DEEP_LINK_TEXT, parseOrbitDeepLink } from '@orbit/contracts';
import { createDeepLinkInbox, deepLinkFromArgv } from '../deep-links';

test('a prompt link names its bot and decodes its text', () => {
  assert.deepEqual(parseOrbitDeepLink('orbit://app/v1/prompt?id=bot_Ab-9&text=Draft%20the%20%22Q3%22%20memo%0Athanks'), {
    kind: 'prompt',
    botId: 'bot_Ab-9',
    text: 'Draft the "Q3" memo\nthanks',
  });
  assert.deepEqual(parseOrbitDeepLink('orbit://app/v1/prompt?text=a+b%2Bc'), { kind: 'prompt', botId: null, text: 'a b+c' }, 'form-encoded + is a space');
});

test('an omitted or empty id means the primary bot, and text may be absent', () => {
  assert.deepEqual(parseOrbitDeepLink('orbit://app/v1/prompt'), { kind: 'prompt', botId: null, text: '' });
  assert.deepEqual(parseOrbitDeepLink('orbit://app/v1/prompt/?id=&text=hi'), { kind: 'prompt', botId: null, text: 'hi' });
  assert.deepEqual(parseOrbitDeepLink('ORBIT://APP/v1/prompt?id=bot_1#ignored'), { kind: 'prompt', botId: 'bot_1', text: '' }, 'scheme and host are case-insensitive');
  assert.deepEqual(parseOrbitDeepLink('orbit://app/v1/prompt?text=hi&future=1'), { kind: 'prompt', botId: null, text: 'hi' }, 'unknown params are ignored');
});

test('anything that is not a well-formed orbit prompt link is refused', () => {
  const refused = [
    '',
    'orbit:app/v1/prompt',
    'https://app/v1/prompt?text=hi',
    'grokbot://app/v1/prompt?text=hi',
    'orbit://evil.example/v1/prompt?text=hi',
    'orbit://app.example/v1/prompt',
    'orbit://app/v2/prompt',
    'orbit://app/v1/prompt/extra',
    'orbit://app/v1/Prompt',
    'orbit://app/v1/prompt?text=%E0%A4%A',
    'orbit://app/v1/prompt?id=../../etc',
    'orbit://app/v1/prompt?id=bot%201',
    `orbit://app/v1/prompt?id=${'a'.repeat(65)}`,
    'orbit://app/v1/prompt?id=a&id=b',
    'orbit://app/v1/prompt?text=a&text=b',
    `orbit://app/v1/prompt?text=${'x'.repeat(MAX_DEEP_LINK_TEXT + 1)}`,
  ];
  for (const url of refused) assert.equal(parseOrbitDeepLink(url), null, url);
  assert.equal(parseOrbitDeepLink(undefined as unknown as string), null);
});

test('the link is found among launch arguments, wherever it sits', () => {
  assert.deepEqual(deepLinkFromArgv(['/Applications/Orbit.app/Contents/MacOS/Orbit', '--flag', 'orbit://app/v1/prompt?id=bot_2&text=yo']), { kind: 'prompt', botId: 'bot_2', text: 'yo' });
  assert.equal(deepLinkFromArgv(['electron', '.', 'orbit://elsewhere/v1/prompt']), null);
  assert.equal(deepLinkFromArgv([]), null);
});

test('the inbox hands over the newest link once', () => {
  const inbox = createDeepLinkInbox();
  assert.equal(inbox.take(), null);
  inbox.put({ kind: 'prompt', botId: 'a', text: 'first' });
  inbox.put({ kind: 'prompt', botId: 'b', text: 'second' });
  assert.deepEqual(inbox.take(), { kind: 'prompt', botId: 'b', text: 'second' });
  assert.equal(inbox.take(), null, 'taken links are gone');
});
