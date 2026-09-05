#!/usr/bin/env node
/**
 * Prints the shape of the first lockupViewModel found in a saved playlist
 * page, so we can see the real field name for the video id (likely
 * "contentId", replacing the old playlistVideoRenderer.videoId).
 *
 *   node scripts/inspect-lockup.js [path/to/saved-page.html]
 *
 * Long strings (image URLs, base64, tracking params) are truncated so the
 * output is compact and safe to paste — this is your playlist's own public
 * metadata (titles, video ids, thumbnail hosts), nothing account-specific.
 */
const fs = require('fs');
const path = require('path');
const indexer = require('../src/lib/playlist-index.js');

const file = process.argv[2] || path.join(__dirname, '..', 'debug-playlist-page.html');
const html = fs.readFileSync(file, 'utf8');
const data = indexer.extractYtInitialData(html);

let first = null;
(function walk(node) {
  if (first || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) walk(item); return; }
  if (node.lockupViewModel) { first = node.lockupViewModel; return; }
  for (const key of Object.keys(node)) walk(node[key]);
})(data);

if (!first) {
  console.error('No lockupViewModel found in ' + file);
  process.exit(1);
}

function truncate(value) {
  if (typeof value === 'string' && value.length > 120) return value.slice(0, 120) + '…';
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = truncate(value[key]);
    return out;
  }
  return value;
}

console.log('top-level keys on lockupViewModel:', Object.keys(first));
console.log('---');
console.log(JSON.stringify(truncate(first), null, 2));
