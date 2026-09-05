# YouTube Limit

A Chromium extension that inverts YouTube's default: **nothing plays unless it
belongs to a playlist you have whitelisted.** Built for Brave, works in Chrome
and Edge.

No API key, no account, no server. Everything stays in the browser profile.

---

## How it decides

The awkward fact this design works around: **a watch page does not tell you what
playlists a video belongs to.** YouTube only reveals that when you are watching
*inside* one (`&list=PL…` in the URL). Open the same video from search or a
recommendation and there is no playlist signal at all — so a naive playlist
check would block your own approved content.

So the extension indexes the playlists itself. When you whitelist a playlist it
fetches `youtube.com/playlist?list=…`, scrapes every video ID out of the JSON
blob YouTube embeds in the page, follows continuation tokens to page past the
first ~100 videos, and stores a `videoId → playlist` map locally. Every watch
page after that is a fast local lookup, playlist context or not. A scheduled
re-index picks up new uploads to a course playlist.

The verdict, in order ([`src/lib/policy.js`](src/lib/policy.js)):

| # | Condition | Result |
|---|---|---|
| 1 | Not a player page | allow |
| 2 | A Short, and Shorts blocking is on | **block** |
| 3 | Opened inside a whitelisted playlist | allow |
| 4 | The video ID is in the local index | allow |
| 5 | Anything else | **block** |

Mixes (`RD…`), Watch Later (`WL`) and Liked (`LL`) can never be whitelisted:
they are generated on the fly rather than being fixed sets of videos, which
makes them precisely the thing this extension exists to shut off.

## Install

```
git clone https://github.com/charckles/Youtube-Limit-Extension
```

Then in Brave, open `brave://extensions`, turn on **Developer mode**, click
**Load unpacked**, and select the cloned folder. (Chrome and Edge: the same
flow at `chrome://extensions` / `edge://extensions`.)

Open the extension's options page and add a playlist — paste its URL or its ID.
Until you do, every video is blocked, which is the intended starting state.

## What it does besides blocking

All three are toggles on the options page:

- **Block Shorts entirely.** Shorts don't live in ordinary playlists, so there
  is nothing to whitelist them against.
- **Blank the home feed.** Replaces the recommendation grid on youtube.com with
  a one-line note.
- **Hide watch-page recommendations.** Removes the "up next" sidebar, endscreen
  cards, and the pause overlay.

Autoplay needs no special handling: the next video hits the same gate.

The options page also keeps a log of the last 50 things you bounced off. That
list is the intended route to unblocking something — you see what you keep
reaching for, and decide deliberately whether its playlist is worth adding.

## Development

No build step and no dependencies. The extension loads the source files
directly.

```
npm test                                  # 46 unit tests, node --test
node scripts/index-playlist.js <PL…>      # index a real playlist from the CLI
node scripts/make-icons.js                # regenerate icons/
npm run fixtures                          # regenerate test fixtures
```

`scripts/index-playlist.js` is the check that matters most when something
breaks. It runs the real fetch-and-page logic outside the browser and prints
what it found, so you can tell a YouTube-side change from an extension bug.
Run it against a playlist with more than 100 videos to confirm continuation
paging still works.

### Layout

```
manifest.json
src/lib/policy.js           pure decision logic — no I/O, no chrome.*, fully tested
src/lib/storage.js          chrome.storage schema and index bookkeeping
src/lib/playlist-index.js   playlist scraping and continuation paging
src/background/worker.js    indexing jobs, refresh alarm, message handling
src/content/guard.js        the gate: hide, decide, block
src/content/guard.css       pre-decision hiding and the declutter rules
src/options/                settings UI
```

Everything is a classic script that assigns to a global, so one copy of
`policy.js` serves the content script, the service worker (`importScripts`),
the options page, and the Node tests. That is why the service worker is not
declared `"type": "module"` — MV3 has no module content scripts, and one shared
copy beats a bundler.

### The timing problem, and how the guard handles it

A verdict needs `chrome.storage`, which is async, but a frame or a burst of
audio must never reach you first. So `guard.js` runs at `document_start` and
hides the page on its first statement, before it asks anything:

1. **Hide synchronously.** Set an attribute on `<html>` that a declaratively
   injected CSS rule turns into `body { display: none }`. Content-script CSS
   applies before any page script runs, so this lands before YouTube builds a
   player.
2. **Keep quiet.** A 100 ms loop pauses any `<video>` that appears. On a block
   verdict it also mutes it and clears its `src`, because pausing alone doesn't
   stop YouTube retrying `play()`.
3. **Answer.** Storage resolves in single-digit milliseconds: either drop the
   attribute, or mount the block screen — a closed shadow root attached to
   `<body>`, out of reach of YouTube's stylesheets.

If storage somehow doesn't answer within five seconds the guard **fails
closed** and shows the block screen with an explanation, rather than opening
the gates on a blocker that isn't working.

YouTube never reloads between videos, so the guard re-decides on
`yt-navigate-start`, `yt-navigate-finish`, `yt-page-data-updated`, patched
`history.pushState`/`replaceState`, `popstate`, and a one-second URL poll as a
backstop. None of those events are documented API, hence the belt and braces.

## Limitations

Worth knowing before you rely on it:

- **This is friction, not a lock.** You can disable the extension from
  `brave://extensions` in two clicks. It is built to make thoughtless watching
  cost a deliberate act, not to be tamper-proof. If you want something harder,
  pair it with an OS-level blocker or a separate browser profile.
- **Continuation paging rests on an undocumented endpoint** — the same internal
  API the YouTube site uses for itself. If it changes, indexing degrades to the
  first ~100 videos of a playlist and the options page says so on the affected
  playlist, rather than failing silently.
- **Indexing failures never wipe a good index.** A network hiccup would
  otherwise hard-block everything you had legitimately whitelisted.
- Watch Later and Liked videos can't be indexed this way.
- Private and unlisted playlists index only while you are signed in to the same
  browser profile.
- Embedded YouTube players on other sites aren't covered — the content script is
  scoped to youtube.com.
- Playlists are capped at 50 pages (~5000 videos) per index run.
