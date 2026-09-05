#!/usr/bin/env node
/**
 * Regenerates test/fixtures/playlist-page-lockup.html — the current
 * (2025-era) shape of a YouTube playlist page, confirmed against a real fetch
 * of a live playlist (see scripts/debug-playlist.js / inspect-lockup.js).
 *
 * Each item is a lockupViewModel carrying the video id as contentId, plus
 * several nested command objects (watchEndpoint, addToPlaylistCommand,
 * offlineVideoEndpoint) that repeat the *same* id under a plain "videoId"
 * field — real playlist pages have 3-4x as many raw "videoId" substring hits
 * as actual videos. The parser must pull exactly one id per item from
 * contentId, not get confused by (or duplicate from) those nested copies.
 */
const fs = require('fs');
const path = require('path');

const videoIds = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'dddddddddd4', 'eeeeeeeeee5'];
const titles = [
  'Vectors, what even are they?',
  'Tricky title with a brace }; and a </script> inside',
  'Another with "escaped quotes" in it',
  'Linear combinations, span, and basis vectors',
  'Backslash at the end \\',
];

function commandsFor(videoId) {
  // Trimmed-down but structurally faithful copy of what a real lockupViewModel
  // carries: the same id repeated under watchEndpoint, addToPlaylistCommand,
  // and offlineVideoEndpoint, none of which the parser should read from.
  return {
    onTap: {
      innertubeCommand: {
        watchEndpoint: { videoId, playlistId: 'PLtest', index: 0 },
      },
    },
    overlays: [
      {
        thumbnailHoverOverlayToggleActionsViewModel: {
          buttons: [
            {
              toggleButtonViewModel: {
                defaultButtonViewModel: {
                  buttonViewModel: {
                    onTap: {
                      innertubeCommand: {
                        signalServiceEndpoint: {
                          actions: [{ addToPlaylistCommand: { videoId, listType: 'QUEUE' } }],
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      },
      {
        thumbnailBottomOverlayViewModel: {
          badges: [{ thumbnailBadgeViewModel: { text: '9:52' } }],
        },
      },
    ],
    downloadCommand: { offlineVideoEndpoint: { videoId } },
  };
}

const items = videoIds.map((videoId, i) => ({
  lockupViewModel: {
    contentId: videoId,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { title: { content: titles[i] } } },
    rendererContext: commandsFor(videoId),
  },
}));

items.push({
  continuationItemRenderer: {
    trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
    continuationEndpoint: {
      continuationCommand: { token: 'CONTINUATION_TOKEN_PAGE_2', request: 'CONTINUATION_REQUEST_TYPE_BROWSE' },
    },
  },
});

const ytInitialData = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: items } }] } }],
              },
            },
          },
        },
      ],
    },
  },
  metadata: {
    playlistMetadataRenderer: { title: 'Essence of linear algebra', description: 'A test playlist.' },
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

const out = path.join(__dirname, 'playlist-page-lockup.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes, ${videoIds.length} videos)`);
