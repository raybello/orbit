/**
 * The setup window's renderer.
 *
 * One screen: choose a server.
 * Everything that touches the network or the disk goes through the preload bridge, so this
 * file stays a DOM script with no Node access and no CORS problems.
 */

import { normalizeServerUrl } from './server-url';
import type { DesktopSetup, OrbitDesktopAPI, ServerProbe } from './shared/api';

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

const form = $<HTMLFormElement>('server-form');
const urlRow = $('url-row');
const urlInput = $<HTMLInputElement>('server-url');
const checkButton = $<HTMLButtonElement>('check-server');
const statusLine = $('status');
const hint = $('hint');
const continueButton = $<HTMLButtonElement>('continue');

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

/** Write setup.json and let main take over (it closes this window). */
async function persistAndFinish(setup: DesktopSetup): Promise<void> {
  await api.saveSetup(setup);
  api.finishSetup();
}

async function onContinue(): Promise<void> {
  if (mode === 'existing') {
    if (!verifiedUrl) return;
    // Nothing more to ask; the stack is not ours to start.
    await persistAndFinish({ mode: 'existing', serverUrl: verifiedUrl });
    return;
  }
  await persistAndFinish({ mode: 'new' });
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
