import fs from 'node:fs/promises';
import { dockerProvider } from './docker-provider.js';
import path from 'node:path';
import { env } from './env.js';
import { CdpSession, cdpAlive, listTabs, openTab, closeTab, type CdpTab } from './lib/cdp.js';
import { BING_IMAGE_READY, IMAGE_READY, RESULTS_READY, SEARCH_ENGINES, VIDEO_READY, bingImageScript, bingImageUrl, extractScript, imageScript, pageTextScript, searchUrl, videoScript, type SearchEngine } from './computer-research-scripts.js';
import type { ToolCtx, ToolResult } from './agent/tools/index.js';
import type { ActivityKind } from '@orbit/contracts';

/**
 * Research that happens on the Bot's own computer.
 *
 * A Bot's browser is the one place the user can watch the work happen: the tab opens, the results
 * page paints, the picture is saved. These tools drive that browser over CDP instead of answering
 * from an API, so "searched the web" is something the user can see rather than trust. They are also
 * the reason every Bot's prompt tells it to prefer them for web, image and video research.
 *
 * The screenshots a caller takes with computer_screenshot are the proof: same browser, same tab
 * list, same files in the Library.
 */

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const LIBRARY = () => `${env.botDataDir}/files`;


/**
 * The bot's browser, awake. Going through the provider means a container bot reaches its own
 * container's Chrome, whether this server runs on the host or in the stack.
 */
async function browserFor(ctx: ToolCtx): Promise<{ cdp: string }> {
  const provider = dockerProvider;
  const { screenId } = await provider.screenFor(ctx.userId, ctx.botId);
  let cdp = await provider.cdpUrl(ctx.botId, screenId);
  if (!(await cdpAlive(cdp))) {
    // The desktop may have been re-dressed or the Chrome may have died; one redress brings it back.
    await provider.readyScreen(ctx.userId, ctx.botId, { redress: true });
    cdp = await provider.cdpUrl(ctx.botId, screenId);
    if (!(await cdpAlive(cdp, 5000))) {
      throw new Error('The browser on your computer is not answering. Bring it up with computer_windows (or computer_shell "google-chrome &"), then try again.');
    }
  }
  return { cdp };
}

/**
 * Open a tab, wait for the thing the caller needs, then hand back the tab and a live session.
 *
 * `readyExpr` is a JavaScript predicate that the page evaluates: it must be a complete boolean
 * expression ("document.querySelector('#x') !== null"), not a CSS selector. The page also has to be
 * done loading, so a predicate that matches skeleton markup waits for the real paint.
 */
async function openAndWait(cdp: string, url: string, readyExpr: string, timeoutMs = 30_000): Promise<{ tab: CdpTab; session: CdpSession }> {
  const tab = await openTab(cdp, url);
  const session = await CdpSession.open(tab.wsUrl);
  const painted = await session.waitFor<boolean>(
    `(() => {
      const found = (() => { try { return Boolean(${readyExpr}); } catch { return false; } })();
      return document.readyState === 'complete' && found;
    })()`,
    { timeoutMs },
  );
  if (!painted) {
    // A page that never satisfies the selector still has a DOM worth reading (consent walls, bot
    // checks); the caller decides what to say about it rather than getting a hard failure.
    const title = await session.evaluate<string>('document.title').catch(() => '');
    session.close();
    throw new Error(`The page did not finish loading (title: ${title || 'unknown'}). It may be showing a consent or sign-in wall.`);
  }
  await session.bringToFront();
  return { tab, session };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

interface FoundImage { src: string; fallback?: string | null; w: number; h: number; alt: string }

/** Save one image into the Bot's Library and return the file name and media type. */
async function saveImage(botId: string, query: string, index: number, image: FoundImage): Promise<{ file: string; mime: string; bytes: number }> {
  // A full-size URL is tried first, then the thumbnail: image hosts sometimes refuse a direct fetch
  // of the original but serve their own cached copy.
  let lastError = '';
  let bytes: Buffer | null = null;
  let mime = '';
  for (const url of [image.src, image.fallback].filter((u): u is string => Boolean(u))) {
    try {
      const res = await fetch(url, {
        headers: {
          // gstatic and most search thumbnails reject a request without a browser-ish agent.
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36',
          accept: 'image/avif,image/webp,image/png,image/jpeg,*/*',
          referer: 'https://www.google.com/',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) throw new Error(`was ${type || 'not an image'}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength < 1024) throw new Error('was empty');
      bytes = body;
      mime = type;
      break;
    } catch (e) {
      lastError = String((e as { message?: unknown } | null)?.message ?? e);
    }
  }
  if (!bytes) throw new Error(`image ${index + 1} ${lastError}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `${slug(query)}-${index + 1}-${stamp}.${EXT[mime] ?? 'img'}`;
  const dir = path.join(LIBRARY(), botId, 'images');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, file), bytes);
  return { file, mime, bytes: bytes.byteLength };
}

const fail = (e: unknown) => `Could not finish that on your computer: ${String((e as { message?: unknown } | null)?.message ?? e)}`;

export const RESEARCH_TOOLS: ToolDef[] = [
  {
    name: 'computer_browser',
    description:
      'Control the browser on your own computer: list its tabs, open a URL in a new tab, close a tab, or bring one to the front. The user watches this screen, so opening a tab is how you show your work.',
    parameters: obj({
      action: { type: 'string', enum: ['list', 'open', 'close', 'activate'] },
      url: { type: 'string', description: 'For open: the page to load' },
      tab_id: { type: 'string', description: 'For close or activate: the tab id from list' },
    }, ['action']),
    activity: 'on_its_computer',
    label: 'Using its browser',
    impl: async (a, ctx) => {
      try {
        const { cdp } = await browserFor(ctx);
        const action = str(a.action, 20);
        if (action === 'open') {
          const url = str(a.url, 2000);
          if (!/^https?:\/\//i.test(url)) return { output: 'Give an http(s) URL to open.' };
          const tab = await openTab(cdp, url);
          return { output: JSON.stringify({ opened: { id: tab.id, url: tab.url } }) };
        }
        if (action === 'close') {
          const id = str(a.tab_id, 80);
          if (!id) return { output: 'Give the tab_id to close.' };
          await closeTab(cdp, id);
          return { output: `Closed tab ${id}.` };
        }
        if (action === 'activate') {
          const id = str(a.tab_id, 80);
          const tabs = await listTabs(cdp);
          const tab = tabs.find((t) => t.id === id);
          if (!tab) return { output: `No tab ${id}. Open tabs: ${tabs.map((t) => `${t.id} ${t.title}`).join(' | ') || 'none'}` };
          const s = await CdpSession.open(tab.wsUrl);
          try { await s.bringToFront(); } finally { s.close(); }
          return { output: `Brought "${tab.title}" to the front.` };
        }
        const tabs = await listTabs(cdp);
        return {
          output: JSON.stringify({ tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) }),
          summary: `${tabs.length} tab(s)`,
        };
      } catch (e) {
        return { output: fail(e) };
      }
    },
  },
  {
    name: 'computer_web_search',
    description:
      'Search the web on your own computer. Opens a real tab on your screen, reads the results page, and returns titles, links and snippets. Prefer this over any research API so the user can watch. Leave the tab open; take a computer_screenshot if a picture helps.',
    parameters: obj({
      query: { type: 'string', description: 'What to search for' },
      engine: { type: 'string', enum: [...SEARCH_ENGINES], description: 'Default google' },
      limit: { type: 'number', description: 'Results to return, default 8, at most 20' },
    }, ['query']),
    activity: 'on_its_computer',
    label: 'Searching the web',
    impl: async (a, ctx) => {
      const query = str(a.query, 300);
      if (!query) return { output: 'Give a query to search for.' };
      const limit = clamp(a.limit, 1, 20, 8);
      const requested = (SEARCH_ENGINES as readonly string[]).includes(str(a.engine, 20)) ? (str(a.engine, 20) as SearchEngine) : 'google';
      try {
        const { cdp } = await browserFor(ctx);
        // An engine can fail two ways: an empty results page, or a page that never loads because it
        // is a bot wall (Google answers a container's IP with /sorry) or a consent gate. Both fall
        // through to the next engine, and DuckDuckGo's HTML endpoint is last because it has neither.
        const attempted: string[] = [];
        for (const engine of [...new Set<SearchEngine>([requested, 'duckduckgo'])]) {
          try {
            const { tab, session } = await openAndWait(cdp, searchUrl(engine, query), RESULTS_READY[engine], 20_000);
            try {
              const results = await session.evaluate<{ title: string; url: string; snippet: string }[]>(extractScript(engine, limit));
              if (results?.length) {
                return {
                  output: JSON.stringify({ engine, query, tab: { id: tab.id, url: tab.url }, results, ...(attempted.length ? { skipped: attempted } : {}) }),
                  summary: `${results.length} result(s) on ${engine}`,
                };
              }
              attempted.push(`${engine}: no results`);
            } finally {
              session.close();
            }
          } catch (e) {
            attempted.push(`${engine}: ${String((e as { message?: unknown } | null)?.message ?? e).slice(0, 160)}`);
          }
        }
        return { output: `No results came back for "${query}". ${attempted.join('; ')}. Try computer_browser open on a news site, or x_search.` };
      } catch (e) {
        return { output: fail(e) };
      }
    },
  },
  {
    name: 'computer_image_search',
    description:
      'Find images on Google Images using your own browser, save the best ones into your Library, and return them as attachments. Opens the image tab on your screen so the user sees the search. Files land under images/ and appear in the Library and the Files page.',
    parameters: obj({
      query: { type: 'string', description: 'What to find pictures of' },
      count: { type: 'number', description: 'How many to save, default 3, at most 6' },
    }, ['query']),
    activity: 'on_its_computer',
    label: 'Finding images',
    impl: async (a, ctx) => {
      const query = str(a.query, 300);
      if (!query) return { output: 'Give a query to find images for.' };
      const count = clamp(a.count, 1, 6, 3);
      try {
        const { cdp } = await browserFor(ctx);
        // Google Images is the default; a walled address (Google answers a container IP with /sorry)
        // falls through to Bing Images, whose tiles carry the full-size URL in their markup.
        const attempts = [
          { name: 'Google', url: `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=2&hl=en`, ready: "[...document.images].some((i) => i.src.startsWith('http') && i.naturalWidth > 80)", script: imageScript(count) },
          { name: 'Bing', url: bingImageUrl(query), ready: BING_IMAGE_READY, script: bingImageScript(count) },
        ];
        let found: FoundImage[] = [];
        let tab: CdpTab | null = null;
        let source = '';
        const failures: string[] = [];
        for (const attempt of attempts) {
          try {
            const opened = await openAndWait(cdp, attempt.url, attempt.ready, 20_000);
            let pictures: FoundImage[];
            try {
              pictures = await opened.session.evaluate<FoundImage[]>(attempt.script);
            } finally {
              opened.session.close();
            }
            if (pictures?.length) {
              found = pictures;
              tab = opened.tab;
              source = attempt.name;
              break;
            }
            failures.push(`${attempt.name}: no pictures`);
          } catch (e) {
            failures.push(`${attempt.name}: ${String((e as { message?: unknown } | null)?.message ?? e).slice(0, 160)}`);
          }
        }
        if (!found.length) return { output: `No downloadable pictures for "${query}". ${failures.join('; ')}` };
        const saved: { file: string; mime: string; bytes: number; w: number; h: number; alt: string }[] = [];
        const skipped: string[] = [];
        for (const [i, image] of found.entries()) {
          try {
            const r = await saveImage(ctx.botId, query, i, image);
            saved.push({ ...r, w: image.w, h: image.h, alt: image.alt });
          } catch (e) {
            skipped.push(String((e as { message?: unknown } | null)?.message ?? e));
          }
        }
        if (!saved.length) return { output: `Found ${found.length} picture(s) but none could be saved. ${skipped.join('; ')}` };
        const lines = saved.map((s) => `[hq-file:images/${s.file}|${s.file}|${s.mime}]`);
        return {
          output: [
            `Saved ${saved.length} image(s) for "${query}" into your Library under images/, from the ${source} Images tab (${tab?.url ?? ''}).`,
            ...saved.map((s) => `- ${s.file}${s.w && s.h ? ` (${s.w}×${s.h})` : ''}, ${Math.round(s.bytes / 1024)} KB${s.alt ? ` — ${s.alt}` : ''}`),
            ...(skipped.length ? [`Skipped: ${skipped.join('; ')}`] : []),
            ...lines,
          ].join('\n'),
          summary: `Saved ${saved.length} image(s)`,
        };
      } catch (e) {
        return { output: fail(e) };
      }
    },
  },
  {
    name: 'computer_video_search',
    description:
      'Search YouTube on your own computer. Opens the results page on your screen and returns the videos it found (title, link, channel, duration, views). Take a computer_screenshot when a picture of the results helps.',
    parameters: obj({
      query: { type: 'string', description: 'What to search for' },
      limit: { type: 'number', description: 'Videos to return, default 8, at most 15' },
    }, ['query']),
    activity: 'on_its_computer',
    label: 'Finding videos',
    impl: async (a, ctx) => {
      const query = str(a.query, 300);
      if (!query) return { output: 'Give a query to search for.' };
      const limit = clamp(a.limit, 1, 15, 8);
      try {
        const { cdp } = await browserFor(ctx);
        const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
        const { tab, session } = await openAndWait(cdp, url, "document.querySelectorAll('ytd-video-renderer').length > 0", 30_000);
        let videos: { title: string; url: string; channel: string; duration: string; thumbnail: string }[];
        try {
          videos = await session.evaluate(videoScript(limit));
        } finally {
          session.close();
        }
        if (!videos?.length) return { output: `YouTube showed no results for "${query}". The page is open at ${tab.url}.` };
        return { output: JSON.stringify({ query, tab: { id: tab.id, url: tab.url }, videos, metadata: videos.map((v) => `${v.channel} · ${v.duration}`) }), summary: `${videos.length} video(s)` };
      } catch (e) {
        return { output: fail(e) };
      }
    },
  },
  {
    name: 'computer_read_page',
    description: 'Read the text of a page in your browser: pass a URL to open it in a new tab, or leave it out to read the tab you already have open. Use it after a search to read a source properly.',
    parameters: obj({
      url: { type: 'string', description: 'Optional: open this http(s) URL first' },
      tab_id: { type: 'string', description: 'Optional: read this tab instead of the newest one' },
      max_chars: { type: 'number', description: 'Default 8000, at most 20000' },
    }),
    activity: 'on_its_computer',
    label: 'Reading a page',
    impl: async (a, ctx) => {
      const max = clamp(a.max_chars, 500, 20_000, 8000);
      try {
        const { cdp } = await browserFor(ctx);
        const wanted = str(a.tab_id, 80);
        const url = str(a.url, 2000);
        let tab: CdpTab | undefined;
        if (url) {
          if (!/^https?:\/\//i.test(url)) return { output: 'Give an http(s) URL.' };
          tab = await openTab(cdp, url);
        } else {
          const tabs = await listTabs(cdp);
          tab = tabs.find((t) => t.id === wanted) ?? tabs[0];
        }
        if (!tab) return { output: 'There is no open tab to read. Pass a URL.' };
        const session = await CdpSession.open(tab.wsUrl);
        try {
          await session.waitFor<boolean>("document.readyState === 'complete' ? true : false", { timeoutMs: 20_000 });
          await session.bringToFront();
          const page = await session.evaluate<{ title: string; url: string; text: string }>(pageTextScript(max));
          const text = String(page?.text ?? '').replace(/\n{3,}/g, '\n\n').slice(0, max);
          return {
            output: `${page?.title || '(untitled)'} — ${page?.url ?? tab.url}\n\n${text || '(no readable text)'}`,
            summary: `Read ${text.length} characters`,
          };
        } finally {
          session.close();
        }
      } catch (e) {
        return { output: fail(e) };
      }
    },
  },
];
