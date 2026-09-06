/**
 * Options page. Every mutation goes through the service worker so that indexing
 * keeps running if this tab is closed mid-scrape.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function send(message) {
    return chrome.runtime.sendMessage(message).then(function (response) {
      if (!response || !response.ok) throw new Error((response && response.error) || 'Unknown error');
      return response.result;
    });
  }

  function relativeTime(timestamp) {
    if (!timestamp) return 'never';
    var seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function setStatus(element, text, isError) {
    element.textContent = text;
    element.classList.toggle('error', Boolean(isError));
    element.hidden = !text;
  }

  // --- rendering --------------------------------------------------------

  function renderPlaylists(playlists) {
    var ids = Object.keys(playlists);
    var rows = $('playlist-rows');
    rows.textContent = '';

    $('playlist-table').hidden = ids.length === 0;
    $('playlist-empty').hidden = ids.length > 0;

    ids.sort(function (a, b) {
      return (playlists[a].title || a).localeCompare(playlists[b].title || b);
    });

    ids.forEach(function (listId) {
      var meta = playlists[listId];
      var tr = document.createElement('tr');

      var nameCell = document.createElement('td');
      var name = document.createElement('span');
      name.textContent = meta.title || listId;
      nameCell.appendChild(name);

      var idLabel = document.createElement('span');
      idLabel.className = 'list-id';
      idLabel.textContent = listId;
      nameCell.appendChild(idLabel);

      if (meta.lastError) {
        var error = document.createElement('span');
        error.className = 'warn';
        error.textContent = meta.lastError;
        nameCell.appendChild(error);
      } else if (meta.truncated) {
        var warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = 'Only partly indexed — videos past this point still block ' +
          'unless you open them from the playlist itself.';
        nameCell.appendChild(warn);
      }
      tr.appendChild(nameCell);

      var countCell = document.createElement('td');
      countCell.className = 'num';
      countCell.textContent = meta.videoCount === undefined ? '—' : String(meta.videoCount);
      tr.appendChild(countCell);

      var whenCell = document.createElement('td');
      whenCell.textContent = relativeTime(meta.lastIndexedAt);
      tr.appendChild(whenCell);

      var actionCell = document.createElement('td');
      actionCell.className = 'actions';

      var refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'link';
      refresh.textContent = 'Re-index';
      refresh.addEventListener('click', function () {
        refresh.disabled = true;
        refresh.textContent = 'Indexing…';
        send({ type: 'indexPlaylist', listId: listId })
          .catch(function () { /* the error is stored on the playlist */ })
          .then(load);
      });
      actionCell.appendChild(refresh);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        if (!confirm('Remove "' + (meta.title || listId) + '"? Its videos will be blocked again.')) return;
        send({ type: 'removePlaylist', listId: listId }).then(load);
      });
      actionCell.appendChild(remove);

      tr.appendChild(actionCell);
      rows.appendChild(tr);
    });
  }

  function renderSettings(settings) {
    $('blockShorts').checked = settings.blockShorts;
    $('blankHomeFeed').checked = settings.blankHomeFeed;
    $('hideRecommendations').checked = settings.hideRecommendations;
    $('refreshIntervalHours').value = String(settings.refreshIntervalHours);
    // Only overwrite the textarea if the user isn't actively typing in it —
    // otherwise a storage-change reload triggered by this very edit could
    // clobber a keystroke mid-sentence.
    if (document.activeElement !== $('home-message')) $('home-message').value = settings.homeMessage;
  }

  function makeChecklistId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function renderChecklist(items) {
    var list = $('checklist-rows');
    list.textContent = '';

    items.forEach(function (item) {
      var li = document.createElement('li');

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(item.done);
      checkbox.addEventListener('change', function () {
        YTLStorage.toggleChecklistItem(item.id).then(load);
      });

      var text = document.createElement('input');
      text.type = 'text';
      text.value = item.text;
      text.addEventListener('change', function () {
        YTLStorage.getChecklist().then(function (current) {
          var next = current.map(function (i) {
            return i.id === item.id ? Object.assign({}, i, { text: text.value }) : i;
          });
          return YTLStorage.setChecklist(next);
        });
      });

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        YTLStorage.getChecklist().then(function (current) {
          return YTLStorage.setChecklist(current.filter(function (i) { return i.id !== item.id; }));
        }).then(load);
      });

      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  function renderBlockLog(log) {
    var list = $('block-log');
    list.textContent = '';

    if (!log.length) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'Nothing blocked yet.';
      list.appendChild(empty);
      return;
    }

    log.forEach(function (entry) {
      var li = document.createElement('li');

      var what = document.createElement('div');
      what.className = 'what';
      what.textContent = entry.title || entry.videoId || 'Unknown video';
      li.appendChild(what);

      var when = document.createElement('div');
      when.className = 'when';
      when.textContent = relativeTime(entry.at) + ' · ' + YTLPolicy.describeReason(entry.reason) +
        (entry.videoId ? ' · ' + entry.videoId : '');
      li.appendChild(when);

      list.appendChild(li);
    });
  }

  function load() {
    return YTLStorage.getAll().then(function (state) {
      renderPlaylists(state.playlists);
      renderSettings(state.settings);
      renderChecklist(state.checklist);
      renderBlockLog(state.blockLog);
    });
  }

  // --- events -----------------------------------------------------------

  $('add-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var raw = $('add-input').value;
    var status = $('add-status');
    var listId = YTLPolicy.extractListId(raw);

    if (!listId) {
      setStatus(status, 'Could not find a playlist ID in that. Paste a link that contains "list=".', true);
      return;
    }
    if (!YTLPolicy.isWhitelistableListId(listId)) {
      setStatus(status,
        'Mixes (IDs starting RD), Watch Later and Liked videos are generated on the fly ' +
        'rather than being fixed sets of videos, so they cannot be whitelisted.', true);
      return;
    }

    $('add-button').disabled = true;
    setStatus(status, 'Indexing "' + listId + '" — long playlists take a few seconds…', false);

    send({ type: 'indexPlaylist', listId: listId }).then(function (result) {
      var meta = result.meta;
      setStatus(status,
        'Added "' + meta.title + '" — ' + meta.videoCount + ' videos indexed.' +
        (meta.truncated ? ' Indexing stopped early, so the tail of this playlist may still block.' : ''),
        false);
      $('add-input').value = '';
      return load();
    }).catch(function (err) {
      setStatus(status, err.message, true);
    }).then(function () {
      $('add-button').disabled = false;
    });
  });

  $('refresh-all').addEventListener('click', function () {
    var button = $('refresh-all');
    var status = $('refresh-status');
    button.disabled = true;
    status.textContent = 'Re-indexing…';
    send({ type: 'refreshAll' }).then(function (result) {
      status.textContent = 'Re-indexed ' + result.refreshed +
        (result.refreshed === 1 ? ' playlist.' : ' playlists.');
      return load();
    }).catch(function (err) {
      status.textContent = err.message;
    }).then(function () {
      button.disabled = false;
    });
  });

  ['blockShorts', 'blankHomeFeed', 'hideRecommendations'].forEach(function (key) {
    $(key).addEventListener('change', function () {
      var patch = {};
      patch[key] = $(key).checked;
      YTLStorage.patchSettings(patch);
    });
  });

  $('refreshIntervalHours').addEventListener('change', function () {
    send({ type: 'setRefreshInterval', hours: Number($('refreshIntervalHours').value) });
  });

  $('home-message').addEventListener('change', function () {
    YTLStorage.patchSettings({ homeMessage: $('home-message').value });
  });

  $('checklist-add-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var input = $('checklist-add-input');
    var text = input.value.trim();
    if (!text) return;
    YTLStorage.getChecklist().then(function (current) {
      return YTLStorage.setChecklist(current.concat({ id: makeChecklistId(), text: text, done: false }));
    }).then(function () {
      input.value = '';
      return load();
    });
  });

  $('clear-log').addEventListener('click', function () {
    YTLStorage.clearBlockLog().then(load);
  });

  load();
})();
