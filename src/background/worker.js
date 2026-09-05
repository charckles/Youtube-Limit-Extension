/**
 * Service worker: owns indexing, the refresh schedule, and every write to
 * storage that the options page or the content script asks for.
 *
 * Classic worker, not a module, so it can importScripts the same library files
 * the content script and options page load as plain <script> tags. That keeps
 * one copy of the policy in the extension and lets Node test it directly.
 */
importScripts('../lib/policy.js', '../lib/storage.js', '../lib/playlist-index.js');

var ALARM_REINDEX = 'ytl-reindex';

function scheduleReindex(hours) {
  var period = Math.max(1, Number(hours) || YTLStorage.DEFAULT_SETTINGS.refreshIntervalHours) * 60;
  chrome.alarms.create(ALARM_REINDEX, { periodInMinutes: period, delayInMinutes: period });
}

chrome.runtime.onInstalled.addListener(function () {
  YTLStorage.getSettings().then(function (settings) {
    return YTLStorage.patchSettings(settings).then(function () {
      scheduleReindex(settings.refreshIntervalHours);
    });
  });
});

chrome.runtime.onStartup.addListener(function () {
  YTLStorage.getSettings().then(function (settings) {
    scheduleReindex(settings.refreshIntervalHours);
  });
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_REINDEX) refreshAll();
});

/**
 * Index one playlist and fold the result into storage.
 *
 * On failure the previous index is left untouched. That matters more than it
 * looks: wiping an index because YouTube hiccuped would silently hard-block
 * every video the user had legitimately whitelisted.
 */
function indexPlaylist(listId) {
  if (!YTLPolicy.isWhitelistableListId(listId)) {
    return Promise.reject(new Error(
      'Mixes (RD…), Watch Later and Liked videos are not fixed sets of videos, ' +
      'so they cannot be whitelisted.'
    ));
  }

  return YTLPlaylistIndex.fetchPlaylist(listId).then(function (result) {
    return YTLStorage.replacePlaylistIndex(listId, result.videoIds).then(function () {
      return YTLStorage.putPlaylist(listId, {
        title: result.title,
        videoCount: result.videoIds.length,
        lastIndexedAt: Date.now(),
        truncated: result.truncated,
        lastError: null
      });
    }).then(function (meta) {
      return { listId: listId, meta: meta };
    });
  }).catch(function (err) {
    return YTLStorage.getPlaylists().then(function (playlists) {
      // Only record the error against playlists the user has actually added;
      // a failed first add shouldn't leave a ghost entry behind.
      if (!playlists[listId]) throw err;
      return YTLStorage.putPlaylist(listId, { lastError: err.message }).then(function () {
        throw err;
      });
    });
  });
}

function refreshAll() {
  return YTLStorage.getPlaylists().then(function (playlists) {
    var ids = Object.keys(playlists);
    // Sequential on purpose — a burst of parallel scrapes is exactly the shape
    // of traffic that gets rate limited.
    return ids.reduce(function (chain, listId) {
      return chain.then(function () {
        return indexPlaylist(listId).catch(function () { /* recorded on the playlist */ });
      });
    }, Promise.resolve()).then(function () {
      return ids.length;
    });
  });
}

var HANDLERS = {
  indexPlaylist: function (message) {
    return indexPlaylist(message.listId);
  },
  removePlaylist: function (message) {
    return YTLStorage.removePlaylist(message.listId).then(function () {
      return { removed: message.listId };
    });
  },
  refreshAll: function () {
    return refreshAll().then(function (count) { return { refreshed: count }; });
  },
  setRefreshInterval: function (message) {
    return YTLStorage.patchSettings({ refreshIntervalHours: message.hours }).then(function (settings) {
      scheduleReindex(settings.refreshIntervalHours);
      return settings;
    });
  },
  logBlock: function (message) {
    return YTLStorage.appendBlockLog(message.entry).then(function () { return { logged: true }; });
  },
  openOptions: function () {
    chrome.runtime.openOptionsPage();
    return Promise.resolve({ opened: true });
  }
};

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  var handler = message && HANDLERS[message.type];
  if (!handler) return false;

  Promise.resolve()
    .then(function () { return handler(message); })
    .then(function (result) { sendResponse({ ok: true, result: result }); })
    .catch(function (err) { sendResponse({ ok: false, error: err.message || String(err) }); });

  return true; // keep the message channel open for the async response
});

chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});
