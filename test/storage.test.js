const test = require('node:test');
const assert = require('node:assert');

/** Minimal in-memory stand-in for chrome.storage.local. */
function installFakeChrome(initial = {}) {
  let data = JSON.parse(JSON.stringify(initial));
  globalThis.chrome = {
    storage: {
      local: {
        get(keys) {
          if (keys === null || keys === undefined) return Promise.resolve(JSON.parse(JSON.stringify(data)));
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) {
            if (key in data) out[key] = JSON.parse(JSON.stringify(data[key]));
          }
          return Promise.resolve(out);
        },
        set(patch) {
          data = { ...data, ...JSON.parse(JSON.stringify(patch)) };
          return Promise.resolve();
        },
      },
    },
  };
  return () => data;
}

// storage.js reads chrome.* lazily, so requiring it before the fake exists is fine.
const storage = require('../src/lib/storage.js');

test('defaults fill in for settings that were never written', async () => {
  installFakeChrome({ settings: { blockShorts: false } });
  const settings = await storage.getSettings();
  assert.equal(settings.blockShorts, false, 'stored values win');
  assert.equal(settings.blankHomeFeed, true, 'unset values fall back to the default');
  assert.equal(settings.refreshIntervalHours, 12);
});

test('replacePlaylistIndex adds every video in the playlist', async () => {
  const read = installFakeChrome();
  const count = await storage.replacePlaylistIndex('PLa', ['vid00000001', 'vid00000002']);
  assert.equal(count, 2);
  assert.deepEqual(read().index, {
    vid00000001: ['PLa'],
    vid00000002: ['PLa'],
  });
});

test('re-indexing drops videos that left the playlist', async () => {
  const read = installFakeChrome({ index: { gone0000001: ['PLa'], stays000001: ['PLa'] } });
  await storage.replacePlaylistIndex('PLa', ['stays000001', 'added000001']);
  assert.deepEqual(Object.keys(read().index).sort(), ['added000001', 'stays000001']);
});

test('a video in two playlists survives one of them being re-indexed', async () => {
  // The bug this guards against: pruning PLa's entries wiping a video that PLb
  // also vouches for, silently blocking it.
  const read = installFakeChrome({ index: { shared00001: ['PLa', 'PLb'] } });
  await storage.replacePlaylistIndex('PLa', []);
  assert.deepEqual(read().index.shared00001, ['PLb']);
});

test('re-indexing does not duplicate an existing membership', async () => {
  const read = installFakeChrome({ index: { vid00000001: ['PLa'] } });
  await storage.replacePlaylistIndex('PLa', ['vid00000001']);
  assert.deepEqual(read().index.vid00000001, ['PLa']);
});

test('removing a playlist takes its index entries with it', async () => {
  const read = installFakeChrome({
    playlists: { PLa: { title: 'A' }, PLb: { title: 'B' } },
    index: { onlyA000001: ['PLa'], shared00001: ['PLa', 'PLb'] },
  });
  await storage.removePlaylist('PLa');
  assert.deepEqual(Object.keys(read().playlists), ['PLb']);
  assert.equal(read().index.onlyA000001, undefined);
  assert.deepEqual(read().index.shared00001, ['PLb']);
});

test('putPlaylist merges rather than replacing', async () => {
  const read = installFakeChrome({ playlists: { PLa: { title: 'A', videoCount: 3 } } });
  await storage.putPlaylist('PLa', { lastError: 'boom' });
  assert.deepEqual(read().playlists.PLa, { title: 'A', videoCount: 3, lastError: 'boom' });
});

test('the block log is newest first and capped', async () => {
  const read = installFakeChrome();
  for (let i = 0; i < storage.BLOCK_LOG_MAX + 10; i++) {
    await storage.appendBlockLog({ at: i, videoId: `vid${String(i).padStart(8, '0')}`, reason: 'not-whitelisted' });
  }
  const log = read().blockLog;
  assert.equal(log.length, storage.BLOCK_LOG_MAX);
  assert.equal(log[0].at, storage.BLOCK_LOG_MAX + 9, 'newest entry is first');
});

test('reloading a blocked page updates the log entry instead of flooding it', async () => {
  const read = installFakeChrome();
  await storage.appendBlockLog({ at: 1, videoId: 'vid00000001', reason: 'not-whitelisted' });
  await storage.appendBlockLog({ at: 2, videoId: 'vid00000001', reason: 'not-whitelisted' });
  await storage.appendBlockLog({ at: 3, videoId: 'vid00000002', reason: 'not-whitelisted' });

  const log = read().blockLog;
  assert.equal(log.length, 2);
  assert.equal(log[0].videoId, 'vid00000002');
  assert.equal(log[1].at, 2, 'the repeated entry was refreshed, not duplicated');
});
