'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// linkPreview.js requires electron's `session`; stub it for the pure parser.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { session: {} };
  return origLoad.call(this, request, ...rest);
};
const { parseHtml } = require('../src/main/linkPreview');
Module._load = origLoad;

test('parseHtml reads og tags, falls back to <title>, resolves relative images', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="HarboR &quot;Live&quot;">
    <meta content="x" name="description">
    <meta property="og:image" content="/img/ogp.png"></head></html>`;
  const r = parseHtml(html, 'https://harbor-live.com/news/1');
  assert.equal(r.title, 'HarboR "Live"');
  assert.equal(r.image, 'https://harbor-live.com/img/ogp.png');
  const r2 = parseHtml('<title>Only &#12354;title</title>', 'https://a.com/');
  assert.equal(r2.title, 'Only あtitle');
  assert.equal(r2.image, null);
});
