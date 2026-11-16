/**
 * Which pages a saved login belongs to.
 *
 * A pattern is a site, optionally with every subdomain (`*.`) and a path prefix:
 *
 *   github.com              https://github.com/ and everything under it
 *   *.amazon.com            amazon.com and any subdomain of it
 *   https://example.com/sso only /sso and below
 *   http://localhost:3000   plain http only when the pattern says so
 *
 * The scheme is part of the match on purpose: a login saved for a site is never typed into the
 * unencrypted version of it unless the person wrote `http://` themselves.
 */

export interface UrlPattern {
  scheme: 'https' | 'http';
  /** Lower-case host, with the port when it is not the scheme's default. */
  host: string;
  /** Also matches every subdomain of `host`. */
  subdomains: boolean;
  /** Path prefix; '/' matches the whole site. */
  path: string;
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;

/** A pattern as a person types it, or null when it does not name a site. */
export function parseUrlPattern(raw: string): UrlPattern | null {
  let rest = raw.trim();
  if (!rest || rest.length > 300) return null;
  let scheme: UrlPattern['scheme'] = 'https';
  const withScheme = /^(https?):\/\//i.exec(rest);
  if (withScheme) {
    scheme = withScheme[1].toLowerCase() as UrlPattern['scheme'];
    rest = rest.slice(withScheme[0].length);
  }
  const subdomains = rest.startsWith('*.');
  if (subdomains) rest = rest.slice(2);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '/' : rest.slice(slash);
  if (!HOST.test(host) || /[\s*?#]/.test(path)) return null;
  // `*.com` would hand a login to every site under a registry suffix.
  if (subdomains && !host.replace(/:\d+$/, '').includes('.')) return null;
  let url: URL;
  try {
    url = new URL(`${scheme}://${host}${path}`);
  } catch {
    return null;
  }
  return { scheme, host: url.host, subdomains, path: url.pathname };
}

export function formatUrlPattern(p: UrlPattern): string {
  return `${p.scheme}://${p.subdomains ? '*.' : ''}${p.host}${p.path === '/' ? '' : p.path}`;
}

/** Whether `url` is a page the pattern covers. Anything that is not an http(s) URL matches nothing. */
export function urlMatches(p: UrlPattern, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== `${p.scheme}:`) return false;
  if (u.host !== p.host && !(p.subdomains && u.host.endsWith(`.${p.host}`))) return false;
  if (p.path === '/') return true;
  const prefix = p.path.endsWith('/') ? p.path : `${p.path}/`;
  return u.pathname === p.path || u.pathname.startsWith(prefix);
}
