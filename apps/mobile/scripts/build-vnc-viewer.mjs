/**
 * Builds `assets/vnc-viewer/index.html`: one self-contained file holding the same noVNC the web app
 * uses, inlined as a classic script.
 *
 * Why one file instead of noVNC's module tree: a React Native WebView loads the page from a
 * `file://` asset on iOS and `file://`/`asset://` on Android, where `<script type="module">` and
 * relative module imports are blocked (module scripts need an http(s) origin). A single inline
 * script sidesteps the origin entirely, and keeps Metro's asset list to one HTML file.
 *
 * Run it with `pnpm --filter @orbit/mobile run vnc-viewer` after upgrading @novnc/novnc.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const outFile = path.resolve(here, '..', 'assets', 'vnc-viewer', 'index.html');

const entry = require.resolve('@novnc/novnc');
const pkgRoot = path.resolve(path.dirname(entry), '..');
const novncVersion = JSON.parse(await readFile(path.join(pkgRoot, 'package.json'), 'utf8')).version;

/**
 * noVNC 1.7 probes WebCodecs H.264 support with a top-level await. A classic inline script cannot
 * contain one, and we cannot use `<script type="module">` inside a file:// WebView, so the probe is
 * replaced with "not supported". noVNC then picks its usual encodings (Tight/ZRLE/Hextile/Raw),
 * which is what the web app relies on anyway; only the optional H.264 path is unavailable.
 */
const noTopLevelAwait = {
  name: 'novnc-no-top-level-await',
  setup(b) {
    b.onLoad({ filter: /core[\\/]util[\\/]browser\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      return {
        contents: src.replace(
          'supportsWebCodecsH264Decode = await _checkWebCodecsH264DecodeSupport();',
          'supportsWebCodecsH264Decode = false;',
        ),
        loader: 'js',
      };
    });
  },
};

const built = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: 'RFBModule',
  minify: true,
  target: ['es2020'],
  write: false,
  legalComments: 'inline',
  plugins: [noTopLevelAwait],
  define: { 'process.env.NODE_ENV': '"production"' },
});

const js = built.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');
const license = await readFile(path.resolve(path.dirname(entry), '..', 'LICENSE.txt'), 'utf8').catch(() => '');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>Orbit screen</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; -webkit-user-select: none; user-select: none; }
  #screen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  #screen canvas { image-rendering: auto; }
  #state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
           color: #8a8a8a; font: 14px -apple-system, system-ui, sans-serif; text-align: center; padding: 24px; }
</style>
</head>
<body>
<div id="screen"></div>
<div id="state">Connecting…</div>
<script>/*! noVNC ${novncVersion} — MPL-2.0 — bundled into this page by scripts/build-vnc-viewer.mjs */
${license ? `/*\n${license.replace(/<\/script>/gi, '')}\n*/` : ''}
${js}</script>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var cfg = window.__ORBIT_VNC__ || {};
  var wsUrl = cfg.wsUrl || params.get('wsUrl');
  var mode = cfg.mode || params.get('mode') || 'watch';
  var state = document.getElementById('state');

  function report(status, detail) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'status', status: status, detail: detail || null }));
    }
  }

  if (!wsUrl) { state.textContent = 'No screen to show yet.'; report('error', 'missing wsUrl'); return; }

  try {
    var RFB = window.RFBModule && (window.RFBModule.default || window.RFBModule);
    var rfb = new RFB(document.getElementById('screen'), wsUrl, { shared: true, wsProtocols: ['binary'] });
    rfb.viewOnly = mode !== 'control';
    rfb.scaleViewport = true;
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.background = '#000000';
    rfb.focusOnClick = mode === 'control';
    window.__orbitRfb = rfb;
    // The native screen flips this instead of reloading the page when "Take control" changes.
    window.__orbitSetMode = function (m) {
      rfb.viewOnly = m !== 'control';
      rfb.focusOnClick = m === 'control';
      if (m === 'control') { try { rfb.focus(); } catch (e) {} }
    };
    rfb.addEventListener('connect', function () { state.style.display = 'none'; report('connected'); });
    rfb.addEventListener('disconnect', function (e) {
      state.style.display = 'flex';
      state.textContent = e && e.detail && e.detail.clean ? 'The screen disconnected.' : 'Lost the screen.';
      report('disconnected', e && e.detail ? String(e.detail.clean) : null);
    });
    rfb.addEventListener('securityfailure', function () { state.textContent = 'The screen refused the connection.'; report('error', 'security'); });
  } catch (err) {
    state.textContent = 'Could not open the screen.';
    report('error', String(err && err.message ? err.message : err));
  }
})();
</script>
</body>
</html>
`;

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, html, 'utf8');
console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} kB, noVNC ${novncVersion})`);
