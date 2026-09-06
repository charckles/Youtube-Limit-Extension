/**
 * chrome.storage.local schema and helpers.
 *
 * Everything lives in `local`, not `sync`: the video index is the whole point of
 * the design and it blows past sync's 100 KB quota after a few playlists.
 *
 * {
 *   settings:  { blockShorts, blankHomeFeed, hideRecommendations, refreshIntervalHours, homeMessage },
 *   playlists: { "<listId>": { title, addedAt, lastIndexedAt, videoCount, lastError } },
 *   index:     { "<videoId>": ["<listId>", ...] },
 *   blockLog:  [ { at, videoId, title, reason } ],  // newest first, capped
 *   checklist: [ { id, text, done } ]                // shown on the blanked home feed
 * }
 */
(function (root) {
  'use strict';

  var BLOCK_LOG_MAX = 50;

  var DEFAULT_SETTINGS = {
    blockShorts: true,
    blankHomeFeed: true,
    hideRecommendations: true,
    refreshIntervalHours: 12,
    homeMessage: 'The home feed is off. Open a whitelisted playlist instead.'
  };

  // Only used the very first time nothing has been stored yet — after that,
  // whatever the user has (including an emptied-out list) is the real value.
  var DEFAULT_CHECKLIST = [
    { id: 'c1', text: 'Read a chapter of a book', done: false },
    { id: 'c2', text: 'Go for a short walk', done: false },
    { id: 'c3', text: 'Work on a side project', done: false }
  ];

  function area() {
    return chrome.storage.local;
  }

  function getAll() {
    return area().get(null).then(function (raw) {
      return {
        settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
        playlists: raw.playlists || {},
        index: raw.index || {},
        blockLog: raw.blockLog || [],
        checklist: raw.checklist === undefined ? DEFAULT_CHECKLIST.slice() : raw.checklist
      };
    });
  }

  /** The guard's hot path — everything decide() needs, nothing it doesn't. */
  function getPolicyState() {
    return area().get(['settings', 'playlists', 'index']).then(function (raw) {
      return {
        settings: Object.assign({}, DEFAULT_SETTINGS, raw.settings || {}),
        playlists: raw.playlists || {},
        index: raw.index || {}
      };
    });
  }

  function getSettings() {
    return area().get('settings').then(function (raw) {
      return Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    });
  }

  function patchSettings(patch) {
    return getSettings().then(function (settings) {
      var next = Object.assign({}, settings, patch);
      return area().set({ settings: next }).then(function () { return next; });
    });
  }

  function getPlaylists() {
    return area().get('playlists').then(function (raw) { return raw.playlists || {}; });
  }

  function putPlaylist(listId, meta) {
    return getPlaylists().then(function (playlists) {
      playlists[listId] = Object.assign({}, playlists[listId], meta);
      return area().set({ playlists: playlists }).then(function () { return playlists[listId]; });
    });
  }

  /**
   * Point every video in `videoIds` at `listId`, and drop entries that used to
   * belong to this playlist but no longer do. Videos that are also in another
   * whitelisted playlist keep their other memberships.
   */
  function replacePlaylistIndex(listId, videoIds) {
    return area().get('index').then(function (raw) {
      var index = raw.index || {};
      var wanted = new Set(videoIds);

      for (var videoId in index) {
        if (!Object.prototype.hasOwnProperty.call(index, videoId)) continue;
        if (wanted.has(videoId)) continue;
        var lists = index[videoId].filter(function (id) { return id !== listId; });
        if (lists.length) index[videoId] = lists;
        else delete index[videoId];
      }

      wanted.forEach(function (videoId) {
        var lists = index[videoId] || [];
        if (lists.indexOf(listId) === -1) lists = lists.concat(listId);
        index[videoId] = lists;
      });

      return area().set({ index: index }).then(function () { return wanted.size; });
    });
  }

  function removePlaylist(listId) {
    return Promise.all([getPlaylists(), area().get('index')]).then(function (results) {
      var playlists = results[0];
      var index = results[1].index || {};
      delete playlists[listId];

      for (var videoId in index) {
        if (!Object.prototype.hasOwnProperty.call(index, videoId)) continue;
        var lists = index[videoId].filter(function (id) { return id !== listId; });
        if (lists.length) index[videoId] = lists;
        else delete index[videoId];
      }

      return area().set({ playlists: playlists, index: index });
    });
  }

  function appendBlockLog(entry) {
    return area().get('blockLog').then(function (raw) {
      var log = raw.blockLog || [];
      // Collapse repeats: reloading a blocked page shouldn't flood the log.
      if (log.length && log[0].videoId === entry.videoId && log[0].reason === entry.reason) {
        log[0] = entry;
      } else {
        log.unshift(entry);
      }
      return area().set({ blockLog: log.slice(0, BLOCK_LOG_MAX) });
    });
  }

  function clearBlockLog() {
    return area().set({ blockLog: [] });
  }

  function getChecklist() {
    return area().get('checklist').then(function (raw) {
      return raw.checklist === undefined ? DEFAULT_CHECKLIST.slice() : raw.checklist;
    });
  }

  function setChecklist(items) {
    return area().set({ checklist: items }).then(function () { return items; });
  }

  function toggleChecklistItem(id) {
    return getChecklist().then(function (items) {
      var next = items.map(function (item) {
        return item.id === id ? Object.assign({}, item, { done: !item.done }) : item;
      });
      return setChecklist(next);
    });
  }

  var api = {
    BLOCK_LOG_MAX: BLOCK_LOG_MAX,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_CHECKLIST: DEFAULT_CHECKLIST,
    getAll: getAll,
    getPolicyState: getPolicyState,
    getSettings: getSettings,
    patchSettings: patchSettings,
    getPlaylists: getPlaylists,
    putPlaylist: putPlaylist,
    replacePlaylistIndex: replacePlaylistIndex,
    removePlaylist: removePlaylist,
    appendBlockLog: appendBlockLog,
    clearBlockLog: clearBlockLog,
    getChecklist: getChecklist,
    setChecklist: setChecklist,
    toggleChecklistItem: toggleChecklistItem
  };

  root.YTLStorage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
