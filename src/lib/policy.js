/**
 * Pure decision logic for YouTube Limit.
 *
 * No I/O, no chrome.* calls, no DOM. Everything this file exports is a plain
 * function of its arguments, which is what makes the guard testable under
 * `node --test` without a browser.
 *
 * Loaded as a classic script in four places: the content script, the service
 * worker (importScripts), the options page, and the Node tests.
 */
(function (root) {
  'use strict';

  var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /**
   * Auto-generated "mixes" and the two pseudo-playlists that only exist for the
   * signed-in user. None of these are stable sets of videos, so none of them can
   * be whitelisted: a mix is whatever the recommender feels like serving, which
   * is exactly what this extension exists to shut off.
   */
  function isWhitelistableListId(listId) {
    if (typeof listId !== 'string' || listId.length === 0) return false;
    if (listId.indexOf('RD') === 0) return false; // RD..., RDPL..., RDCLAK... — mixes/radio
    if (listId === 'WL' || listId === 'LL') return false; // Watch Later, Liked
    return true;
  }

  /**
   * Classify a YouTube URL. Accepts absolute URLs or bare paths.
   * kind is 'watch' (anything with a player), 'shorts', or 'other'.
   */
  function parseLocation(rawUrl) {
    var url;
    try {
      url = new URL(rawUrl, 'https://www.youtube.com');
    } catch (e) {
      return { kind: 'other', videoId: null, listId: null };
    }

    var path = url.pathname.replace(/\/+$/, '') || '/';
    var listId = url.searchParams.get('list');
    var kind = 'other';
    var videoId = null;

    if (path === '/watch') {
      kind = 'watch';
      videoId = url.searchParams.get('v');
    } else if (path.indexOf('/shorts/') === 0) {
      kind = 'shorts';
      videoId = path.slice('/shorts/'.length).split('/')[0] || null;
    } else if (path.indexOf('/live/') === 0 || path.indexOf('/embed/') === 0) {
      // Both render a player on youtube.com itself, so they get gated like /watch.
      kind = 'watch';
      videoId = path.slice(path.indexOf('/', 1) + 1).split('/')[0] || null;
    }

    // Keep the raw value around: "there was a v param but it was malformed" has
    // to be distinguishable from "there was no v param at all", or junk IDs
    // sail through the no-video-id escape hatch below.
    var videoIdRaw = videoId;
    if (videoId && !VIDEO_ID_RE.test(videoId)) videoId = null;
    return { kind: kind, videoId: videoId, videoIdRaw: videoIdRaw, listId: listId };
  }

  /**
   * The whole policy, in order. Returns
   *   { action: 'allow'|'block', reason, videoId, listId, kind }
   *
   * index    — { videoId: [playlistId, ...] }
   * playlists— { playlistId: {...} }  (presence is what matters)
   * settings — { blockShorts }
   */
  function decide(input) {
    var settings = (input && input.settings) || {};
    var index = (input && input.index) || {};
    var playlists = (input && input.playlists) || {};
    var loc = parseLocation(input && input.url);

    function verdict(action, reason) {
      return {
        action: action,
        reason: reason,
        videoId: loc.videoId,
        listId: loc.listId,
        kind: loc.kind
      };
    }

    // 1. Anything that isn't a player page is none of our business.
    if (loc.kind === 'other') return verdict('allow', 'not-a-video-page');

    // 2. Shorts are blocked wholesale when enabled — the format can't be
    //    meaningfully whitelisted, since Shorts aren't in ordinary playlists.
    if (loc.kind === 'shorts' && settings.blockShorts) return verdict('block', 'shorts');

    // 3. Watching inside a whitelisted playlist. The fast path, and the only one
    //    that works for a playlist too long or too fresh to be fully indexed.
    if (isWhitelistableListId(loc.listId) &&
        Object.prototype.hasOwnProperty.call(playlists, loc.listId)) {
      return verdict('allow', 'playlist-context');
    }

    // 4. The video is in our local playlist index, however it was opened.
    if (loc.videoId) {
      var hits = index[loc.videoId];
      if (Array.isArray(hits) ? hits.length > 0 : Boolean(hits)) {
        return verdict('allow', 'indexed');
      }
    }

    // 5. A player page with neither a video nor a list is a redirect in flight.
    if (!loc.videoIdRaw && !loc.listId) return verdict('allow', 'no-video-id');

    return verdict('block', 'not-whitelisted');
  }

  /**
   * Pull a playlist ID out of whatever the user pasted into the options page:
   * a watch URL, a playlist URL, or a bare ID. Returns null if there isn't one.
   */
  function extractListId(input) {
    if (typeof input !== 'string') return null;
    var text = input.trim();
    if (!text) return null;

    if (/^[A-Za-z0-9_-]+$/.test(text)) return text; // bare ID

    try {
      var url = new URL(text, 'https://www.youtube.com');
      return url.searchParams.get('list');
    } catch (e) {
      return null;
    }
  }

  var REASON_TEXT = {
    'shorts': 'Shorts are blocked.',
    'not-whitelisted': 'This video is not in any playlist you have whitelisted.'
  };

  function describeReason(reason) {
    return REASON_TEXT[reason] || 'Blocked by YouTube Limit.';
  }

  var api = {
    VIDEO_ID_RE: VIDEO_ID_RE,
    isWhitelistableListId: isWhitelistableListId,
    parseLocation: parseLocation,
    decide: decide,
    extractListId: extractListId,
    describeReason: describeReason
  };

  root.YTLPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
