/**
 * A small, self-contained window that shows one install's progress (Docker Desktop, Apple's
 * container runtime). It loads a static page from a data: URL with no preload and no Node,
 * and the main process pushes lines into it; a long download must never look like a hang.
 */
import { BrowserWindow } from 'electron';

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 22px 24px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #161616; color: #f2f2f2; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p { margin: 0 0 14px; color: #f2f2f2ad; }
  .bar { height: 6px; border-radius: 3px; background: #2a2a2a; overflow: hidden; margin-bottom: 14px; }
  .bar i { display: block; height: 100%; width: 0; background: #5b5fc7; transition: width 200ms; }
  .bar.indeterminate i { width: 30%; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  ol { margin: 0; padding-left: 18px; color: #f2f2f2d9; max-height: 150px; overflow: auto; }
  li.err { color: #f87171; }
</style></head><body>
<h1 id="t"></h1><p id="s"></p><div class="bar indeterminate" id="b"><i></i></div><ol id="l"></ol>
</body></html>`;

export interface ProgressWindow {
  line(text: string): void;
  percent(value: number | null): void;
  fail(text: string): void;
  close(): void;
}

export function openProgressWindow(title: string, subtitle: string, parent?: BrowserWindow | null): ProgressWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title,
    parent: parent ?? undefined,
    backgroundColor: '#161616',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  win.setMenuBarVisibility(false);
  const ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).then(() =>
    run(`document.getElementById('t').textContent=${JSON.stringify(title)};document.getElementById('s').textContent=${JSON.stringify(subtitle)};`),
  );
  function run(js: string): Promise<unknown> {
    if (win.isDestroyed()) return Promise.resolve();
    return win.webContents.executeJavaScript(js).catch(() => undefined);
  }
  const later = (js: string) => void ready.then(() => run(js));
  return {
    line(text) {
      later(`(()=>{const li=document.createElement('li');li.textContent=${JSON.stringify(text)};const l=document.getElementById('l');l.appendChild(li);l.scrollTop=l.scrollHeight;})()`);
    },
    percent(value) {
      later(
        value === null
          ? `document.getElementById('b').className='bar indeterminate';document.querySelector('#b i').style.width=''`
          : `document.getElementById('b').className='bar';document.querySelector('#b i').style.width='${Math.max(0, Math.min(100, Math.round(value)))}%'`,
      );
    },
    fail(text) {
      later(`(()=>{const li=document.createElement('li');li.className='err';li.textContent=${JSON.stringify(text)};document.getElementById('l').appendChild(li);document.getElementById('b').className='bar';})()`);
    },
    close() {
      if (!win.isDestroyed()) win.close();
    },
  };
}
