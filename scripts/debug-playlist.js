#!/usr/bin/env node
/**
 * Diagnoses a playlist fetch that returns zero videos.
 *
 *   node scripts/debug-playlist.js <playlist URL or ID>
 *
 * Doesn't try to be clever about parsing — it reports raw signals so we can
 * tell apart the usual causes: a consent/interstitial page (no cookies), a
 * sign-in wall, a redirect, or an actual schema change in YouTube's markup.
 * Safe to paste the output here: it's counts and booleans, not page content.
 */
const policy = require('../src/lib/policy.js');
const indexer = require('../src/lib/playlist-index.js');

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: node scripts/debug-playlist.js <playlist URL or ID>');
    process.exit(2);
  }
  const listId = policy.extractListId(raw) || raw;
  const url = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(listId) + '&hl=en';

  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = await response.text();
  const data = indexer.extractYtInitialData(html);
  const config = indexer.extractInnertubeConfig(html);
  const collected = data ? indexer.collectFromResponse(data) : null;

  console.log('requested URL:        ', url);
  console.log('final URL (redirects):', response.url);
  console.log('http status:          ', response.status);
  console.log('html length:          ', html.length);
  console.log('has ytInitialData:    ', Boolean(data));
  console.log('has INNERTUBE_API_KEY:', Boolean(config.apiKey));
  console.log('<title>:              ', indexer.extractHtmlTitle(html));
  console.log('---');

  if (collected) {
    console.log('videoIds found on page 1:', collected.videoIds.length);
    console.log('continuation token:      ', Boolean(collected.continuation));
    console.log('playlistMetadataRenderer title:', collected.title);
  }

  // Independent of JSON parsing entirely: raw substring counts. If these are
  // also zero, YouTube genuinely isn't sending video data to this request
  // (consent/sign-in/region gate). If these are nonzero but collected.videoIds
  // is zero, the JSON parsed fine but the renderer key name has changed and
  // the extension's code needs updating.
  const rendererHits = (html.match(/playlistVideoRenderer/g) || []).length;
  const videoIdHits = (html.match(/"videoId"/g) || []).length;
  console.log('---');
  console.log('raw "playlistVideoRenderer" occurrences in HTML:', rendererHits);
  console.log('raw "videoId" occurrences in HTML:               ', videoIdHits);

  const signals = [
    ['consent.youtube.com', html.includes('consent.youtube.com')],
    ['"SOCS"', html.includes('"SOCS"')],
    ['action="https://consent.youtube.com', html.includes('action="https://consent.youtube.com')],
    ['ServiceLogin (sign-in wall)', html.includes('ServiceLogin')],
    ['recaptcha', /recaptcha/i.test(html)],
    ['"isPrivate":true', html.includes('"isPrivate":true')],
  ];
  console.log('---');
  console.log('known-cause signals present in the page:');
  for (const [label, present] of signals) console.log('  ' + (present ? '[x] ' : '[ ] ') + label);

  // Save the raw HTML locally (never printed) in case a closer look is needed.
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, '..', 'debug-playlist-page.html');
  fs.writeFileSync(out, html);
  console.log('---');
  console.log('full page saved to:', out, '(not printed — may contain long tokens)');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
