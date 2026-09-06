/**
 * The gate. Runs at document_start on every youtube.com page.
 *
 * The hard part is timing: the verdict needs chrome.storage, which is async, but
 * a frame or a burst of audio must never reach the user first. So the script
 * hides the page synchronously on its very first statement, then decides.
 *
 * Depends on YTLPolicy (src/lib/policy.js) and YTLStorage (src/lib/storage.js),
 * both listed before this file in the manifest's content_scripts.
 */
(function () {
  'use strict';

  var FAILSAFE_MS = 5000;   // no verdict by now => fail closed, but say why
  var SILENCE_MS = 100;     // how often to check for a video we don't want playing
  var URL_POLL_MS = 1000;   // backstop for navigations no event told us about

  var root = document.documentElement;
  var state = null;         // { settings, playlists, index }
  var currentUrl = null;
  var verdict = null;
  var pausedByUs = [];
  var overlayHost = null;
  var overlayRoot = null;
  var failsafeTimer = null;
  var titleObserver = null;

  // Set the moment a video is blocked; cleared only when we reach a genuine
  // "this video is fine" verdict for an actual watch/shorts page. YouTube can
  // keep a just-blocked video alive in its miniplayer after you navigate away
  // (e.g. pressing back to the playlist you opened it from) — without this,
  // that navigation would itself count as "allow" and hand playback back to
  // exactly the video this extension exists to stop.
  var suppressLingeringVideo = false;

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

  function neutralize(video) {
    if (!video.paused) video.pause();
    video.muted = true;
    if (video.src || video.currentSrc) {
      video.removeAttribute('src');
      try { video.load(); } catch (e) { /* already detached */ }
    }
  }

  // Runs continuously for the life of the tab rather than starting/stopping
  // around individual decisions — a persisted YouTube miniplayer can keep a
  // <video> alive on pages this script would otherwise consider none of its
  // business, so enforcement can't be tied to "are we currently on a video
  // page". The check itself is cheap (a handful of DOM property reads).
  function silenceTick() {
    var enforcing = suppressLingeringVideo || (verdict && verdict.action === 'block');
    eachVideo(function (video) {
      if (enforcing) {
        neutralize(video);
        return;
      }
      if (verdict === null && !video.paused) {
        // Decision still pending for the current page: pause speculatively so
        // nothing plays before we know the answer, and remember to hand it
        // back if the answer turns out to be allow. Never reached while
        // suppressLingeringVideo is set, since that takes the branch above —
        // so nothing added here is ever a video that was actually blocked.
        if (pausedByUs.indexOf(video) === -1) pausedByUs.push(video);
        video.pause();
      }
    });
  }

  /**
   * We paused videos speculatively while deciding. If the answer turned out to
   * be "allow", hand playback back rather than leaving the user staring at a
   * paused player they never paused. Safe unconditionally: this list only
   * ever holds videos paused during the branch above, never a blocked one.
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

  var MOTIVATION = [
    { emoji: '🌱', text: 'Growth happens off-screen too.' },
    { emoji: '📚', text: 'A page read is a minute well spent.' },
    { emoji: '🚶', text: 'Go stretch your legs for five minutes.' },
    { emoji: '🎯', text: 'What were you actually trying to do right now?' },
    { emoji: '🛠️', text: 'That side project isn’t going to build itself.' },
    { emoji: '☀️', text: 'The sun is still out there, promise.' },
    { emoji: '🧠', text: 'Future you will thank present you for closing this.' },
    { emoji: '💧', text: 'Drink some water while you’re at it.' },
    { emoji: '✍️', text: 'Write down the one thing you’re avoiding.' },
    { emoji: '🌙', text: 'Rest is productive too — but this probably isn’t rest.' }
  ];
  var lastQuoteIndex = -1;

  function pickQuote() {
    if (MOTIVATION.length === 1) return MOTIVATION[0];
    var idx;
    do { idx = Math.floor(Math.random() * MOTIVATION.length); } while (idx === lastQuoteIndex);
    lastQuoteIndex = idx;
    return MOTIVATION[idx];
  }

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
      '.meta { margin: 0 0 20px; font-size: 12px; color: #717171;',
      '  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
      '.quote { margin: 0 0 28px; font-size: 14px; color: #d0d0d0; }',
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
      '  <p class="quote"></p>',
      '  <button type="button">Open StudyGate settings</button>',
      '  <p class="note">Whitelist this video’s playlist in settings if you actually need it.</p>',
      '</div></div>'
    ].join('\n');

    overlayRoot.querySelector('button').addEventListener('click', function () {
      tell({ type: 'openOptions' });
    });
  }

  /**
   * Keep the overlay's title in sync as document.title catches up with an
   * in-page navigation. Guarded by URL + verdict so a callback left over from
   * a previous, already-superseded block can never overwrite a newer one —
   * that mismatch (this video's reason/id next to a stale title) is exactly
   * what clicking through several blocked videos quickly used to trigger.
   */
  function watchTitleFor(blockedUrl) {
    if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
    titleObserver = new MutationObserver(function () {
      if (location.href !== blockedUrl) return;
      if (!verdict || verdict.action !== 'block') return;
      if (overlayRoot) overlayRoot.querySelector('.title').textContent = pageTitle();
    });
    // Watch the whole head, not just the current <title> node: some SPAs
    // replace the node outright rather than editing its text in place.
    titleObserver.observe(document.head || root, { childList: true, subtree: true, characterData: true });
  }

  function renderOverlay(result) {
    if (!overlayRoot) buildOverlay();

    var reason = result.reason === 'unavailable'
      ? 'StudyGate could not read its settings, so nothing is allowed through.'
      : YTLPolicy.describeReason(result.reason);
    var quote = pickQuote();

    overlayRoot.querySelector('.reason').textContent = reason;
    overlayRoot.querySelector('.title').textContent = pageTitle();
    overlayRoot.querySelector('.meta').textContent = result.videoId
      ? 'video ' + result.videoId + (result.listId ? '  ·  list ' + result.listId : '')
      : '';
    overlayRoot.querySelector('.quote').textContent = quote.emoji + '  ' + quote.text;

    if (overlayHost.parentNode !== document.body) document.body.appendChild(overlayHost);
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
  }

  // --- The blanked home feed ---------------------------------------------

  var homePanelHost = null;
  var homePanelRoot = null;
  var homePanelWaiting = null; // MutationObserver, while the feed's own DOM hasn't rendered yet

  function findHomeFeedTarget() {
    return document.querySelector('ytd-browse[page-subtype="home"] #primary') ||
      document.querySelector('ytd-browse[page-subtype="home"] > #contents');
  }

  function buildHomePanel() {
    homePanelHost = document.createElement('div');
    homePanelHost.id = 'ytl-home-panel-host';
    homePanelRoot = homePanelHost.attachShadow({ mode: 'closed' });
    homePanelRoot.innerHTML = [
      '<style>',
      ':host { all: initial; }',
      '.wrap { max-width: 560px; margin: 64px auto; padding: 0 24px;',
      '  font: 400 15px/1.6 "Roboto", system-ui, -apple-system, sans-serif; color: #909090; }',
      'h2 { margin: 0 0 8px; font-size: 20px; font-weight: 500; color: #f1f1f1; }',
      '.message { margin: 0 0 28px; white-space: pre-wrap; }',
      '.checklist { list-style: none; margin: 0; padding: 0; }',
      '.checklist li { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0;',
      '  border-bottom: 1px solid #303030; cursor: pointer; }',
      '.checklist li:last-child { border-bottom: 0; }',
      '.checklist input { margin-top: 3px; flex: none; width: 16px; height: 16px; }',
      '.checklist span { color: #f1f1f1; }',
      '.checklist li.done span { color: #717171; text-decoration: line-through; }',
      '.empty { font-size: 13px; padding: 10px 0; }',
      '</style>',
      '<div class="wrap">',
      '  <h2>Home feed is off</h2>',
      '  <p class="message"></p>',
      '  <ul class="checklist"></ul>',
      '</div>'
    ].join('\n');
  }

  function renderHomePanelContent(data) {
    if (!homePanelRoot) buildHomePanel();
    homePanelRoot.querySelector('.message').textContent = data.homeMessage;

    var list = homePanelRoot.querySelector('.checklist');
    list.textContent = '';

    if (!data.checklist.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Add a few things to do instead in the extension’s settings.';
      list.appendChild(empty);
      return;
    }

    data.checklist.forEach(function (item) {
      var li = document.createElement('li');
      if (item.done) li.className = 'done';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(item.done);

      var span = document.createElement('span');
      span.textContent = item.text;

      li.appendChild(checkbox);
      li.appendChild(span);
      li.addEventListener('click', function (event) {
        event.preventDefault();
        YTLStorage.toggleChecklistItem(item.id).then(refreshHomePanel);
      });

      list.appendChild(li);
    });
  }

  function mountHomePanel(target) {
    if (!homePanelHost) buildHomePanel();
    if (homePanelHost.parentNode !== target) target.insertBefore(homePanelHost, target.firstChild);
  }

  function unmountHomePanel() {
    if (homePanelHost && homePanelHost.parentNode) homePanelHost.parentNode.removeChild(homePanelHost);
    if (homePanelWaiting) { homePanelWaiting.disconnect(); homePanelWaiting = null; }
  }

  /**
   * Re-checks whether the panel belongs on screen right now and (re)mounts or
   * removes it accordingly. Called on every navigation and storage change
   * rather than once, because YouTube's home feed renders its DOM
   * asynchronously and can re-render the very subtree we inserted into.
   */
  function refreshHomePanel() {
    if (!state || !state.settings.blankHomeFeed || location.pathname !== '/') {
      unmountHomePanel();
      return;
    }

    var target = findHomeFeedTarget();
    if (!target) {
      if (homePanelWaiting) return;
      homePanelWaiting = new MutationObserver(function () {
        if (!findHomeFeedTarget()) return;
        homePanelWaiting.disconnect();
        homePanelWaiting = null;
        refreshHomePanel();
      });
      homePanelWaiting.observe(document.body, { childList: true, subtree: true });
      return;
    }

    mountHomePanel(target);
    YTLStorage.getChecklist().then(function (checklist) {
      return YTLStorage.getSettings().then(function (settings) {
        renderHomePanelContent({ homeMessage: settings.homeMessage, checklist: checklist });
      });
    });
  }

  // --- Applying a verdict -----------------------------------------------

  function applyBlock(result) {
    verdict = { action: 'block', reason: result.reason, videoId: result.videoId };
    suppressLingeringVideo = true;
    if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
    whenBodyReady(function () {
      root.dataset.ytl = 'blocked';
      renderOverlay(result);
      watchTitleFor(location.href);
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

  function applyAllow(isVideoPage) {
    verdict = { action: 'allow' };
    delete root.dataset.ytl;
    if (failsafeTimer) { clearTimeout(failsafeTimer); failsafeTimer = null; }
    removeOverlay();
    if (isVideoPage) {
      // Only a genuine "this video is fine" verdict lifts the enforcement
      // guard. Landing on some other page (e.g. the playlist you went "back"
      // to) must never lift it on its own — see suppressLingeringVideo above.
      suppressLingeringVideo = false;
    }
    resumePausedVideos();
  }

  function applyDeclutter() {
    if (!state) return;
    // Gates the CSS that hides the actual feed grid — the home panel above is
    // the separate DOM node that replaces it, toggled by refreshHomePanel().
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

    var loc = YTLPolicy.parseLocation(href);
    var result = YTLPolicy.decide({
      url: href,
      index: state.index,
      playlists: state.playlists,
      settings: state.settings
    });

    if (result.action === 'block') applyBlock(result);
    else applyAllow(loc.kind === 'watch' || loc.kind === 'shorts');
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
    refreshHomePanel();
  }

  function loadState() {
    var request;
    try {
      request = YTLStorage.getPolicyState();
    } catch (e) {
      return Promise.reject(e);
    }
    return request.then(function (policyState) {
      state = policyState;
      applyDeclutter();
      refreshHomePanel();
      check(true);
    });
  }

  // --- Wiring -----------------------------------------------------------

  // Statement one: hide the page if it might play something.
  if (looksLikeVideoPage(location.href)) setPending();
  currentUrl = location.href;

  // Runs for the life of the tab — see the comment on silenceTick().
  setInterval(silenceTick, SILENCE_MS);
  silenceTick();

  loadState().catch(function () {
    if (looksLikeVideoPage(location.href)) applyBlock({ reason: 'unavailable', videoId: null });
  });

  // Whitelist a playlist and the page you're staring at should unblock itself.
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    if (!changes.settings && !changes.playlists && !changes.index && !changes.checklist) return;
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

  // Nothing above is documented API, so poll as a last line of defence. Also
  // re-checks the home panel every tick regardless of URL: YouTube can
  // re-render the subtree we inserted into without a navigation happening.
  setInterval(function () {
    onNavigate();
    refreshHomePanel();
  }, URL_POLL_MS);
})();
