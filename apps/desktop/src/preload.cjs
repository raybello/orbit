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
  launchOptions: 'orbit:launch:options',
  launchStatus: 'orbit:launch:status',
  launchChoose: 'orbit:launch:choose',
  launchAct: 'orbit:launch:act',
  setupGet: 'orbit:setup:get',
  setupProbe: 'orbit:setup:probe',
  updateCheck: 'orbit:update:check',
  updateReady: 'orbit:update:ready',
  updateInstall: 'orbit:update:install',
  noticeDismiss: 'orbit:notice:dismiss',
  openExternal: 'orbit:shell:open-external',
  deepLinkReady: 'orbit:deeplink:ready',
  deepLinkTake: 'orbit:deeplink:take',
  gpuVoiceStatus: 'orbit:gpu-voice:status',
  gpuVoiceSet: 'orbit:gpu-voice:set',
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
  // The launch window
  launch: {
    options: () => ipcRenderer.invoke(IPC.launchOptions),
    status: () => ipcRenderer.invoke(IPC.launchStatus),
    onStatus: (cb) => subscribe(IPC.launchStatus, cb),
    choose: (choice) => ipcRenderer.invoke(IPC.launchChoose, choice),
    act: (action) => ipcRenderer.invoke(IPC.launchAct, action),
  },
  getSetup: () => ipcRenderer.invoke(IPC.setupGet),
  probeServer: (url) => ipcRenderer.invoke(IPC.setupProbe, url),
  // Updates
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  onUpdateReady: (cb) => subscribe(IPC.updateReady, cb),
  restartAndInstall: () => ipcRenderer.invoke(IPC.updateInstall),
  dismissUpdateNotice: () => ipcRenderer.send(IPC.noticeDismiss),
  // Shell
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  // Deep links: main only says one is waiting; taking it is what hands it over, so a link that
  // arrived before this page subscribed is delivered too, and none is delivered twice.
  onDeepLink: (cb) => {
    const take = () =>
      ipcRenderer.invoke(IPC.deepLinkTake).then((link) => {
        if (link) cb(link);
      }, () => {});
    const off = subscribe(IPC.deepLinkReady, take);
    take();
    return off;
  },
  // GPU voice (audio.cpp sidecar): installed only when the person asks.
  gpuVoice: {
    status: () => ipcRenderer.invoke(IPC.gpuVoiceStatus),
    install: () => ipcRenderer.invoke(IPC.gpuVoiceSet, true),
    remove: () => ipcRenderer.invoke(IPC.gpuVoiceSet, false),
  },
  // Platform
  platform: process.platform,
  version: process.versions.electron,
});
