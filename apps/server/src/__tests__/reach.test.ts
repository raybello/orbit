import assert from 'node:assert/strict';
import test from 'node:test';
import {
  botNetworkName,
  extraNetworksFor,
  looksContainerized,
  ON_HOST,
  placementFromInspect,
  resolveScreenEndpoint,
  ScreenUnreachableError,
  screenContainerPort,
  screenHostPort,
  type BotNetworkState,
  type ServerPlacement,
} from '../docker/reach.js';
import { containerCreateOptions } from '../docker/container.js';

/**
 * The bot screen is dialed by the relay (and the bot's own browser by CDP), and where those
 * addresses point depends on where the server runs: on the host it is a published loopback port,
 * inside a container it is the bot's address on the Docker network the two share. These tests pin
 * that choice against real `docker inspect` shapes — the inspect results shown here are the ones
 * the failure was reproduced with.
 */

/** The bot container from the live stack: default bridge, ports published on 127.0.0.1. */
const botOnBridge: BotNetworkState = {
  networks: { bridge: { IPAddress: '172.17.0.4', NetworkID: 'bridge-id' } },
  ports: {
    '5901/tcp': [{ HostIp: '127.0.0.1', HostPort: '5901' }],
    '9301/tcp': [{ HostIp: '127.0.0.1', HostPort: '9201' }],
  },
};

/** The same bot after it joined the API container's compose network. */
const botOnComposeNetwork: BotNetworkState = {
  networks: {
    bridge: { IPAddress: '172.17.0.4', NetworkID: 'bridge-id' },
    orbit_default: { IPAddress: '172.26.0.5', NetworkID: 'compose-id' },
  },
  ports: botOnBridge.ports,
};

const onHost: ServerPlacement = ON_HOST;
/** The API container of the live stack: on the compose network, not on the default bridge. */
const inCompose: ServerPlacement = { inContainer: true, network: 'orbit_default', containerId: 'orbit-api-1' };

test('screen ports: VNC keeps its port inside the container, DevTools does not', () => {
  // VNC listens on 5900+display both inside and outside; Chrome's DevTools port is bridged by socat
  // from 9300+display to the published 9200+display (see screen.ts).
  assert.equal(screenContainerPort('vnc', 1), 5901);
  assert.equal(screenHostPort('vnc', 1), 5901);
  assert.equal(screenContainerPort('cdp', 1), 9301);
  assert.equal(screenHostPort('cdp', 1), 9201);
});

test('a server on the host dials the published loopback ports', () => {
  const vnc = resolveScreenEndpoint({ placement: onHost, bot: botOnBridge, index: 1, kind: 'vnc' });
  assert.deepEqual(vnc, { host: '127.0.0.1', port: 5901, transport: 'host-port' });

  const cdp = resolveScreenEndpoint({ placement: onHost, bot: botOnBridge, index: 1, kind: 'cdp' });
  assert.deepEqual(cdp, { host: '127.0.0.1', port: 9201, transport: 'host-port' });
});

test('a server on the host uses the port Docker actually published, not the computed one', () => {
  const bot: BotNetworkState = {
    networks: { bridge: { IPAddress: '172.17.0.4' } },
    ports: { '5901/tcp': [{ HostIp: '127.0.0.1', HostPort: '53153' }], '9301/tcp': [{ HostIp: '127.0.0.1', HostPort: '53154' }] },
  };
  assert.equal(resolveScreenEndpoint({ placement: onHost, bot, index: 1, kind: 'vnc' }).port, 53153);
  assert.equal(resolveScreenEndpoint({ placement: onHost, bot, index: 1, kind: 'cdp' }).port, 53154);
});

test('a server on the host stays on loopback even if Docker reports a wildcard binding', () => {
  // The create options below only ever ask for 127.0.0.1, but a container made by an older build
  // could have been published wider. Dialing the host's own loopback still reaches it and keeps the
  // address the relay uses off the LAN.
  const bot: BotNetworkState = {
    networks: { bridge: { IPAddress: '172.17.0.4' } },
    ports: { '5901/tcp': [{ HostIp: '0.0.0.0', HostPort: '5901' }] },
  };
  assert.equal(resolveScreenEndpoint({ placement: onHost, bot, index: 1, kind: 'vnc' }).host, '127.0.0.1');
});

test('a containerized server dials the bot on the shared network, on the container ports', () => {
  const vnc = resolveScreenEndpoint({ placement: inCompose, bot: botOnComposeNetwork, index: 1, kind: 'vnc' });
  assert.deepEqual(vnc, { host: '172.26.0.5', port: 5901, transport: 'network' });

  // DevTools: the bot's socat bridge listens on 9301 inside the container; 9201 is only the host's
  // published side and does not exist in the bot's namespace.
  const cdp = resolveScreenEndpoint({ placement: inCompose, bot: botOnComposeNetwork, index: 1, kind: 'cdp' });
  assert.deepEqual(cdp, { host: '172.26.0.5', port: 9301, transport: 'network' });
});

test('a containerized server prefers the shared network over published ports', () => {
  // Both routes exist here; 127.0.0.1 inside the API container is the API container itself.
  const vnc = resolveScreenEndpoint({ placement: inCompose, bot: botOnComposeNetwork, index: 1, kind: 'vnc' });
  assert.notEqual(vnc.host, '127.0.0.1');
  assert.equal(vnc.transport, 'network');
});

test('a bot left on the default bridge is refused with an actionable message, not dialed blind', () => {
  assert.throws(
    () => resolveScreenEndpoint({ placement: inCompose, bot: botOnBridge, index: 1, kind: 'vnc' }),
    (e: any) => e instanceof ScreenUnreachableError
      && /bridge/.test(e.message) && /orbit_default/.test(e.message),
  );
});

test('a pinned COMPUTER_NETWORK is used when the bot is there and the server shares it', () => {
  const placement: ServerPlacement = { inContainer: true, network: 'orbit_default', containerId: 'api' };
  const bot: BotNetworkState = { networks: { orbit_computers: { IPAddress: '172.27.0.9' } } };
  // The server is not on orbit_computers itself, so this only resolves when the caller passes it as
  // the preferred network — which is what the provider does after joining it.
  const endpoint = resolveScreenEndpoint({ placement, bot, index: 3, kind: 'vnc', preferredNetwork: 'orbit_computers' });
  assert.deepEqual(endpoint, { host: '172.27.0.9', port: 5903, transport: 'network' });
});

test('placement: the API container is on its compose network', () => {
  const placement = placementFromInspect('b614d6d3cd5a', {
    Id: 'b614d6d3cd5a' + '0'.repeat(52),
    NetworkSettings: { Networks: { orbit_default: { IPAddress: '172.26.0.3' } } },
  });
  assert.equal(placement.inContainer, true);
  assert.equal(placement.network, 'orbit_default');
  assert.equal(placement.containerId, 'b614d6d3cd5a' + '0'.repeat(52));
});

test('placement: a compose network wins over the default bridge', () => {
  const placement = placementFromInspect('abc', {
    Id: 'abc',
    NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' }, orbit_default: { IPAddress: '172.26.0.3' } } },
  });
  assert.equal(placement.network, 'orbit_default');
});

test('placement: not in a container, and --network host is treated as the host', () => {
  assert.deepEqual(placementFromInspect('mac', null), ON_HOST);
  assert.deepEqual(placementFromInspect('mac', undefined), ON_HOST);
  assert.deepEqual(
    placementFromInspect('abc', { Id: 'abc', NetworkSettings: { Networks: { host: { IPAddress: '' } } } }),
    ON_HOST,
  );
});

test('placement: a container on the plain bridge is still containerized', () => {
  const placement = placementFromInspect('abc', { Id: 'abc', NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.2' } } } });
  assert.equal(placement.inContainer, true);
  assert.equal(placement.network, 'bridge');
});

test('a bot container is created on the network the server can dial it on', () => {
  // On the host: today's behaviour, the default bridge plus loopback published ports.
  assert.equal(botNetworkName(onHost, null), 'bridge');
  assert.equal(botNetworkName(onHost, 'orbit_custom'), 'orbit_custom');
  // In a container: the server's own network, or the pinned one when an operator set it.
  assert.equal(botNetworkName(inCompose, null), 'orbit_default');
  assert.equal(botNetworkName(inCompose, 'orbit_computers'), 'orbit_computers');
});

test('a pinned network different from the server\'s is joined as well, so the screen stays reachable', () => {
  assert.deepEqual(extraNetworksFor(inCompose, 'orbit_default'), []);
  assert.deepEqual(extraNetworksFor(inCompose, 'orbit_computers'), ['orbit_default']);
  assert.deepEqual(extraNetworksFor(onHost, 'orbit_computers'), []);
});

test('created containers publish their screen ports on loopback only', () => {
  for (const index of [1, 2, 7]) {
    const opts = containerCreateOptions({ botId: 'bot_test', homePath: '/tmp/home', displayIndex: index, network: 'orbit_default' });
    const bindings = Object.values(opts.HostConfig!.PortBindings!).flat() as { HostIp: string; HostPort: string }[];
    assert.ok(bindings.length >= 2);
    for (const b of bindings) assert.equal(b.HostIp, '127.0.0.1');
    assert.equal(opts.HostConfig!.NetworkMode, 'orbit_default');
    // Nothing in the message sent to Docker may ask for another interface.
    assert.ok(!JSON.stringify(opts).includes('0.0.0.0'));
  }
});

test('a container joins extra networks through EndpointsConfig, and only when there are some', () => {
  const plain = containerCreateOptions({ botId: 'bot_test', homePath: '/tmp/home', displayIndex: 1, network: 'orbit_default' });
  assert.equal(plain.NetworkingConfig, undefined);

  const both = containerCreateOptions({
    botId: 'bot_test', homePath: '/tmp/home', displayIndex: 1,
    network: 'orbit_computers', extraNetworks: ['orbit_default', 'orbit_computers'],
  });
  assert.deepEqual(Object.keys(both.NetworkingConfig!.EndpointsConfig!), ['orbit_computers', 'orbit_default']);
  assert.equal(both.HostConfig!.NetworkMode, 'orbit_computers');
});

test('looksContainerized sees Docker\'s id-shaped hostname', () => {
  assert.equal(looksContainerized('b614d6d3cd5a'), true);
});

test('endpoints are computed per display index, so two bots never collide', () => {
  const two = resolveScreenEndpoint({ placement: inCompose, bot: botOnComposeNetwork, index: 2, kind: 'vnc' });
  const seven = resolveScreenEndpoint({ placement: inCompose, bot: botOnComposeNetwork, index: 7, kind: 'vnc' });
  assert.equal(two.port, 5902);
  assert.equal(seven.port, 5907);
  assert.equal(two.host, seven.host); // same container? no: same bot fixture, different screen index
});
