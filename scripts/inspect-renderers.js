#!/usr/bin/env node
/**
 * Finds the actual renderer key YouTube is using to wrap playlist video items
 * in a saved playlist page, when it's no longer "playlistVideoRenderer".
 *
 *   node scripts/inspect-renderers.js [path/to/saved-page.html]
 *   (defaults to ./debug-playlist-page.html, which debug-playlist.js writes)
 *
 * Walks the parsed ytInitialData and, for every object that has a "videoId"
 * field, records the key name of its *parent* — that parent key is the
 * renderer name collectFromResponse() needs to recognize. Only counts and key
 * names are printed, plus a couple of sample video ids/titles (public
 * playlist metadata) to sanity-check we found the right thing.
 */
const fs = require('fs');
const path = require('path');
const indexer = require('../src/lib/playlist-index.js');

const file = process.argv[2] || path.join(__dirname, '..', 'debug-playlist-page.html');
if (!fs.existsSync(file)) {
  console.error('File not found: ' + file);
  console.error('Run scripts/debug-playlist.js first, or pass a path to a saved page.');
  process.exit(2);
}

const html = fs.readFileSync(file, 'utf8');
const data = indexer.extractYtInitialData(html);
if (!data) {
  console.error('Could not extract ytInitialData from ' + file);
  process.exit(1);
}

const parentKeyCounts = new Map();   // parent key name -> count of objects with videoId under it
const rendererKeyCounts = new Map(); // any key ending in Renderer/ViewModel -> count
const samples = [];                  // a few {parentKey, videoId, title} for sanity-checking

function titleOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.title && node.title.simpleText) return node.title.simpleText;
  if (node.title && Array.isArray(node.title.runs) && node.title.runs[0]) {
    return node.title.runs[0].text;
  }
  if (node.accessibilityText) return node.accessibilityText;
  return null;
}

function walk(node, parentKey) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, parentKey);
    return;
  }

  if (typeof node.videoId === 'string' && parentKey) {
    parentKeyCounts.set(parentKey, (parentKeyCounts.get(parentKey) || 0) + 1);
    if (samples.length < 5) {
      samples.push({ parentKey, videoId: node.videoId, title: titleOf(node) });
    }
  }

  for (const key of Object.keys(node)) {
    if (/Renderer$|ViewModel$/.test(key)) {
      rendererKeyCounts.set(key, (rendererKeyCounts.get(key) || 0) + 1);
    }
    walk(node[key], key);
  }
}

walk(data, null);

function printSorted(map, label) {
  console.log(label + ':');
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) console.log('  (none found)');
  for (const [key, count] of rows.slice(0, 25)) console.log('  ' + String(count).padStart(4) + '  ' + key);
}

console.log('file:', file);
console.log('---');
printSorted(parentKeyCounts, 'Keys directly wrapping an object with "videoId" (this is what the parser needs)');
console.log('---');
printSorted(rendererKeyCounts, 'All *Renderer / *ViewModel keys found anywhere');
console.log('---');
console.log('sample matches:');
for (const s of samples) console.log('  ' + s.parentKey + '  ->  ' + s.videoId + '  ' + (s.title || ''));
