const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const indexer = require('../src/lib/playlist-index.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const PAGE_HTML = fixture('playlist-page.html');
const CONTINUATION = JSON.parse(fixture('continuation-response.json'));

const PAGE_ONE = ['aaaaaaaaaa1', 'bbbbbbbbbb2', 'cccccccccc3', 'dddddddddd4', 'eeeeeeeeee5'];

test('sliceJsonObject balances braces instead of trusting a regex', () => {
  // The fixture's video titles contain "};" and "</script>", which is exactly
  // what breaks the naive /ytInitialData = (.+?);/ approach.
  const text = 'var x = {"a":"a brace }; and a </script> inside","b":{"c":1}}; more';
  const sliced = indexer.sliceJsonObject(text, 0);
  assert.deepEqual(JSON.parse(sliced), { a: 'a brace }; and a </script> inside', b: { c: 1 } });
});

test('sliceJsonObject respects escaped quotes and trailing backslashes', () => {
  const text = '= {"a":"say \\"hi\\"","b":"ends with a backslash \\\\"}';
  assert.deepEqual(JSON.parse(indexer.sliceJsonObject(text, 0)), {
    a: 'say "hi"',
    b: 'ends with a backslash \\',
  });
});

test('sliceJsonObject returns null when the object never closes', () => {
  assert.equal(indexer.sliceJsonObject('var x = {"a": 1', 0), null);
  assert.equal(indexer.sliceJsonObject('no object here', 0), null);
});

test('extractYtInitialData finds the blob in a real-shaped page', () => {
  const data = indexer.extractYtInitialData(PAGE_HTML);
  assert.ok(data, 'expected ytInitialData to parse');
  assert.equal(data.metadata.playlistMetadataRenderer.title, 'Essence of linear algebra');
});

test('extractYtInitialData returns null rather than throwing on junk', () => {
  assert.equal(indexer.extractYtInitialData('<html><body>nope</body></html>'), null);
  assert.equal(indexer.extractYtInitialData('var ytInitialData = {broken'), null);
});

test('collectFromResponse finds videos, the title, and the continuation token', () => {
  const got = indexer.collectFromResponse(indexer.extractYtInitialData(PAGE_HTML));
  assert.deepEqual(got.videoIds, PAGE_ONE);
  assert.equal(got.title, 'Essence of linear algebra');
  assert.equal(got.continuation, 'CONTINUATION_TOKEN_PAGE_2');
});

test('collectFromResponse preserves playlist order', () => {
  // A course playlist is a sequence; a stack-based walk reverses it if the
  // children are not pushed back-to-front.
  const got = indexer.collectFromResponse(indexer.extractYtInitialData(PAGE_HTML));
  assert.deepEqual(got.videoIds, PAGE_ONE, 'videos must come back in playlist order');
});

test('collectFromResponse handles the continuation response shape', () => {
  const got = indexer.collectFromResponse(CONTINUATION);
  assert.deepEqual(got.videoIds, ['ffffffffff6', 'gggggggggg7', 'aaaaaaaaaa1']);
  assert.equal(got.continuation, null, 'the last page has no token');
});

test('collectFromResponse understands the legacy continuation shape', () => {
  const got = indexer.collectFromResponse({
    contents: [{ nextContinuationData: { continuation: 'LEGACY_TOKEN' } }],
  });
  assert.equal(got.continuation, 'LEGACY_TOKEN');
});

test('extractInnertubeConfig reads the key and client version', () => {
  const config = indexer.extractInnertubeConfig(PAGE_HTML);
  assert.equal(config.apiKey, 'AIzaSyTESTKEY_not_a_real_key_000000000');
  assert.equal(config.clientVersion, '2.20260901.00.00');
  assert.deepEqual(indexer.extractInnertubeConfig('<html></html>'), {
    apiKey: null,
    clientVersion: null,
  });
});

test('extractHtmlTitle strips the YouTube suffix', () => {
  assert.equal(indexer.extractHtmlTitle(PAGE_HTML), 'Essence of linear algebra');
  assert.equal(indexer.extractHtmlTitle('<html></html>'), null);
});

// --- fetchPlaylist ------------------------------------------------------

/** A fetch stand-in: first call serves the page, later calls serve continuations. */
function stubFetch({ page = PAGE_HTML, pages = [CONTINUATION], status = 200 } = {}) {
  const calls = [];
  let continuationIndex = 0;

  const impl = (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });

    if (url.includes('/playlist')) {
      return Promise.resolve({
        ok: status === 200,
        status,
        text: () => Promise.resolve(page),
      });
    }

    const next = pages[continuationIndex++];
    if (next === undefined) return Promise.resolve({ ok: false, status: 500 });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(next) });
  };

  impl.calls = calls;
  return impl;
}

const run = (fetchImpl, options = {}) =>
  indexer.fetchPlaylist('PLcourse', { fetch: fetchImpl, pageDelayMs: 0, ...options });

test('fetchPlaylist pages through continuations and dedupes', async () => {
  const fetchImpl = stubFetch();
  const result = await run(fetchImpl);

  assert.equal(result.title, 'Essence of linear algebra');
  assert.deepEqual(result.videoIds, [...PAGE_ONE, 'ffffffffff6', 'gggggggggg7']);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].method, 'POST');

  const body = JSON.parse(fetchImpl.calls[1].body);
  assert.equal(body.continuation, 'CONTINUATION_TOKEN_PAGE_2');
  assert.equal(body.context.client.clientVersion, '2.20260901.00.00');
});

test('fetchPlaylist reports an HTTP failure in words a user can act on', async () => {
  await assert.rejects(run(stubFetch({ status: 403 })), /HTTP 403/);
});

test('fetchPlaylist explains an unreadable page rather than returning nothing', async () => {
  await assert.rejects(
    run(stubFetch({ page: '<html><body>consent wall</body></html>' })),
    /consent or sign-in/
  );
});

test('fetchPlaylist explains an empty or private playlist', async () => {
  const empty = '<html><body><script>var ytInitialData = {"contents":{}};</script></body></html>';
  await assert.rejects(run(stubFetch({ page: empty })), /private\/deleted\/empty/);
});

test('a continuation that leads nowhere still ends in the same clear error', async () => {
  // The bug this guards against: page one has no videos but does carry a
  // continuation token (e.g. a consent/interstitial page's own internal
  // token), page two also turns up nothing, and the old code accepted that
  // silently — an "added" playlist whose index is actually empty, which
  // hard-blocks every video in it with no visible error anywhere.
  const emptyWithContinuation = {
    onResponseReceivedActions: [
      { appendContinuationItemsAction: { continuationItems: [] } },
    ],
  };
  const page = PAGE_HTML.replace(
    /"playlistVideoRenderer":\{"videoId":"[a-z0-9]+"/g,
    '"someOtherRenderer":{"videoId":"unused0001"'
  );
  await assert.rejects(
    run(stubFetch({ page, pages: [emptyWithContinuation] })),
    /No videos found after reading 2 page/
  );
});

test('a continuation failure yields partial data flagged as truncated', async () => {
  // Losing page two must not lose page one — a partial index still beats
  // blocking a playlist the user legitimately whitelisted.
  const result = await run(stubFetch({ pages: [new Error('network down')] }));
  assert.deepEqual(result.videoIds, PAGE_ONE);
  assert.equal(result.truncated, true);
});

test('a missing InnerTube config truncates instead of silently stopping', async () => {
  const page = PAGE_HTML.replace(/"INNERTUBE_API_KEY":"[^"]+"/, '"INNERTUBE_API_KEY_X":"gone"');
  const result = await run(stubFetch({ page }));
  assert.deepEqual(result.videoIds, PAGE_ONE);
  assert.equal(result.truncated, true);
});

test('fetchPlaylist stops at the page cap and says so', async () => {
  // Distinct tokens each time, so nothing but maxPages can stop the paging.
  const endless = (n) => ({
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { playlistVideoRenderer: { videoId: `hhhhhhhhh${n}${n}` } },
            {
              continuationItemRenderer: {
                continuationEndpoint: { continuationCommand: { token: `TOKEN_${n}` } },
              },
            },
          ],
        },
      },
    ],
  });

  const result = await run(stubFetch({ pages: [1, 2, 3, 4, 5].map(endless) }), { maxPages: 3 });
  assert.equal(result.truncated, true, 'hitting the cap must be reported, not hidden');
  assert.equal(result.pages, 3);
});

test('a repeated continuation token terminates instead of looping forever', async () => {
  const sameToken = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            { playlistVideoRenderer: { videoId: 'hhhhhhhhhh8' } },
            {
              continuationItemRenderer: {
                continuationEndpoint: { continuationCommand: { token: 'CONTINUATION_TOKEN_PAGE_2' } },
              },
            },
          ],
        },
      },
    ],
  };
  const result = await run(stubFetch({ pages: [sameToken, sameToken, sameToken] }));
  assert.deepEqual(result.videoIds, [...PAGE_ONE, 'hhhhhhhhhh8']);
  assert.equal(result.truncated, true, 'a token we cannot advance past means a partial index');
});
