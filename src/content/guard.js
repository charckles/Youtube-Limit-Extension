/**
 * The gate. Runs at document_start on every youtube.com page.
 *
 * The hard part is timing: the verdict needs chrome.storage, which is async, but
 * a frame or a burst of audio must never reach the user first. So the script
 * hides the page synchronously on its very first statement, then decides.
 *
 * Depends on YTLPolicy (src/lib/policy.js), listed before this file in the
 * manifest's content_scripts.
 */
(function () {
  'use strict';

  var FAILSAFE_MS = 5000;   // no verdict by now => fail closed, but say why
  var SILENCE_MS = 100;     // how often to re-pause a video we don't want playing
  var URL_POLL_MS = 1000;   // backstop for navigations no event told us about

  var root = document.documentElement;
  var state = null;         // { settings, playlists, index }
  var currentUrl = null;
  var verdict = null;
  var silenceTimer = null;
  var pausedByUs = [];
  var overlayHost = null;
  var overlayRoot = null;
  var failsafeTimer = null;

  /**
   * Fire-and-forget message to the worker.
   *
   * Reloading the extension while a YouTube tab is open invalidates this
   * script's context, at which point every chrome.* call throws. That is
   * expected and harmless — the page will get a fresh content script on its
   * next load — so it must not surface as a console error on the user's page.
   */
  function tell(message) {
    try {
      var pending = chrome.runtime.sendMessage(message);
      if (pending && pending.catch) pending.catch(function () {});
    } catch (e) { /* extension context invalidated */ }
  }

  // --- Phase 1: hide first, ask questions later ------------------------

  function looksLikeVideoPage(href) {
    var kind = YTLPolicy.parseLocation(href).kind;
    return kind === 'watch' || kind === 'shorts';
  }

  function setPending() {
    if (root.dataset.ytl === 'blocked') return;
    root.dataset.ytl = 'pending';
    startSilencing();
    if (failsafeTimer) clearTimeout(failsafeTimer);
    failsafeTimer = setTimeout(function () {
      // Storage should answer in single-digit milliseconds. If it hasn't, the
      // extension is broken — fail closed rather than opening the floodgates,
      // but put a message on screen so it isn't a mysterious blank page.
      if (!verdict) applyBlock({ reason: 'unavailable', videoId: null });
    }, FAILSAFE_MS);
  }

  // --- Keeping quiet ----------------------------------------------------

  function eachVideo(fn) {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      try { fn(videos[i]); } catch (e) { /* element torn down mid-iteration */ }
    }
  }

  function startSilencing() {
    if (silenceTimer) return;
    silenceTimer = setInterval(silenceTick, SILENCE_MS);
    silenceTick();
  }

  function stopSilencing() {
    if (!silenceTimer) return;
    clearInterval(silenceTimer);
    silenceTimer = null;
  }

  function silenceTick() {
    var blocked = verdict && verdict.action === 'block';
    eachVideo(function (video) {
      if (!video.paused) {
        if (pausedByUs.indexOf(video) === -1) pausedByUs.push(video);
        video.pause();
      }
      if (blocked) {
        // Pausing alone isn't enough — YouTube retries play() and will happily
        // keep buffering. Cut the stream off at the source.
        video.muted = true;
        if (video.src || video.currentSrc) {
          video.removeAttribute('src');
          try { video.load(); } catch (e) { /* already detached */ }
        }
      }
    });
  }

  /**
   * We paused videos speculatively while deciding. If the answer turned out to
   * be "allow", hand playback back rather than leaving the user staring at a
   * paused player they never paused.
   */
  function resumePausedVideos() {
    var toResume = pausedByUs;
    pausedByUs = [];
    toResume.forEach(function (video) {
      if (!video.isConnected) return;
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function () { /* user gesture needed */ });
    });
  }

  // --- The block screen -------------------------------------------------

  function whenBodyReady(fn) {
    if (document.body) { fn(); return; }
    var observer = new MutationObserver(function () {
      if (!document.body) return;
      observer.disconnect();
      fn();
    });
    observer.observe(root, { childList: true });
  }

  function pageTitle() {
    var title = (document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();
    if (title && title.toLowerCase() !== 'youtube') return title;
    var meta = document.querySelector('meta[name="title"]');
    return (meta && meta.content) || '';
  }

  function buildOverlay() {
    overlayHost = document.createElement('div');
    overlayHost.id = 'ytl-overlay-host';
    // A closed shadow root keeps YouTube's stylesheets — and its habit of
    // restyling everything on navigation — away from the block screen.
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
    overlayRoot.innerHTML = [
      '<style>',
      ':host { all: initial; }',
      '.wrap { position: fixed; inset: 0; z-index: 2147483647; display: flex;',
      '  align-items: center; justify-content: center; padding: 24px;',
      '  background: #0f0f0f; color: #f1f1f1;',
      '  font: 400 15px/1.6 "Roboto", system-ui, -apple-system, sans-serif; }',
      '.card { max-width: 520px; text-align: center; }',
      'h1 { margin: 0 0 12px; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }',
      '.reason { margin: 0 0 20px; color: #aaa; }',
      '.title { margin: 0 0 8px; font-size: 16px; color: #f1f1f1; word-break: break-word; }',
      '.meta { margin: 0 0 28px; font-size: 12px; color: #717171;',
      '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      'button { font: inherit; font-size: 14px; padding: 10px 18px; border: 0;',
      '  border-radius: 18px; background: #f1f1f1; color: #0f0f0f; cursor: pointer; }',
      'button:hover { background: #fff; }',
      '.note { margin: 24px 0 0; font-size: 12px; color: #717171; }',
      '</style>',
      '<div class="wrap"><div class="card">',
      '  <h1>Blocked</h1>',
      '  <p class="reason"></p>',
      '  <p class="title"></p>',
      '  <p class="meta"></p>',
      '  <button type="button">Open YouTube Limit settings</button>',
      '  <p class="note">Whitelist this video’s playlist in settings if you actually need it.</p>',
      '</div></div>'
    ].join('\n');

    overlayRoot.querySelector('button').addEventListener('click', function () {
      tell({ type: 'openOptions' });
    });
  }

  function renderOverlay(result) {
    if (!overlayRoot) buildOverlay();

    var reason = result.reason === 'unavailable'
      ? 'YouTube Limit could not read its settings, so nothing is allowed through.'
      : YTLPolicy.describeReason(result.reason);

    overlayRoot.querySelector('.reason').textContent = reason;
    overlayRoot.querySelector('.title').textContent = pageTitle();
    overlayRoot.querySelector('.meta').textContent = result.videoId
      ? 'video ' + result.videoId + (result.listId ? '  ·  list ' + result.listId : '')
      : '';

    if (overlayHost.parentNode !== document.body) document.body.appendChild(overlayHost);

    // document.title lands after document_start; refresh once it has.
    setTimeout(function () {
      if (overlayRoot) overlayRoot.querySelector('.title').textContent = pageTitle();
    }, 600);
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
  }

  // --- Applying a verdict -----------------------------------------------

  function applyBlock(result) {
    verdict = { action: 'block', reason: result.reason, videoId: result.videoId };
    if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
    pausedByUs = [];
    startSilencing();
    whenBodyReady(function () {
      root.dataset.ytl = 'blocked';
      renderOverlay(result);
    });

    if (result.reason !== 'unavailable') {
      var blockedUrl = location.href;
      // document.title trails an in-page navigation, so wait for it to settle.
      // Logging immediately would record the previous video's name against this
      // video's id, which makes the log actively misleading.
      setTimeout(function () {
        if (location.href !== blockedUrl) return;
        if (!verdict || verdict.action !== 'block') return;
        tell({
          type: 'logBlock',
          entry: {
            at: Date.now(),
            videoId: result.videoId,
            listId: result.listId || null,
            title: pageTitle(),
            reason: result.reason
          }
        });
      }, 800);
    }
  }

  function applyAllow() {
    verdict = { action: 'allow' };
    delete root.dataset.ytl;
    if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
    removeOverlay();
    stopSilencing();
    resumePausedVideos();
  }

  function applyDeclutter() {
    if (!state) return;
    if (state.settings.blankHomeFeed) root.dataset.ytlHome = 'blank';
    else delete root.dataset.ytlHome;
    if (state.settings.hideRecommendations) root.dataset.ytlRecs = 'hide';
    else delete root.dataset.ytlRecs;
  }

  // --- The decision loop ------------------------------------------------

  function check(force) {
    var href = location.href;
    if (!force && href === currentUrl && verdict) return;
    currentUrl = href;
    verdict = null;

    if (!state) {
      if (looksLikeVideoPage(href)) setPending();
      return; // the state load will call back through here
    }

    var result = YTLPolicy.decide({
      url: href,
      index: state.index,
      playlists: state.playlists,
      settings: state.settings
    });

    if (result.action === 'block') applyBlock(result);
    else applyAllow();
  }

  function onNavigate() {
    if (location.href === currentUrl) return;
    // Re-hide before deciding: on an in-page navigation the old page is still
    // on screen and the new video is already being fetched.
    if (looksLikeVideoPage(location.href)) {
      delete root.dataset.ytl;
      removeOverlay();
      setPending();
    }
    check(true);
  }

  function loadState() {
    var request;
    try {
      request = chrome.storage.local.get(['settings', 'playlists', 'index']);
    } catch (e) {
      return Promise.reject(e);
    }
    return request.then(function (raw) {
      state = {
        settings: Object.assign({
          blockShorts: true,
          blankHomeFeed: true,
          hideRecommendations: true
        }, raw.settings || {}),
        playlists: raw.playlists || {},
        index: raw.index || {}
      };
      applyDeclutter();
      check(true);
    });
  }

  // --- Wiring -----------------------------------------------------------

  // Statement one: hide the page if it might play something.
  if (looksLikeVideoPage(location.href)) setPending();
  currentUrl = location.href;

  loadState().catch(function () {
    if (looksLikeVideoPage(location.href)) applyBlock({ reason: 'unavailable', videoId: null });
  });

  // Whitelist a playlist and the page you're staring at should unblock itself.
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    if (!changes.settings && !changes.playlists && !changes.index) return;
    loadState().catch(function () {});
  });

  // YouTube is a single-page app: it swaps videos without a document load, so
  // every one of these is a "navigation" we have to notice.
  ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'].forEach(function (name) {
    document.addEventListener(name, onNavigate, true);
  });
  window.addEventListener('popstate', onNavigate);

  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    history[method] = function () {
      var result = original.apply(this, arguments);
      onNavigate();
      return result;
    };
  });

  // Nothing above is documented API, so poll as a last line of defence.
  setInterval(onNavigate, URL_POLL_MS);

  // No MutationObserver here on purpose: YouTube mutates the DOM constantly, and
  // a subtree observer would fire thousands of times a minute. The 100ms silence
  // interval already catches the player the moment it appears, and it stops
  // entirely once a video is allowed.
})();
