'use strict';
const { session } = require('electron');
const blobs = require('./blobs');
const { isSafeForLinkPreview } = require('../shared/text');

const MAX_HTML = 1024 * 1024;
const MAX_IMAGE = 3 * 1024 * 1024;
const TIMEOUT_MS = 6000;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .trim();
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = re.exec(html);
  if (!tag) return null;
  const c = /content=["']([^"']*)["']/i.exec(tag[0]);
  return c ? decodeEntities(c[1]) : null;
}

function parseHtml(html, base) {
  const title = metaContent(html, 'og:title') || decodeEntities((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '');
  let image = metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
  if (image) {
    try {
      image = new URL(image, base).href;
    } catch {
      image = null;
    }
  }
  return { title: title ? title.slice(0, 200) : null, image };
}

async function fetchLimited(ses, url, max) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await ses.fetch(url, {
      signal: ctrl.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,image/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (link preview; HarboR ClipShelf)' }
    });
    if (!res.ok || !res.body) return null;
    if (res.url && res.url !== url && !isSafeForLinkPreview(res.url)) return null; // redirected somewhere private
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        ctrl.abort();
        return null; // never keep a truncated file
      }
      chunks.push(Buffer.from(value));
    }
    return { type: res.headers.get('content-type') || '', body: Buffer.concat(chunks), url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches title + preview image for link items ("リンクプレビューを生成"). */
class LinkPreviews {
  constructor({ store, getSettings, log }) {
    this.store = store;
    this.getSettings = getSettings;
    this.log = log;
    this.busy = new Set();
    this.ses = null;
  }

  _session() {
    if (!this.ses) this.ses = session.fromPartition('clipshelf-link-preview', { cache: false });
    return this.ses;
  }

  maybeFetch(item) {
    if (!item || item.type !== 'url' || item.linkChecked || item.deleted) return;
    if (!this.getSettings().linkPreviews || this.busy.has(item.id)) return;
    let url = String(item.text || '').trim();
    if (/^www\./i.test(url)) url = `https://${url}`;
    if (!isSafeForLinkPreview(url)) {
      this.store.update(item.id, { linkChecked: true });
      return;
    }
    this.busy.add(item.id);
    this._fetch(url)
      .then((info) => {
        if (this.store.get(item.id)) this.store.update(item.id, { linkChecked: true, linkTitle: info.title, linkImage: info.image });
      })
      .catch((err) => {
        this.log.info('[link-preview]', err && err.message);
        if (this.store.get(item.id)) this.store.update(item.id, { linkChecked: true });
      })
      .finally(() => this.busy.delete(item.id));
  }

  async _fetch(url) {
    const page = await fetchLimited(this._session(), url, MAX_HTML);
    if (!page) return { title: null, image: null };
    if (/^image\//.test(page.type)) {
      return { title: null, image: blobs.saveBlob(this.store.settings, page.body, extOf(page.type)) };
    }
    if (!/html/.test(page.type)) return { title: null, image: null };
    const meta = parseHtml(page.body.toString('utf8'), page.url);
    let image = null;
    if (meta.image && /^https:/.test(meta.image) && isSafeForLinkPreview(meta.image)) {
      const img = await fetchLimited(this._session(), meta.image, MAX_IMAGE).catch(() => null);
      if (img && /^image\//.test(img.type) && img.body.length) image = blobs.saveBlob(this.store.settings, img.body, extOf(img.type));
    }
    return { title: meta.title, image };
  }
}

function extOf(type) {
  const m = /image\/(png|jpe?g|gif|webp)/.exec(type || '');
  return m ? `.${m[1] === 'jpeg' ? 'jpg' : m[1]}` : '.img';
}

module.exports = { LinkPreviews, parseHtml };
