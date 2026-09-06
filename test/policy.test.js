const test = require('node:test');
const assert = require('node:assert');
const policy = require('../src/lib/policy.js');

const WHITELISTED = { PLcourse: { title: 'A course' } };
const INDEX = { aaaaaaaaaa1: ['PLcourse'], bbbbbbbbbb2: ['PLcourse', 'PLother'] };
const SETTINGS = { blockShorts: true };

const decide = (url, overrides = {}) =>
  policy.decide({
    url,
    index: INDEX,
    playlists: WHITELISTED,
    settings: SETTINGS,
    ...overrides,
  });

test('parseLocation classifies YouTube URLs', () => {
  assert.equal(policy.parseLocation('https://www.youtube.com/watch?v=aaaaaaaaaa1').kind, 'watch');
  assert.equal(policy.parseLocation('https://www.youtube.com/shorts/aaaaaaaaaa1').kind, 'shorts');
  assert.equal(policy.parseLocation('https://www.youtube.com/live/aaaaaaaaaa1').kind, 'watch');
  assert.equal(policy.parseLocation('https://www.youtube.com/embed/aaaaaaaaaa1').kind, 'watch');
  assert.equal(policy.parseLocation('https://www.youtube.com/').kind, 'other');
  assert.equal(policy.parseLocation('https://www.youtube.com/results?search_query=x').kind, 'other');
  assert.equal(policy.parseLocation('https://www.youtube.com/playlist?list=PLcourse').kind, 'other');
  assert.equal(policy.parseLocation('https://www.youtube.com/feed/subscriptions').kind, 'subscriptions');
  assert.equal(policy.parseLocation('https://www.youtube.com/feed/subscriptions/').kind, 'subscriptions');
  // A sub-path under it is a different page entirely, not the feed itself.
  assert.equal(policy.parseLocation('https://www.youtube.com/feed/trending').kind, 'other');
});

test('parseLocation pulls out ids, and rejects malformed ones', () => {
  const watch = policy.parseLocation('https://www.youtube.com/watch?v=aaaaaaaaaa1&list=PLcourse');
  assert.equal(watch.videoId, 'aaaaaaaaaa1');
  assert.equal(watch.listId, 'PLcourse');

  assert.equal(policy.parseLocation('https://www.youtube.com/shorts/aaaaaaaaaa1/').videoId, 'aaaaaaaaaa1');

  // Video ids are always exactly 11 characters.
  const junk = policy.parseLocation('https://www.youtube.com/watch?v=short');
  assert.equal(junk.videoId, null);
  assert.equal(junk.videoIdRaw, 'short');
});

test('parseLocation survives garbage input', () => {
  for (const input of ['', 'not a url', null, undefined, 'javascript:void(0)']) {
    assert.doesNotThrow(() => policy.parseLocation(input));
  }
});

test('isWhitelistableListId rejects mixes and personal pseudo-playlists', () => {
  assert.ok(policy.isWhitelistableListId('PLcourse'));
  assert.ok(policy.isWhitelistableListId('UUabcdef'));

  for (const id of ['RDabc', 'RDPLcourse', 'RDCLAK5uy_k', 'WL', 'LL', '', null, undefined]) {
    assert.ok(!policy.isWhitelistableListId(id), `${id} should not be whitelistable`);
  }
});

test('non-player pages are never touched', () => {
  const result = decide('https://www.youtube.com/feed/subscriptions');
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'not-a-video-page');
});

test('a video inside a whitelisted playlist plays', () => {
  const result = decide('https://www.youtube.com/watch?v=zzzzzzzzzz9&list=PLcourse');
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'playlist-context');
});

test('a video inside an unknown playlist is blocked', () => {
  const result = decide('https://www.youtube.com/watch?v=zzzzzzzzzz9&list=PLstranger');
  assert.equal(result.action, 'block');
  assert.equal(result.reason, 'not-whitelisted');
});

test('an indexed video plays when opened on its own', () => {
  // This is the whole point of maintaining an index: no list= in the URL.
  const result = decide('https://www.youtube.com/watch?v=aaaaaaaaaa1');
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'indexed');
});

test('an unknown video is blocked', () => {
  const result = decide('https://www.youtube.com/watch?v=zzzzzzzzzz9');
  assert.equal(result.action, 'block');
  assert.equal(result.reason, 'not-whitelisted');
});

test('an index entry with no remaining playlists does not count as allowed', () => {
  const result = decide('https://www.youtube.com/watch?v=cccccccccc3', {
    index: { cccccccccc3: [] },
  });
  assert.equal(result.action, 'block');
});

test('a mix is not playlist context even if its id is somehow whitelisted', () => {
  // Guards against a mix id sneaking into storage: RD… is a live recommendation
  // stream, which is exactly what this extension exists to shut off.
  const result = decide('https://www.youtube.com/watch?v=zzzzzzzzzz9&list=RDPLcourse', {
    playlists: { ...WHITELISTED, RDPLcourse: { title: 'Mix' } },
  });
  assert.equal(result.action, 'block');
});

test('shorts are blocked wholesale when the setting is on', () => {
  const result = decide('https://www.youtube.com/shorts/aaaaaaaaaa1');
  assert.equal(result.action, 'block');
  assert.equal(result.reason, 'shorts');
});

test('with shorts blocking off, shorts fall back to the normal whitelist', () => {
  const settings = { blockShorts: false };
  assert.equal(decide('https://www.youtube.com/shorts/aaaaaaaaaa1', { settings }).action, 'allow');
  assert.equal(decide('https://www.youtube.com/shorts/zzzzzzzzzz9', { settings }).action, 'block');
});

test('the subscriptions feed is untouched by default', () => {
  const result = decide('https://www.youtube.com/feed/subscriptions');
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'not-a-video-page');
});

test('the subscriptions feed blocks wholesale when the setting is on', () => {
  const settings = { blockShorts: true, blockSubscriptions: true };
  const result = decide('https://www.youtube.com/feed/subscriptions', { settings });
  assert.equal(result.action, 'block');
  assert.equal(result.reason, 'subscriptions');
});

test('subscriptions blocking has no bearing on shorts blocking or vice versa', () => {
  const subsOnly = { blockShorts: false, blockSubscriptions: true };
  assert.equal(decide('https://www.youtube.com/shorts/aaaaaaaaaa1', { settings: subsOnly }).action, 'allow');
  assert.equal(decide('https://www.youtube.com/feed/subscriptions', { settings: subsOnly }).action, 'block');
});

test('a bare /watch is a redirect in flight, not a video', () => {
  const result = decide('https://www.youtube.com/watch');
  assert.equal(result.action, 'allow');
  assert.equal(result.reason, 'no-video-id');
});

test('a malformed video id fails closed', () => {
  // A v= param that cannot be a real id still means someone tried to open a
  // player, so it must not slip through the no-video-id escape hatch.
  assert.equal(decide('https://www.youtube.com/watch?v=nope').action, 'block');
});

test('playing a playlist with no video id honours the whitelist', () => {
  assert.equal(decide('https://www.youtube.com/watch?list=PLcourse').action, 'allow');
  assert.equal(decide('https://www.youtube.com/watch?list=PLstranger').action, 'block');
});

test('missing state blocks rather than opening the gates', () => {
  const result = policy.decide({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaa1' });
  assert.equal(result.action, 'block');
});

test('extractListId accepts URLs and bare ids', () => {
  assert.equal(policy.extractListId('PLcourse'), 'PLcourse');
  assert.equal(
    policy.extractListId('https://www.youtube.com/playlist?list=PLcourse'),
    'PLcourse'
  );
  assert.equal(
    policy.extractListId('https://www.youtube.com/watch?v=aaaaaaaaaa1&list=PLcourse&index=2'),
    'PLcourse'
  );
  assert.equal(policy.extractListId('  PLcourse  '), 'PLcourse');
  assert.equal(policy.extractListId('https://www.youtube.com/watch?v=aaaaaaaaaa1'), null);
  assert.equal(policy.extractListId(''), null);
  assert.equal(policy.extractListId(null), null);
});
