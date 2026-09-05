#!/usr/bin/env node
/**
 * Regenerates test/fixtures/continuation-response.json — the shape the InnerTube
 * /youtubei/v1/browse endpoint returns when a continuation token is redeemed.
 * The second page ends without a token, which is how paging terminates.
 */
const fs = require('fs');
const path = require('path');

const response = {
  responseContext: { visitorData: 'Cgt0ZXN0' },
  onResponseReceivedActions: [
    {
      appendContinuationItemsAction: {
        targetId: 'VL-playlist',
        continuationItems: [
          { playlistVideoRenderer: { videoId: 'ffffffffff6', title: { runs: [{ text: 'Page two, one' }] } } },
          { playlistVideoRenderer: { videoId: 'gggggggggg7', title: { runs: [{ text: 'Page two, two' }] } } },
          // A duplicate of a page-one video: playlists can repeat entries.
          { playlistVideoRenderer: { videoId: 'aaaaaaaaaa1', title: { runs: [{ text: 'Repeat' }] } } },
        ],
      },
    },
  ],
};

const out = path.join(__dirname, 'continuation-response.json');
fs.writeFileSync(out, JSON.stringify(response, null, 2) + '\n');
console.log(`wrote ${out}`);
