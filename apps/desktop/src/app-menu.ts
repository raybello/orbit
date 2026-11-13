/**
 * The application menu.
 *
 * Electron builds a default menu that includes "Reload" and "Toggle Developer Tools",
 * which in a shipped app is a footgun on the server-rendered UI. This template is
 * explicit about every item; nothing appears by default.
 */

import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import type { StackPhase } from './shared/api';

export interface MenuContext {
  /** The phase of the local stack, for the status line and Stop's enabled state. */
  stackPhase: () => StackPhase;
  isLocalServer: () => boolean;
  onChangeServer: () => void;
  onStopStack: () => void;
  onCheckForUpdates: () => void;
  onOpenSettings: () => void;
  onOpenDocs: () => void;
  onShowWindow: () => void;
}

function statusLabel(phase: StackPhase): string {
  switch (phase) {
    case 'ready':
      return 'Stack: running';
    case 'idle':
      return 'Stack: stopped';
    case 'failed':
      return 'Stack: failed';
    case 'docker-missing':
      return 'Stack: Docker not installed';
    case 'docker-not-running':
      return 'Stack: Docker not running';
    default:
      return `Stack: ${phase.replace(/-/g, ' ')}…`;
  }
}

export function buildAppMenu(ctx: MenuContext): Menu {
  const isMac = process.platform === 'darwin';
  const stackPhase = ctx.stackPhase();
  const local = ctx.isLocalServer();
  const stackActive = stackPhase !== 'idle' && stackPhase !== 'failed';

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'Cmd+,', click: () => ctx.onOpenSettings() },
            { label: 'Check for Updates…', click: () => ctx.onCheckForUpdates() },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  const serverMenu: MenuItemConstructorOptions[] = [
    {
      label: 'Change Orbit Server…',
      accelerator: 'CmdOrCtrl+Shift+K',
      click: () => ctx.onChangeServer(),
    },
    {
      label: 'Stop Local Stack',
      // Only meaningful when the local stack is the server, and only while it is up.
      enabled: local && stackActive,
      click: () => ctx.onStopStack(),
    },
    { type: 'separator' },
    {
      label: local ? statusLabel(stackPhase) : 'Stack: remote server',
      enabled: false,
    },
    ...(local
      ? []
      : [{ label: 'This app is using a remote server', enabled: false } as MenuItemConstructorOptions]),
    { type: 'separator' },
    ...(isMac
      ? []
      : [
          { label: 'Settings…', accelerator: 'Ctrl+,', click: () => ctx.onOpenSettings() } as MenuItemConstructorOptions,
        ]),
    { label: 'Check for Updates…', visible: !isMac, click: () => ctx.onCheckForUpdates() },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    { label: 'Server', submenu: serverMenu },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // A reload is a legitimate recovery action; the shortcut is not advertised.
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', visible: false, click: () => ctx.onShowWindow() },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      role: 'help',
      submenu: [{ label: 'Hermes Documentation', click: () => ctx.onOpenDocs() }],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** Rebuild on state changes: the Stack line and Stop's enabled state are menu-time. */
export function installAppMenu(ctx: MenuContext, onChange?: (menu: Menu) => void): Menu {
  const menu = buildAppMenu(ctx);
  Menu.setApplicationMenu(menu);
  onChange?.(menu);
  return menu;
}
