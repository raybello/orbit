// Frames an artifact Orbit sends over postMessage, with the same sandbox as the in-app frame
// (keep it equal to ARTIFACT_SANDBOX in src/components/ArtifactFrame.tsx).
(function () {
  var SANDBOX = 'allow-scripts allow-forms allow-modals';
  var opener = window.opener;
  if (!opener) {
    document.getElementById('waiting').textContent = 'Open an artifact from Orbit to show it here.';
    return;
  }
  window.addEventListener('message', function onMessage(e) {
    if (e.source !== opener || e.origin !== location.origin || !e.data || e.data.type !== 'artifact') return;
    window.removeEventListener('message', onMessage);
    window.opener = null;
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = String(e.data.title || 'Artifact');
    frame.srcdoc = String(e.data.html || '');
    document.title = frame.title;
    document.body.replaceChildren(frame);
  });
  opener.postMessage({ type: 'artifact-window-ready' }, location.origin);
})();
