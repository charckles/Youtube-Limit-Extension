#!/usr/bin/env node
/**
 * Regenerates test/fixtures/playlist-page.html.
 *
 * Mirrors the real shape of a YouTube playlist page: ytInitialData buried under
 * twoColumnBrowseResultsRenderer -> tabs -> sectionList -> itemSection ->
 * playlistVideoListRenderer, a ytcfg.set() block carrying the InnerTube config,
 * and a continuationItemRenderer as the last entry.
 *
 * Two video titles are deliberately hostile to naive parsing: one closes a brace
 * and a script tag, one contains the literal renderer name and escaped quotes.
 * A regex-based extractor fails on these; the brace-matching slicer must not.
 */
const fs = require('fs');
const path = require('path');

const videoIds = [
  'aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'dddddddddd4', 'eeeeeeeeee5',
];

const titles = [
  'Vectors, what even are they?',
  'Tricky title with a brace }; and a </script> inside',
  'Another with "escaped quotes" and the word playlistVideoRenderer in it',
  'Linear combinations, span, and basis vectors',
  'Backslash at the end \\',
];

const items = videoIds.map((videoId, i) => ({
  playlistVideoRenderer: {
    videoId,
    title: { runs: [{ text: titles[i] }] },
    index: { simpleText: String(i + 1) },
  },
}));

items.push({
  continuationItemRenderer: {
    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
    continuationEndpoint: {
      continuationCommand: {
        token: 'CONTINUATION_TOKEN_PAGE_2',
        request: 'CONTINUATION_REQUEST_TYPE_BROWSE',
      },
    },
  },
});

const ytInitialData = {
  responseContext: { visitorData: 'Cgt0ZXN0' },
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [{ playlistVideoListRenderer: { contents: items } }],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
  metadata: {
    playlistMetadataRenderer: {
      title: 'Essence of linear algebra',
      description: 'A test playlist.',
    },
  },
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<title>Essence of linear algebra - YouTube</title>
<script nonce="abc123">
  (function() {
    window.ytcfg = window.ytcfg || {};
    ytcfg.set({"INNERTUBE_API_KEY":"AIzaSyTESTKEY_not_a_real_key_000000000","INNERTUBE_CLIENT_NAME":"WEB","INNERTUBE_CLIENT_VERSION":"2.20260901.00.00","LOGGED_IN":false});
  })();
</script>
</head>
<body>
<script nonce="abc123">var ytInitialData = ${JSON.stringify(ytInitialData)};</script>
<div id="content"></div>
</body>
</html>
`;

const out = path.join(__dirname, 'playlist-page.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes, ${videoIds.length} videos)`);
