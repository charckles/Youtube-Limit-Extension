/**
 * Builds the videoId -> playlist index by scraping playlist pages.
 *
 * No API key and no quota: a playlist page ships its contents as a JSON blob
 * (`ytInitialData`) inside the HTML. Past the first ~100 videos YouTube hands
 * back a "continuation token" instead, which we redeem against the same
 * undocumented InnerTube endpoint the site itself uses.
 *
 * Parsing is pure and separately testable; only fetchPlaylist() does I/O, and it
 * takes its fetch implementation as an argument so Node can drive it too.
 */
(function (root) {
  'use strict';

  var MAX_PAGES = 50;          // ~5000 videos, then we stop and say so
  var PAGE_DELAY_MS = 250;     // be a polite client
  var INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/browse';

  /**
   * Extract a balanced JSON object starting at the first `{` at or after `from`.
   * Brace counting rather than a regex, because the blob is megabytes of nested
   * objects and contains `};` inside string literals.
   */
  function sliceJsonObject(text, from) {
    var start = text.indexOf('{', from);
    if (start === -1) return null;

    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < text.length; i++) {
      var ch = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }

      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Pull and parse the ytInitialData blob out of a playlist page's HTML. */
  function extractYtInitialData(html) {
    var markers = ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData ='];
    for (var i = 0; i < markers.length; i++) {
      var at = html.indexOf(markers[i]);
      if (at === -1) continue;
      var json = sliceJsonObject(html, at + markers[i].length);
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch (e) {
        /* try the next marker */
      }
    }
    return null;
  }

  /** The API key and client version the page would use for its own requests. */
  function extractInnertubeConfig(html) {
    var key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html);
    var version = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html);
    return {
      apiKey: key ? key[1] : null,
      clientVersion: version ? version[1] : null
    };
  }

  /**
   * Walk an arbitrary InnerTube response collecting what we care about.
   *
   * Deliberately structure-agnostic: YouTube reshuffles the shape of this tree
   * regularly, but the renderer names are stable, so searching for them anywhere
   * in the object survives changes that fixed paths would not.
   */
  function collectFromResponse(node) {
    var videoIds = [];
    var seen = new Set();
    var continuation = null;
    var title = null;
    var stack = [node];

    while (stack.length) {
      var current = stack.pop();
      if (!current || typeof current !== 'object') continue;

      if (Array.isArray(current)) {
        // Pushed back-to-front so that popping yields front-to-back: playlist
        // order is meaningful and must survive the walk.
        for (var i = current.length - 1; i >= 0; i--) stack.push(current[i]);
        continue;
      }

      var video = current.playlistVideoRenderer;
      if (video && typeof video.videoId === 'string' && !seen.has(video.videoId)) {
        seen.add(video.videoId);
        videoIds.push(video.videoId);
      }

      if (!continuation) {
        var command = current.continuationCommand;
        if (command && typeof command.token === 'string') continuation = command.token;
        var legacy = current.nextContinuationData;
        if (!continuation && legacy && typeof legacy.continuation === 'string') {
          continuation = legacy.continuation;
        }
      }

      if (title === null) {
        var meta = current.playlistMetadataRenderer;
        if (meta && typeof meta.title === 'string') title = meta.title;
      }

      var keys = Object.keys(current);
      for (var k = keys.length - 1; k >= 0; k--) stack.push(current[keys[k]]);
    }

    return { videoIds: videoIds, continuation: continuation, title: title };
  }

  /** Last-resort playlist name if playlistMetadataRenderer isn't there. */
  function extractHtmlTitle(html) {
    var match = /<title>([^<]*)<\/title>/i.exec(html);
    if (!match) return null;
    return match[1].replace(/\s*-\s*YouTube\s*$/i, '').trim() || null;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Fetch and fully page through one playlist.
   * Resolves { listId, title, videoIds, pages, truncated }.
   * Rejects with a human-readable Error the options page can display verbatim.
   */
  function fetchPlaylist(listId, options) {
    var opts = options || {};
    var doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    var maxPages = opts.maxPages || MAX_PAGES;
    var pageDelay = opts.pageDelayMs === undefined ? PAGE_DELAY_MS : opts.pageDelayMs;

    if (!doFetch) return Promise.reject(new Error('No fetch implementation available.'));

    var pageUrl = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(listId) + '&hl=en';

    return doFetch(pageUrl, {
      credentials: 'include',
      headers: { 'Accept-Language': 'en-US,en;q=0.9' }
    }).then(function (response) {
      if (!response.ok) {
        throw new Error('YouTube returned HTTP ' + response.status + ' for this playlist.');
      }
      return response.text();
    }).then(function (html) {
      var data = extractYtInitialData(html);
      if (!data) {
        throw new Error(
          'Could not read the playlist page. YouTube may have shown a consent or ' +
          'sign-in interstitial instead of the playlist.'
        );
      }

      var first = collectFromResponse(data);
      if (!first.videoIds.length && !first.continuation) {
        throw new Error(
          'No videos found. The playlist may be private, deleted, or empty. ' +
          'Private playlists only index while you are signed in to this browser profile.'
        );
      }

      var config = extractInnertubeConfig(html);
      var state = {
        listId: listId,
        title: first.title || extractHtmlTitle(html) || listId,
        videoIds: first.videoIds.slice(),
        seen: new Set(first.videoIds),
        seenTokens: new Set(),
        pages: 1,
        truncated: false
      };

      if (!first.continuation) return state;
      if (!config.apiKey || !config.clientVersion) {
        // First page still counts; say so rather than silently returning a
        // partial index that would hard-block the rest of the playlist.
        state.truncated = true;
        return state;
      }

      return pageThrough(state, first.continuation, config, doFetch, maxPages, pageDelay);
    }).then(function (state) {
      return {
        listId: state.listId,
        title: state.title,
        videoIds: state.videoIds,
        pages: state.pages,
        truncated: state.truncated
      };
    });
  }

  function pageThrough(state, token, config, doFetch, maxPages, pageDelay) {
    if (!token) return Promise.resolve(state);
    if (state.seenTokens.has(token)) {
      // YouTube handed back a token we already redeemed. We cannot advance, and
      // there may well be more videos behind it, so say the index is partial.
      state.truncated = true;
      return Promise.resolve(state);
    }
    if (state.pages >= maxPages) {
      state.truncated = true;
      return Promise.resolve(state);
    }
    state.seenTokens.add(token);

    var body = {
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: config.clientVersion,
          hl: 'en',
          gl: 'US'
        }
      },
      continuation: token
    };

    return delay(pageDelay).then(function () {
      return doFetch(INNERTUBE_URL + '?key=' + encodeURIComponent(config.apiKey) + '&prettyPrint=false', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': config.clientVersion
        },
        body: JSON.stringify(body)
      });
    }).then(function (response) {
      if (!response.ok) {
        // Partial data is still useful; flag it so the options page can warn.
        state.truncated = true;
        return null;
      }
      return response.json();
    }).then(function (json) {
      if (!json) return state;

      var page = collectFromResponse(json);
      page.videoIds.forEach(function (videoId) {
        if (state.seen.has(videoId)) return;
        state.seen.add(videoId);
        state.videoIds.push(videoId);
      });
      state.pages++;

      if (!page.continuation) return state;
      return pageThrough(state, page.continuation, config, doFetch, maxPages, pageDelay);
    }).catch(function () {
      state.truncated = true;
      return state;
    });
  }

  var api = {
    MAX_PAGES: MAX_PAGES,
    sliceJsonObject: sliceJsonObject,
    extractYtInitialData: extractYtInitialData,
    extractInnertubeConfig: extractInnertubeConfig,
    extractHtmlTitle: extractHtmlTitle,
    collectFromResponse: collectFromResponse,
    fetchPlaylist: fetchPlaylist
  };

  root.YTLPlaylistIndex = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
