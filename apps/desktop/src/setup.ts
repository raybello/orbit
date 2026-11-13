/**
 * The setup window's renderer.
 *
 * Two screens: choose a server, then (only if Hermes is missing) get Hermes installed.
 * Everything that touches the network or the disk goes through the preload bridge, so this
 * file stays a DOM script with no Node access and no CORS problems.
 */

import { normalizeServerUrl } from './server-url';
import type { DesktopSetup, HermesStatus, OrbitDesktopAPI, ServerProbe } from './shared/api';

declare global {
  interface Window {
    orbitDesktop: OrbitDesktopAPI;
  }
}

const api = window.orbitDesktop;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`setup: missing #${id}`);
  return el as T;
};

const screenServer = $('screen-server');
const screenHermes = $('screen-hermes');
const form = $<HTMLFormElement>('server-form');
const urlRow = $('url-row');
const urlInput = $<HTMLInputElement>('server-url');
const checkButton = $<HTMLButtonElement>('check-server');
const statusLine = $('status');
const hint = $('hint');
const continueButton = $<HTMLButtonElement>('continue');

const installButton = $<HTMLButtonElement>('install-hermes');
const manualButton = $<HTMLButtonElement>('manual-hermes');
const hermesLog = $<HTMLPreElement>('hermes-log');
const hermesHint = $('hermes-hint');
const hermesContinue = $<HTMLButtonElement>('hermes-continue');

type Mode = 'new' | 'existing';

let mode: Mode = 'new';
/** True once the entered URL has passed a `/api/health` probe. */
let verifiedUrl: string | null = null;
let probeSeq = 0;

function setStatus(text: string, kind: 'idle' | 'ok' | 'error' | 'busy' = 'idle'): void {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

function selectedMode(): Mode {
  const checked = form.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'existing' ? 'existing' : 'new';
}

function syncChoiceStyles(): void {
  for (const label of form.querySelectorAll<HTMLElement>('.choice')) {
    label.dataset.selected = String(label.dataset.choice === mode);
  }
}

/**
 * Continue is only enabled for a choice that is actually usable: "this computer" is
 * always usable (the stack is started next), "existing" needs a URL that answered.
 */
function syncContinue(): void {
  const url = normalizeServerUrl(urlInput.value);
  if (mode === 'new') {
    continueButton.disabled = false;
    hint.textContent = 'Docker will be checked next.';
    return;
  }
  continueButton.disabled = !(url && verifiedUrl === url);
  hint.textContent = verifiedUrl ? '' : 'Check the server before continuing.';
}

function onModeChange(): void {
  mode = selectedMode();
  urlRow.hidden = mode !== 'existing';
  syncChoiceStyles();
  setStatus('');
  if (mode === 'existing' && !urlInput.value) urlInput.focus();
  syncContinue();
}

async function probe(): Promise<void> {
  const url = normalizeServerUrl(urlInput.value);
  if (!url) {
    verifiedUrl = null;
    setStatus('That does not look like a URL. Try https://orbit.example.com', 'error');
    syncContinue();
    return;
  }
  urlInput.value = url;
  const seq = ++probeSeq;
  verifiedUrl = null;
  syncContinue();
  checkButton.disabled = true;
  setStatus(`Checking ${url}…`, 'busy');
  try {
    const result: ServerProbe = await api.probeServer(url);
    // A slow probe must not overwrite the result of a newer one.
    if (seq !== probeSeq) return;
    if (result.ok) {
      verifiedUrl = url;
      setStatus(`Found Orbit${result.version ? ` ${result.version}` : ''}`, 'ok');
    } else {
      setStatus(result.error ?? 'No Orbit server answered at that address.', 'error');
    }
  } catch (err) {
    if (seq === probeSeq) setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    if (seq === probeSeq) checkButton.disabled = false;
    syncContinue();
  }
}

function showScreen(which: 'server' | 'hermes'): void {
  screenServer.hidden = which !== 'server';
  screenHermes.hidden = which !== 'hermes';
}

function logLine(line: string): void {
  hermesLog.hidden = false;
  // Keep the pane bounded; the install prints tens of lines, not thousands.
  const lines = `${hermesLog.textContent ?? ''}${line}\n`.split('\n');
  hermesLog.textContent = lines.slice(-200).join('\n');
  hermesLog.scrollTop = hermesLog.scrollHeight;
}

function applyHermesStatus(status: HermesStatus): void {
  if (status.found) {
    hermesHint.textContent = `Hermes ${status.version ?? ''} at ${status.home ?? '~/.hermes'}`.trim();
    hermesContinue.hidden = false;
    installButton.disabled = true;
    return;
  }
  hermesHint.textContent = 'You can also install Hermes later; Orbit will not start bots until it is there.';
  hermesContinue.hidden = false;
}

async function installHermes(): Promise<void> {
  installButton.disabled = true;
  manualButton.disabled = true;
  hermesLog.hidden = false;
  hermesLog.textContent = '';
  hermesHint.textContent = 'Installing…';
  try {
    const status = await api.installHermes(logLine);
    applyHermesStatus(status);
    if (status.found) {
      hermesHint.textContent = `Hermes ${status.version ?? ''} installed.`;
      setupDone();
    }
  } catch (err) {
    logLine(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    hermesHint.textContent = 'Install failed. Try again, or install Hermes yourself and restart Orbit.';
    installButton.disabled = false;
    manualButton.disabled = false;
  }
}

/** Write setup.json and let main take over (it closes this window). */
async function persistAndFinish(setup: DesktopSetup): Promise<void> {
  await api.saveSetup(setup);
  api.finishSetup();
}

function setupDone(): void {
  const setup: DesktopSetup =
    mode === 'existing' && verifiedUrl
      ? { mode: 'existing', serverUrl: verifiedUrl }
      : { mode: 'new' };
  void persistAndFinish(setup).catch((err) => {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  });
}

async function onContinue(): Promise<void> {
  if (mode === 'existing') {
    if (!verifiedUrl) return;
    // Nothing more to ask; the stack is not ours to start.
    await persistAndFinish({ mode: 'existing', serverUrl: verifiedUrl });
    return;
  }
  continueButton.disabled = true;
  continueButton.textContent = 'Checking…';
  setStatus('Looking for Hermes…', 'busy');
  try {
    const status = await api.getHermesStatus();
    if (!status.found) {
      showScreen('hermes');
      applyHermesStatus(status);
      return;
    }
    await persistAndFinish({ mode: 'new' });
  } catch (err) {
    // A failed detection is not a reason to block setup: the app can start and the
    // missing Hermes can be fixed later.
    logLine(`Could not check for Hermes: ${err instanceof Error ? err.message : String(err)}`);
    await persistAndFinish({ mode: 'new' });
  } finally {
    continueButton.disabled = false;
    continueButton.textContent = 'Continue →';
  }
}

function wire(): void {
  document.body.dataset.framed = String(api.platform !== 'darwin');
  document.title = 'Welcome to Orbit';

  form.addEventListener('change', (event) => {
    if ((event.target as HTMLElement)?.getAttribute('name') === 'mode') onModeChange();
  });
  urlInput.addEventListener('input', () => {
    verifiedUrl = null;
    setStatus('');
    syncContinue();
  });
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void probe();
    }
  });
  form.addEventListener('submit', (event) => event.preventDefault());
  checkButton.addEventListener('click', () => void probe());
  continueButton.addEventListener('click', () => void onContinue());
  installButton.addEventListener('click', () => void installHermes());
  manualButton.addEventListener('click', () => {
    void api.openExternal('https://github.com/NousResearch/hermes-agent#install');
    hermesHint.textContent = 'Install Hermes, then press Continue.';
    hermesContinue.hidden = false;
  });
  hermesContinue.addEventListener('click', () => setupDone());

  // Pre-fill from a previous setup (Change Orbit Server… reopens this window).
  void api
    .getSetup()
    .then((saved) => {
      if (!saved) return;
      const radio = form.querySelector<HTMLInputElement>(`input[value="${saved.mode}"]`);
      if (radio) radio.checked = true;
      if (saved.serverUrl) urlInput.value = saved.serverUrl;
      onModeChange();
    })
    .catch(() => {
      /* first run: nothing saved */
    });

  onModeChange();
}

wire();
