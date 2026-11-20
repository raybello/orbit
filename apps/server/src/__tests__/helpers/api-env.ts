/**
 * The isolation an app-level HTTP suite needs on top of tmp-env.ts.
 *
 * tmp-env.ts must still run first: it points DB_PATH and ENGINES_DIR at a fresh
 * mkdtemp before env.ts snapshots process.env. This module imports it for that side effect, then adds
 * only the values a suite that boots createApp() wants, leaving every other suite's defaults alone:
 *
 *  - DEV_LOGIN=1: POST /api/auth/dev is the cookie sign-in all the cases start from; without it the
 *    route answers 403 'disabled'.
 *  - HERMES_BIN=/usr/bin/true: creating a managed Bot starts its gateway in the background. `true`
 *    exits immediately, so the start fails inside the engine layer instead of spawning a real Hermes.
 *  - MAX_BOTS=3, not 2: capacity counts every visible agent *globally* (routes.ts agentCount), and
 *    this suite signs a second account in after the first owns two bots. Two slots would make that
 *    second sign-in a 403 team-full, so three is the minimum that covers the ownership cases.
 *  - GROKBOT_NO_SCHEDULER=1: index.ts is never imported here, but a suite must not let any future
 *    import start routines or triggers against its database.
 *  - PRIMARY_ENGINE_PORT names a closed loopback port: answering a card queues a real agent turn in
 *    the background, and the primary bot's turn would otherwise find whatever Hermes the developer
 *    has running on 8642. The start fails fast and locally (HERMES_BIN is `true`) instead.
 *  - DOCKER_SOCKET names a socket that does not exist: the same background turn asks for the bot's
 *    screen first, and every bot owns a container, so the suite would otherwise reach the developer's
 *    Docker and could start a real one. Here the request fails at once and the turn goes on.
 *
 * The disk paths these routes can reach (a bot's library, its container home) are moved under the
 * temp root too, so a run leaves nothing behind in the repository.
 *
 * Import this module FIRST in the test file; anything that reads env.ts is imported dynamically
 * afterwards, once this module body has set the variables above.
 */
import path from 'node:path';
import { tmpRoot } from './tmp-env.js';

process.env.DEV_LOGIN = '1';
process.env.HERMES_BIN = '/usr/bin/true';
process.env.MAX_BOTS = '3';
process.env.GROKBOT_NO_SCHEDULER = '1';
// Keep the engine's loopback "is a gateway already there?" probe away from a dev stack's 8650+ ports.
process.env.ENGINE_PORT_BASE = '18650';
process.env.PRIMARY_ENGINE_PORT = '18660';
process.env.DOCKER_SOCKET = path.join(tmpRoot, 'no-docker.sock');
process.env.BOT_DATA_DIR = path.join(tmpRoot, 'bot-data');
process.env.COMPUTER_HOME_DIR = path.join(tmpRoot, 'computers');

export { cleanupTmpEnv, tmpRoot } from './tmp-env.js';
