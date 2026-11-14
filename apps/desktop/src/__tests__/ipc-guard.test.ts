import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { describeSender, isSetupWindowPage, isTrustedPage } from '../ipc-guard';

const STACK = 'http://127.0.0.1:18902';
const SETUP_FILE = pathToFileURL('/Applications/Orbit.app/Contents/Resources/app.asar/dist/setup.html').href;

describe('isTrustedPage', () => {
  test('accepts the local stack origin and its pages', () => {
    assert.equal(isTrustedPage({ pageUrl: `${STACK}/`, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), true);
    assert.equal(isTrustedPage({ pageUrl: `${STACK}/app?x=1#y`, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), true);
    assert.equal(isTrustedPage({ pageUrl: 'http://localhost:18902/', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
  });

  test('accepts the setup window document, with a fragment', () => {
    assert.equal(isTrustedPage({ pageUrl: SETUP_FILE, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), true);
    assert.equal(isTrustedPage({ pageUrl: `${SETUP_FILE}#hermes`, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), true);
  });

  test('refuses any other file:// document', () => {
    const other = pathToFileURL('/Users/someone/Downloads/index.html').href;
    assert.equal(isTrustedPage({ pageUrl: other, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
    assert.equal(isTrustedPage({ pageUrl: 'file:///etc/passwd', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
  });

  test('refuses another server, even one shaped like ours', () => {
    assert.equal(
      isTrustedPage({ pageUrl: 'https://orbit.example.com/app', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }),
      false,
    );
    assert.equal(
      isTrustedPage({ pageUrl: 'http://127.0.0.1:19999/', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }),
      false,
    );
    assert.equal(
      isTrustedPage({ pageUrl: 'http://127.0.0.1:18902.evil.test/', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }),
      false,
    );
  });

  test('refuses a missing frame or an empty url', () => {
    assert.equal(isTrustedPage({ pageUrl: '', stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
    assert.equal(isTrustedPage({ pageUrl: null, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
    assert.equal(isTrustedPage({ pageUrl: undefined, stackWebUrl: STACK, setupFileUrl: SETUP_FILE }), false);
  });

  test('refuses everything when no stack url is known', () => {
    assert.equal(isTrustedPage({ pageUrl: STACK, stackWebUrl: null, setupFileUrl: SETUP_FILE }), false);
    // ...except the setup window, which exists before any stack does.
    assert.equal(isTrustedPage({ pageUrl: SETUP_FILE, stackWebUrl: null, setupFileUrl: SETUP_FILE }), true);
  });
});

describe('isSetupWindowPage', () => {
  test('ignores a trailing fragment only', () => {
    assert.equal(isSetupWindowPage(SETUP_FILE, SETUP_FILE), true);
    assert.equal(isSetupWindowPage(`${SETUP_FILE}?x=1`, SETUP_FILE), false);
  });
});

describe('describeSender', () => {
  test('names the stack when the caller is the stack, and drops query strings', () => {
    assert.equal(describeSender(`${STACK}/app`, STACK), `${STACK} (the local stack)`);
    assert.equal(describeSender('https://elsewhere.test/app?token=secret', STACK), 'https://elsewhere.test');
    assert.equal(describeSender('file:///tmp/setup.html#x', STACK), 'file:///tmp/setup.html');
    assert.equal(describeSender(null, STACK), '(no sender frame)');
  });
});
