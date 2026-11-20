/**
 * Model-written HTML runs here and nowhere else. The sandbox never includes allow-same-origin: the
 * frame gets an opaque origin, so its scripts cannot read Orbit's cookies, storage or parent window.
 * No allow-popups either: the desktop app hands any off-origin window to the default browser.
 */
export const ARTIFACT_SANDBOX = 'allow-scripts allow-forms allow-modals';

export function ArtifactFrame({ html, title }: { html: string; title: string }) {
  return <iframe className="artifact-frame" title={title} sandbox={ARTIFACT_SANDBOX} srcDoc={html} referrerPolicy="no-referrer" />;
}
