/**
 * The launch window's renderer.
 *
 * Three screens: where the server lives, how a local one runs (only where there is a choice),
 * and the start itself. Main owns every decision and pushes a `LaunchStatus`; this file keeps
 * only which choice screen is showing. Network and disk go through the preload bridge.
 */

import { normalizeServerUrl } from './server-url';
import { ACTION_LABELS, launchProblem, launchSteps } from './launch-model';
import type { LaunchAction, LaunchOptions, LaunchStatus, OrbitDesktopAPI, ServerProbe, StackKind, StackPhase } from './shared/api';

declare global {
  interface Window {
    orbitDesktop: OrbitDesktopAPI;
  }
}

const api = window.orbitDesktop;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`launch: missing #${id}`);
  return el as T;
};

const screens = {
  server: $('screen-server'),
  runtime: $('screen-runtime'),
  progress: $('screen-progress'),
};
type Screen = keyof typeof screens;

const serverForm = $<HTMLFormElement>('server-form');
const urlRow = $('url-row');
const urlInput = $<HTMLInputElement>('server-url');
const checkButton = $<HTMLButtonElement>('check-server');
const statusLine = $('status');
const hint = $('hint');
const continueButton = $<HTMLButtonElement>('continue');
const runtimeForm = $<HTMLFormElement>('runtime-form');
const dockerNote = $('docker-note');

type Mode = 'new' | 'existing';

let mode: Mode = 'new';
/** The URL that last passed a `/api/health` probe. */
let verifiedUrl: string | null = null;
let probeSeq = 0;
let options: LaunchOptions | null = null;
/** Where the start had got to, so a `failed` state is drawn on the right step. */
let lastActive: StackPhase = 'idle';
let busy = false;

function show(screen: Screen): void {
  for (const [name, el] of Object.entries(screens)) el.hidden = name !== screen;
}

function setStatus(text: string, kind: 'idle' | 'ok' | 'error' | 'busy' = 'idle'): void {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

function syncChoiceStyles(form: HTMLFormElement, name: string): void {
  const value = form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;
  for (const label of form.querySelectorAll<HTMLElement>('.choice')) {
    label.dataset.selected = String(label.dataset.choice === value);
  }
}

function syncContinue(): void {
  const url = normalizeServerUrl(urlInput.value);
  if (mode === 'new') {
    continueButton.disabled = busy;
    hint.textContent = '';
    return;
  }
  continueButton.disabled = busy || !(url && verifiedUrl === url);
  hint.textContent = verifiedUrl ? '' : 'Check the server before continuing.';
}

function onModeChange(): void {
  mode = serverForm.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === 'existing' ? 'existing' : 'new';
  urlRow.hidden = mode !== 'existing';
  syncChoiceStyles(serverForm, 'mode');
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

/** One request at a time; the buttons stay disabled until main has taken the choice. */
async function guarded(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  syncContinue();
  try {
    await work();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    busy = false;
    syncContinue();
  }
}

async function onServerContinue(): Promise<void> {
  if (mode === 'existing') {
    if (!verifiedUrl) return;
    const serverUrl = verifiedUrl;
    await guarded(() => api.launch.choose({ mode: 'remote', serverUrl }));
    return;
  }
  options ??= await api.launch.options();
  if (!options.native.available) {
    await guarded(() => api.launch.choose({ mode: 'local', runtime: 'docker' }));
    return;
  }
  dockerNote.textContent = options.dockerInstalled
    ? 'Runs Orbit’s server and Bots’ computers in Docker Desktop containers.'
    : 'Runs Orbit’s server and Bots’ computers in Docker Desktop containers. Docker is not installed yet; Orbit can install it for you.';
  syncChoiceStyles(runtimeForm, 'runtime');
  show('runtime');
}

async function onRuntimeContinue(): Promise<void> {
  const runtime: StackKind = runtimeForm.querySelector<HTMLInputElement>('input[name="runtime"]:checked')?.value === 'docker' ? 'docker' : 'native';
  await guarded(() => api.launch.choose({ mode: 'local', runtime }));
}

// ------------------------------------------------------------------ progress

const RUNTIME_LEDE: Record<StackKind, string> = {
  docker: 'Running Orbit in Docker on this computer.',
  native: 'Running Orbit natively on this Mac.',
};

function renderProgress(status: LaunchStatus): void {
  const { kind, state } = status;
  if (!['failed', 'docker-missing', 'docker-not-running'].includes(state.phase)) lastActive = state.phase;

  $('progress-lede').textContent = status.note ?? RUNTIME_LEDE[kind];
  const steps = $('steps');
  steps.replaceChildren(
    ...launchSteps(kind, state, lastActive).map((step) => {
      const li = document.createElement('li');
      li.textContent = step.label;
      li.dataset.status = step.status;
      return li;
    }),
  );

  const problem = launchProblem(kind, state, { platform: api.platform, nativeAvailable: status.nativeAvailable });
  $('progress-detail').textContent = problem ? '' : state.detail ?? '';
  $('problem').hidden = !problem;
  $('progress-hint').hidden = !!problem;
  const actions = $('problem-actions');
  actions.replaceChildren();
  if (problem) {
    $('problem-title').textContent = problem.title;
    $('problem-body').textContent = problem.body;
    problem.actions.forEach((action, i) => actions.appendChild(actionButton(action, i === 0)));
  }
}

function actionButton(action: LaunchAction, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'primary' : 'secondary';
  button.textContent = ACTION_LABELS[action];
  button.addEventListener('click', () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#problem-actions button')) b.disabled = true;
    void api.launch.act(action).finally(() => {
      for (const b of document.querySelectorAll<HTMLButtonElement>('#problem-actions button')) b.disabled = false;
    });
  });
  return button;
}

function apply(status: LaunchStatus): void {
  if (status.view === 'progress') {
    show('progress');
    renderProgress(status);
    return;
  }
  lastActive = 'idle';
  if (screens.progress.hidden === false || Object.values(screens).every((s) => s.hidden)) show('server');
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  document.body.dataset.framed = String(api.platform !== 'darwin');

  serverForm.addEventListener('change', (event) => {
    if ((event.target as HTMLElement)?.getAttribute('name') === 'mode') onModeChange();
  });
  runtimeForm.addEventListener('change', () => syncChoiceStyles(runtimeForm, 'runtime'));
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
  for (const form of [serverForm, runtimeForm]) form.addEventListener('submit', (event) => event.preventDefault());
  checkButton.addEventListener('click', () => void probe());
  continueButton.addEventListener('click', () => void onServerContinue());
  $('runtime-back').addEventListener('click', () => show('server'));
  $('runtime-continue').addEventListener('click', () => void onRuntimeContinue());

  // Pre-fill from a previous setup (Change Orbit Server… reopens this window).
  void api
    .getSetup()
    .then((saved) => {
      if (!saved) return;
      const radio = serverForm.querySelector<HTMLInputElement>(`input[value="${saved.mode}"]`);
      if (radio) radio.checked = true;
      if (saved.serverUrl) urlInput.value = saved.serverUrl;
      onModeChange();
    })
    .catch(() => {
      /* first run: nothing saved */
    });

  api.launch.onStatus(apply);
  void api.launch.status().then(apply);
  onModeChange();
}

wire();
