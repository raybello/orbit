import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards for the shipped stack. Every one of these was a real outage in the containerized app:
 * an empty COMPUTER_IMAGE made the Docker client ask for a host called "images"; a non-root api
 * container could not open the mounted socket (EACCES, "couldn't reach the screen"); and the
 * bundled gateway refuses to run as root unless the opt-in is forwarded.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const composeDir = path.join(repo, 'infra/compose');
const files = ['docker-compose.yml', 'docker-compose.images.yml'];

function serviceBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name} missing`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}

for (const file of files) {
  const text = fs.readFileSync(path.join(composeDir, file), 'utf8');

  test(`${file}: both services run as root so they can open the Docker socket`, () => {
    for (const svc of ['api', 'sandbox-supervisor']) {
      assert.match(serviceBlock(text, svc), /^\s+user: "0:0"$/m, `${svc} must set user: "0:0"`);
    }
  });

  test(`${file}: the computer image has a default, so an empty env value cannot reach Docker`, () => {
    assert.match(text, /COMPUTER_IMAGE: \$\{COMPUTER_IMAGE:-orbit\/computer:local\}/);
  });

  test(`${file}: the bundled Hermes is found and allowed to run as root`, () => {
    assert.match(text, /HERMES_BIN: \$\{HERMES_BIN:-\/opt\/hermes\/\.venv\/bin\/hermes\}/);
    assert.match(text, /HERMES_ALLOW_ROOT_GATEWAY: "1"/);
  });

  test(`${file}: the supervisor token cannot silently default`, () => {
    assert.match(text, /SANDBOX_SUPERVISOR_TOKEN: \$\{SANDBOX_SUPERVISOR_TOKEN:\?/);
  });
}

test('the env example does not ship an empty COMPUTER_IMAGE without a default in compose', () => {
  const example = fs.readFileSync(path.join(composeDir, '.env.images.example'), 'utf8');
  assert.match(example, /^COMPUTER_IMAGE=/m, 'the example still documents the key');
});

test('the supervisor opts out of the image healthcheck (it binds no port)', () => {
  const text = fs.readFileSync(path.join(composeDir, 'docker-compose.images.yml'), 'utf8');
  assert.match(serviceBlock(text, 'sandbox-supervisor'), /healthcheck:\n\s+test: \["NONE"\]/);
});
