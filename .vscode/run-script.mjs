/**
 * Runs a shell command inside a launch.json "node" debug session.
 *
 * Why this exists: the Orbit dev configs are shell scripts (docker build, compose, pnpm,
 * electron), but launch.json has no shell runner — the only way to get a terminal from the
 * Run and Debug panel is the node debugger. A node debug session pointed at `bash` tries to
 * attach an inspector to port 9229, nothing listens, and after its ~10s bootloader timeout
 * VS Code terminates the process tree. `docker build` takes ~30s even with a warm cache, so
 * the rebuild loop was being killed mid-build: the image never changed, the stack was never
 * recreated, and the desktop window kept showing the web app baked into the old image.
 *
 * Launching this file instead gives the debugger a real node process to talk to, and the
 * command runs as a child with inherited stdio until it exits.
 *
 *   args: ["bash", "scripts/dev-rebuild-loop.sh"]
 *   args: ["pnpm", "--filter", "@orbit/desktop", "run", "dev"]
 *
 * Windows: the same configs work unchanged.
 *   - `bash` is Git Bash, never C:\Windows\System32\bash.exe (that is WSL, a different machine
 *     with its own Docker socket and node_modules). Set GIT_BASH to override the location.
 *   - `pnpm`, `npx` and other .cmd shims run through cmd.exe: Node refuses to spawn a .cmd file
 *     directly (CVE-2024-27980).
 *   - `python3` is the Microsoft Store stub on a fresh Windows; `python` is the real one.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [requested, ...rest] = process.argv.slice(2);
if (!requested) {
    console.error('run-script: pass an executable and its arguments, e.g. args: ["bash", "scripts/dev.sh"]');
    process.exit(2);
}

const isWindows = process.platform === 'win32';

// better-sqlite3's prebuilt binary and rolldown's (vite/vitest) both need Node ≥ 22.12: older 22.x
// crashes with an access violation the moment the server opens its database, or pnpm silently skips
// the bundler's native binding. Say so up front instead of leaving a segfault to decode.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
    console.warn(`run-script: Node ${process.version} is too old for this repo (needs ≥ 22.12). ` +
        'Install a current Node 22 LTS and re-run `pnpm install`.');
}

/** Git Bash: GIT_BASH, then the folder of the `git` on PATH, then the default install locations. */
function gitBash() {
    const candidates = [process.env.GIT_BASH];
    const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
    for (const line of (where.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
        // …\Git\cmd\git.exe or …\Git\bin\git.exe → …\Git\bin\bash.exe
        candidates.push(path.join(path.dirname(path.dirname(line)), 'bin', 'bash.exe'));
    }
    candidates.push(
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    );
    const found = candidates.find((p) => p && fs.existsSync(p));
    if (!found) {
        console.error('run-script: Git Bash not found. Install Git for Windows, or set GIT_BASH to its bin\\bash.exe.');
        process.exit(127);
    }
    return found;
}

let executable = requested;
let useShell = false;
if (isWindows) {
    if (requested === 'bash') executable = gitBash();
    else if (requested === 'python3') executable = 'python';
    else if (!/\.(exe|com)$/i.test(requested) && !path.isAbsolute(requested)) useShell = true; // pnpm.cmd, npx.cmd, …
}

/** cmd.exe quoting for arguments that carry spaces or shell metacharacters. */
const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

const child = useShell
    ? spawn([executable, ...rest].map(quote).join(' '), { stdio: 'inherit', env: process.env, shell: true })
    : spawn(executable, rest, { stdio: 'inherit', env: process.env, detached: false });

// Terminal Ctrl-C / the debugger's stop button: pass the signal down and let the child decide.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        if (child.killed) return;
        // Windows has no signals to forward: end the whole tree (pnpm → node → electron).
        if (isWindows && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill(signal);
    });
}

child.on('error', (err) => {
    console.error(`run-script: could not start ${executable}: ${err.message}`);
    process.exit(127);
});

child.on('exit', (code, signal) => {
    if (signal) {
        console.error(`run-script: ${executable} was terminated by ${signal}`);
        process.exit(1);
    }
    process.exit(code ?? 0);
});
