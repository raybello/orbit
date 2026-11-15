// Launch video: start muted-autoplay-free; the overlay button plays with sound.
(function () {
  var fig = document.querySelector('.video');
  var video = document.getElementById('launch-video');
  var btn = fig && fig.querySelector('.video__play');
  if (!video || !btn) return;
  btn.addEventListener('click', function () {
    video.muted = false;
    video.currentTime = 0;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  });
  video.addEventListener('play', function () { fig.classList.add('is-playing'); });
})();

// Tabs (docs setup page): arrow keys move between tabs, click selects.
document.querySelectorAll('[role="tablist"]').forEach(function (list) {
  var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
  function select(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.tabIndex = t.getAttribute('aria-selected') === 'true' ? 0 : -1;
    t.addEventListener('click', function () { select(t); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      select(next); next.focus(); e.preventDefault();
    });
  });
});

// Copy buttons on code blocks.
document.querySelectorAll('[data-copy]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var el = document.getElementById(btn.getAttribute('data-copy'));
    if (!el || !navigator.clipboard) return;
    navigator.clipboard.writeText(el.innerText.trim()).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    }).catch(function () {});
  });
});

// Download picker: the latest GitHub release, the right installer for this computer.
(function () {
  var root = document.querySelector('[data-download]');
  if (!root) return;
  var repo = root.getAttribute('data-repo');
  var select = root.querySelector('select');
  var $ = function (name) { return root.querySelector('[data-dl-' + name + ']'); };
  var link = $('link'), label = $('label');
  var PLATFORMS = {
    'mac-arm64': { name: 'macOS (Apple silicon)', match: function (n) { return /arm64\.dmg$/i.test(n); },
      note: 'Not signed yet. Drag Orbit to Applications; if macOS says it was not opened, run xattr -dr com.apple.quarantine /Applications/Orbit.app in Terminal or use Privacy & Security → Open Anyway, then open it again.' },
    'mac-x64': { name: 'macOS (Intel)', match: function (n) { return /\.dmg$/i.test(n) && !/arm64/i.test(n); },
      note: 'Not signed yet. Drag Orbit to Applications; if macOS says it was not opened, run xattr -dr com.apple.quarantine /Applications/Orbit.app in Terminal or use Privacy & Security → Open Anyway.' },
    'win-x64': { name: 'Windows', match: function (n) { return /\.exe$/i.test(n); },
      note: 'Not signed yet: if SmartScreen warns, choose More info → Run anyway.' },
    'linux-x64': { name: 'Linux', match: function (n) { return /\.AppImage$/i.test(n); },
      note: 'Make it executable (chmod +x Orbit-*.AppImage), then run it.' }
  };
  var release = null;

  function size(bytes) {
    if (!bytes) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(i > 1 ? 1 : 0) + ' ' + u[i];
  }
  function set(name, text) { var el = $(name); if (el) el.textContent = text; }

  function render() {
    var key = select.value, p = PLATFORMS[key];
    try { localStorage.setItem('orbit.dlPlatform', key); } catch (e) { /* storage blocked */ }
    set('note', p.note);
    if (!release) return;
    var asset = (release.assets || []).filter(function (a) { return p.match(a.name); })[0];
    set('version', release.tag_name || release.name || '—');
    set('date', release.published_at ? new Date(release.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
    $('all').href = release.html_url || ('https://github.com/' + repo + '/releases');
    if (asset) {
      link.href = asset.browser_download_url;
      link.removeAttribute('aria-disabled');
      label.textContent = 'Download for ' + p.name;
      set('file', asset.name);
      set('size', size(asset.size));
      set('sha', asset.digest ? asset.digest.replace(/^sha256:/, '') : 'Not published for this file');
    } else {
      link.href = release.html_url || ('https://github.com/' + repo + '/releases');
      link.setAttribute('aria-disabled', 'true');
      label.textContent = 'No ' + p.name + ' build in this release';
      set('file', '—'); set('size', '—'); set('sha', '—');
    }
  }

  function detect() {
    var saved = null;
    try { saved = localStorage.getItem('orbit.dlPlatform'); } catch (e) { /* storage blocked */ }
    var ua = navigator.userAgent || '';
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var guess = /Win/i.test(plat + ua) ? 'win-x64' : /Mac/i.test(plat + ua) && !/iPhone|iPad/i.test(ua) ? 'mac-arm64' : /Linux|X11/i.test(plat + ua) && !/Android/i.test(ua) ? 'linux-x64' : null;
    var note = guess ? 'Detected ' + PLATFORMS[guess].name + '. Pick another platform above if that is wrong.' : 'Pick your platform above.';
    select.value = saved && PLATFORMS[saved] ? saved : guess || 'mac-arm64';
    set('detect', saved && PLATFORMS[saved] ? 'Showing your last choice.' : note);
    if (!saved && guess === 'mac-arm64') {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (v) {
          if (v.architecture === 'x86') { select.value = 'mac-x64'; set('detect', 'Detected an Intel Mac.'); render(); }
          else set('detect', 'Detected a Mac with Apple silicon.');
        }).catch(function () {});
      } else {
        set('detect', 'Detected a Mac. This browser does not say which chip, so Apple silicon is selected; choose Intel if your Mac is older.');
      }
    }
  }

  function load() {
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem('orbit.release') || 'null'); } catch (e) { /* ignore */ }
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) { release = cached.data; render(); return; }
    fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? 'none' : 'http ' + r.status); return r.json(); })
      .then(function (data) {
        release = data;
        try { sessionStorage.setItem('orbit.release', JSON.stringify({ at: Date.now(), data: data })); } catch (e) { /* ignore */ }
        render();
      })
      .catch(function (err) {
        set('version', err.message === 'none' ? 'No release published yet' : 'Could not reach GitHub');
        ['date', 'file', 'size', 'sha'].forEach(function (k) { set(k, '—'); });
        label.textContent = 'See releases on GitHub';
      });
  }

  select.addEventListener('change', function () { set('detect', ''); render(); });
  $('copy').addEventListener('click', function () {
    var sha = $('sha').textContent;
    if (!/^[0-9a-f]{64}$/.test(sha) || !navigator.clipboard) return;
    var btn = $('copy');
    navigator.clipboard.writeText(sha).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); });
  });
  detect();
  render();
  load();
})();
