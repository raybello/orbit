import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDockerFailure,
  dockerCandidates,
  resolveDockerBinary,
} from '../docker-cli';

describe('classifyDockerFailure', () => {
  const cases: Array<[string, string]> = [
    [
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      'daemon-down',
    ],
    [
      'error during connect: Post "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.45/info": open //./pipe/docker_engine: The system cannot find the file specified.',
      'daemon-down',
    ],
    [
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/info": dial unix /var/run/docker.sock: connect: permission denied',
      'socket-permission',
    ],
    ['Error response from daemon: Get "https://registry-1.docker.io/v2/orbit/api/manifests/v0.1.0": manifest unknown', 'image-not-found'],
    ['docker: Error response from daemon: No such image: orbit/api:edge', 'image-not-found'],
    ['Error response from daemon: pull access denied for orbit/api, repository does not exist', 'image-not-found'],
    ['Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8787 failed: port is already allocated', 'port-in-use'],
    ['listen tcp 127.0.0.1:8787: bind: address already in use', 'port-in-use'],
    ['could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network', 'address-pool-exhausted'],
    ['all predefined address pools have been fully subnetted', 'address-pool-exhausted'],
    ['Error response from daemon: Get "https://registry-1.docker.io/v2/": net/http: TLS handshake timeout', 'network'],
    ['dial tcp 44.208.254.194:443: i/o timeout', 'network'],
    ['lookup registry-1.docker.io on 8.8.8.8:53: no such host', 'network'],
    ['no configuration file provided: not found', 'compose-missing'],
    ["Can't find a suitable configuration file in this directory or any parent. Are you in the right directory?", 'compose-missing'],
    ['docker: unrecognized command: "compose"', 'other'],
    ['', 'other'],
    ['some completely unrelated failure', 'other'],
  ];

  for (const [input, expected] of cases) {
    test(`${expected}: ${input.slice(0, 60)}`, () => {
      assert.equal(classifyDockerFailure(input), expected);
    });
  }

  test('is case insensitive', () => {
    assert.equal(classifyDockerFailure('CANNOT CONNECT TO THE DOCKER DAEMON'), 'daemon-down');
  });

  test('permission wins over daemon-down when both appear', () => {
    const text =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock ... Is the docker daemon running?';
    assert.equal(classifyDockerFailure(text), 'socket-permission');
  });
});

describe('resolveDockerBinary', () => {
  test('prefers an existing absolute candidate on macOS', () => {
    const found = resolveDockerBinary('darwin', {}, (file) => file === '/opt/homebrew/bin/docker');
    assert.equal(found, '/opt/homebrew/bin/docker');
  });

  test('falls back to the bare name so PATH can decide', () => {
    assert.equal(resolveDockerBinary('darwin', {}, () => false), 'docker');
  });

  test('honours ORBIT_DOCKER_BIN when it exists', () => {
    assert.equal(
      resolveDockerBinary('darwin', { ORBIT_DOCKER_BIN: '/custom/docker' }, (f) => f === '/custom/docker'),
      '/custom/docker',
    );
  });

  test('ignores ORBIT_DOCKER_BIN when it does not exist', () => {
    assert.equal(resolveDockerBinary('darwin', { ORBIT_DOCKER_BIN: '/custom/docker' }, () => false), 'docker');
  });

  test('looks in Docker Desktop on Windows', () => {
    const candidates = dockerCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' });
    assert.ok(candidates.includes('C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'));
    const found = resolveDockerBinary('win32', { PROGRAMFILES: 'C:\\PF' }, (f) => f.endsWith('docker.exe') && f.startsWith('C:\\PF'));
    assert.equal(found, 'C:\\PF\\Docker\\Docker\\resources\\bin\\docker.exe');
  });
});
