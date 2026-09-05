#!/usr/bin/env node
/**
 * Smoke test the indexer against real YouTube, outside the browser.
 *
 *   node scripts/index-playlist.js PLxxxxxxxx
 *
 * Prints the playlist title and every video ID it managed to page through.
 * Run this against a playlist with more than 100 videos to confirm continuation
 * paging still works — that is the part built on an undocumented endpoint.
 */
const indexer = require('../src/lib/playlist-index.js');
const policy = require('../src/lib/policy.js');

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: node scripts/index-playlist.js <playlist URL or ID>');
    process.exit(2);
  }

  const listId = policy.extractListId(raw);
  if (!listId) {
    console.error(`Could not find a playlist ID in: ${raw}`);
    process.exit(2);
  }
  if (!policy.isWhitelistableListId(listId)) {
    console.error(`"${listId}" is a mix or a personal pseudo-playlist and cannot be indexed.`);
    process.exit(2);
  }

  const started = Date.now();
  const result = await indexer.fetchPlaylist(listId, {
    // Mimic a browser: bare fetch gets a stripped-down page without ytInitialData.
    fetch: (url, init = {}) =>
      fetch(url, {
        ...init,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
            'Chrome/126.0.0.0 Safari/537.36',
          ...(init.headers || {}),
        },
      }),
  });

  console.log(`title:      ${result.title}`);
  console.log(`videos:     ${result.videoIds.length}`);
  console.log(`pages:      ${result.pages}`);
  console.log(`truncated:  ${result.truncated}`);
  console.log(`elapsed:    ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log('---');
  console.log(result.videoIds.join('\n'));
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
