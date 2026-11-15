/**
 * The JavaScript that runs inside the Bot's browser, kept apart from the tools that send it.
 *
 * These strings are code, and one spliced selector into one of them once turned a working search
 * into a page that "never loaded" (the script threw SyntaxError on every evaluate, and the retry
 * loop swallowed it). Keeping them in one module makes them testable without a browser: see
 * __tests__/computer-research-scripts.test.ts, which parses every one of them.
 */

export const SEARCH_ENGINES = ['google', 'duckduckgo', 'bing'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

export function searchUrl(engine: SearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  if (engine === 'duckduckgo') return `https://html.duckduckgo.com/html/?q=${q}`;
  if (engine === 'bing') return `https://www.bing.com/search?q=${q}&setlang=en`;
  return `https://www.google.com/search?q=${q}&hl=en&num=20`;
}

/** A boolean predicate the page evaluates before its results are read. */
export const RESULTS_READY: Record<SearchEngine, string> = {
  google: "document.querySelector('#search, #rso, a h3') !== null",
  duckduckgo: "document.querySelector('#links .result, .result__a') !== null",
  bing: "document.querySelector('#b_results li.b_algo') !== null",
};

/** A script that returns the result rows of whichever engine's page is loaded. */
export function extractScript(engine: SearchEngine, limit: number): string {
  const n = Math.max(1, Math.round(limit));
  if (engine === 'duckduckgo') {
    return `(() => {
      const limit = ${n};
      const out = []; const seen = new Set();
      const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
      for (const r of document.querySelectorAll('#links .result, .result')) {
        const a = r.querySelector('.result__a, a.result__a') || r.querySelector('a');
        if (!a) continue;
        let href = a.href;
        try { const real = new URL(href).searchParams.get('uddg'); if (real) href = decodeURIComponent(real); } catch {}
        if (seen.has(href)) continue; seen.add(href);
        out.push({ title: clean(a.innerText).slice(0, 200), url: href, snippet: clean(r.querySelector('.result__snippet')?.innerText).slice(0, 300) });
        if (out.length >= limit) break;
      }
      return out;
    })()`;
  }
  if (engine === 'bing') {
    return `(() => {
      const limit = ${n};
      const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
      return [...document.querySelectorAll('#b_results li.b_algo')].slice(0, limit).map((li) => {
        const a = li.querySelector('h2 a');
        return { title: clean(a?.innerText).slice(0, 200), url: a?.href ?? '', snippet: clean(li.querySelector('.b_caption p, p')?.innerText).slice(0, 300) };
      }).filter((r) => r.url);
    })()`;
  }
  return `(() => {
    const limit = ${n};
    const out = []; const seen = new Set();
    const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
    const add = (href, title, snippet) => {
      if (!href || !/^https?:/.test(href) || seen.has(href)) return;
      seen.add(href);
      out.push({ title: clean(title).slice(0, 200), url: href, snippet: clean(snippet).slice(0, 300) });
    };
    for (const h of document.querySelectorAll('#search a h3, #rso a h3, a h3')) {
      const a = h.closest('a');
      const block = h.closest('div[data-hveid]') || h.closest('div.g') || a?.parentElement;
      add(a && a.href, h.textContent, block ? block.innerText : '');
    }
    if (out.length < 3) {
      for (const a of document.querySelectorAll('a[href^="http"]')) {
        if (a.closest('header,nav,footer')) continue;
        add(a.href, a.innerText, '');
      }
    }
    return out.slice(0, limit);
  })()`;
}

/** Google Images has painted a downloadable thumbnail. */
export const IMAGE_READY = "[...document.images].some((i) => i.src.startsWith('http') && i.naturalWidth > 80)";

/**
 * Click the first tile to open the lightbox (its images are much larger than the grid's), then
 * return the biggest distinct pictures on the page.
 */
export function imageScript(count: number): string {
  return `(async () => {
    const count = ${Math.max(1, Math.round(count))};
    const first = [...document.images].find((i) => i.naturalWidth > 100 && i.src.startsWith('http'));
    if (first) {
      const tile = first.closest('div[jsname]') || first.closest('a') || first.parentElement;
      if (tile && typeof tile.click === 'function') tile.click();
      await new Promise((r) => setTimeout(r, 1600));
    }
    const seen = new Set();
    const out = [];
    for (const i of [...document.images].filter((i) => i.src.startsWith('http') && i.naturalWidth >= 160).sort((x, y) => y.naturalWidth * y.naturalHeight - x.naturalWidth * x.naturalHeight)) {
      if (seen.has(i.src)) continue;
      seen.add(i.src);
      out.push({ src: i.src, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt || '').slice(0, 200) });
      if (out.length >= count) break;
    }
    return out;
  })()`;
}

/** YouTube is a SPA: the results are there when the first video renderer exists. */
export const VIDEO_READY = "document.querySelectorAll('ytd-video-renderer').length > 0";

/** The videos on a YouTube results page. */
export function videoScript(limit: number): string {
  return `(() => {
    const limit = ${Math.max(1, Math.round(limit))};
    const clean = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
    return [...document.querySelectorAll('ytd-video-renderer')].slice(0, limit).map((v) => {
      const link = v.querySelector('a#video-title, a#video-title-link');
      return {
        title: clean(link?.innerText).slice(0, 200),
        url: link?.href ?? '',
        channel: clean(v.querySelector('#channel-name, ytd-channel-name')?.innerText).slice(0, 120),
        duration: clean(v.querySelector('ytd-thumbnail-overlay-time-status-renderer')?.innerText).slice(0, 20),
        thumbnail: v.querySelector('img')?.src ?? '',
      };
    }).filter((v) => v.url);
  })()`;
}

/** The readable text of the page, for computer_read_page. */
export function pageTextScript(maxChars: number): string {
  return `(() => {
    const max = ${Math.max(200, Math.round(maxChars))};
    return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, max) };
  })()`;
}

/** Bing Images, the fallback when Google serves a bot wall to this computer's address. */
export const BING_IMAGE_READY = "document.querySelectorAll('a.iusc').length > 0";

/**
 * Bing puts the full-size URL, a thumbnail and the title in each tile's `m` attribute as JSON.
 * The thumbnail is kept as a fallback: some hosts refuse a direct fetch of the original.
 */
export function bingImageScript(count: number): string {
  return `(() => {
    const count = ${Math.max(1, Math.round(count))};
    const out = [];
    for (const a of document.querySelectorAll('a.iusc')) {
      let m;
      try { m = JSON.parse(a.getAttribute('m') || '{}'); } catch { continue; }
      if (!m || !m.murl) continue;
      out.push({ src: m.murl, fallback: m.turl || null, w: 0, h: 0, alt: String(m.t || '').slice(0, 200) });
      if (out.length >= count) break;
    }
    return out;
  })()`;
}

export function bingImageUrl(query: string): string {
  return `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
}
