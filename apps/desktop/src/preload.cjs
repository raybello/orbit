/**
 * The preload bridge. Deliberately tiny and dependency-free: this file is copied to
 * `dist/preload.cjs` by esbuild and runs with `contextIsolation: true`.
 *
 * The channel names and the shape of `window.orbitDesktop` mirror
 * `src/shared/api.ts` (`IPC`, `OrbitDesktopAPI`). They are duplicated because a preload
 * script cannot import the app's TS modules under sandbox; keep them in sync by hand.
 */

const { contextBridge, ipcRenderer } = require('electron');

const IPC = {
  stackGet: 'orbit:stack:get',
  stackStart: 'orbit:stack:start',
  stackStop: 'orbit:stack:stop',
  stackState: 'orbit:stack:state',
  setupGet: 'orbit:setup:get',
  setupSave: 'orbit:setup:save',
  setupClear: 'orbit:setup:clear',
  setupProbe: 'orbit:setup:probe',
  setupComplete: 'setup-complete',
  hermesStatus: 'orbit:hermes:status',
  hermesInstall: 'orbit:hermes:install',
  hermesInstallProgress: 'orbit:hermes:install-progress',
  hermesWireMcp: 'orbit:hermes:wire-mcp',
  updateCheck: 'orbit:update:check',
  updateReady: 'orbit:update:ready',
  updateInstall: 'orbit:update:install',
  noticeDismiss: 'orbit:notice:dismiss',
  openExternal: 'orbit:shell:open-external',
};

/**
 * Subscribe to a main-process channel and return an unsubscribe function, so a renderer
 * that re-renders cannot stack listeners (Electron's default max is 10).
 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => {
    try {
      cb(payload);
    } catch (err) {
      console.error('[orbit] listener failed', err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('orbitDesktop', {
  // Stack
  getStackState: () => ipcRenderer.invoke(IPC.stackGet),
  startStack: () => ipcRenderer.invoke(IPC.stackStart),
  stopStack: () => ipcRenderer.invoke(IPC.stackStop),
  onStackState: (cb) => subscribe(IPC.stackState, cb),
  // Setup
  getSetup: () => ipcRenderer.invoke(IPC.setupGet),
  saveSetup: (setup) => ipcRenderer.invoke(IPC.setupSave, setup),
  clearSetup: () => ipcRenderer.invoke(IPC.setupClear),
  probeServer: (url) => ipcRenderer.invoke(IPC.setupProbe, url),
  finishSetup: () => ipcRenderer.send(IPC.setupComplete),
  // Hermes
  getHermesStatus: () => ipcRenderer.invoke(IPC.hermesStatus),
  installHermes: (onProgress) => {
    const off = typeof onProgress === 'function' ? subscribe(IPC.hermesInstallProgress, onProgress) : () => {};
    return ipcRenderer.invoke(IPC.hermesInstall).finally(off);
  },
  wireHermesMcp: (token) => ipcRenderer.invoke(IPC.hermesWireMcp, token),
  // Updates
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  onUpdateReady: (cb) => subscribe(IPC.updateReady, cb),
  restartAndInstall: () => ipcRenderer.invoke(IPC.updateInstall),
  dismissUpdateNotice: () => ipcRenderer.send(IPC.noticeDismiss),
  // Shell
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  // Platform
  platform: process.platform,
  version: process.versions.electron,
});
