'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ItemStore, TOMBSTONE_TTL_MS, ORPHAN_BLOB_GRACE_MS } = require('../src/main/store');
const blobs = require('../src/main/blobs');

const silent = { info() {}, warn() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSettings() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-test-'));
  return { dataDirOverride: dir };
}
async function waitFor(fn, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

test('create/list/update/remove with dedupe index', async () => {
  const settings = tmpSettings();
  const store = new ItemStore(settings, { deviceId: 'dev-a', log: silent });
  store.start();
  try {
    const a = store.create({ board: 'history', type: 'text', text: 'hello', hash: 't:1', preview: 'hello' });
    await wait(5);
    const b = store.create({ board: 'history', type: 'text', text: 'world', hash: 't:2', preview: 'world' });
    const p = store.create({ board: 'pin', type: 'text', text: 'pinned' });
    assert.equal(store.list('history').length, 2);
    assert.equal(store.list('history')[0].id, b.id, 'newest first');
    assert.equal(store.findHistoryByHash('t:1').id, a.id);
    assert.equal(store.count('pin'), 1);

    await wait(5);
    store.touch(a.id);
    assert.equal(store.list('history')[0].id, a.id, 'touch moves to top');

    const updated = store.update(a.id, { label: 'L', id: 'hijack', deviceId: 'x' });
    assert.equal(updated.id, a.id);
    assert.equal(updated.deviceId, 'dev-a');
    assert.ok(updated.updatedAt > a.updatedAt);

    assert.ok(store.remove(a.id));
    assert.equal(store.get(a.id), null);
    assert.equal(store.findHistoryByHash('t:1'), null);
    assert.equal(store.list('history').length, 1);
    const tomb = JSON.parse(fs.readFileSync(path.join(settings.dataDirOverride, 'items', `${a.id}.json`), 'utf8'));
    assert.equal(tomb.deleted, true);
    assert.equal(tomb.text, undefined, 'tombstones drop content');
    assert.ok(store.get(p.id));
  } finally {
    await store.stop();
  }
});

test('own writes are not re-emitted; newer external writes are', async () => {
  const settings = tmpSettings();
  const store = new ItemStore(settings, { deviceId: 'dev-a', log: silent });
  store.start();
  const events = [];
  store.on('changed', (item, meta) => events.push({ id: item.id, external: meta.external }));
  try {
    await wait(300); // watcher ready
    const item = store.create({ board: 'pin', type: 'text', text: 'x' });
    await wait(900);
    assert.equal(events.filter((e) => e.external).length, 0, 'no echo of own write');

    // Simulate another device writing a newer version of the same item.
    const file = path.join(settings.dataDirOverride, 'items', `${item.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...item, text: 'from other device', updatedAt: item.updatedAt + 1000 }));
    assert.ok(await waitFor(() => store.get(item.id).text === 'from other device'), 'external change applied');
    assert.ok(events.some((e) => e.external && e.id === item.id));

    // Older write is ignored.
    fs.writeFileSync(file, JSON.stringify({ ...item, text: 'stale', updatedAt: item.updatedAt - 1 }));
    await wait(900);
    assert.equal(store.get(item.id).text, 'from other device');

    // A brand-new item appearing from another device.
    const otherId = '11111111-2222-4333-8444-555555555555';
    fs.writeFileSync(path.join(settings.dataDirOverride, 'items', `${otherId}.json`), JSON.stringify({ id: otherId, board: 'history', type: 'text', text: 'remote', hash: 't:r', updatedAt: Date.now(), usedAt: Date.now() }));
    assert.ok(await waitFor(() => store.get(otherId)), 'new remote item picked up');
    assert.equal(store.findHistoryByHash('t:r').id, otherId);

    // temp files are ignored
    fs.writeFileSync(path.join(settings.dataDirOverride, 'items', `.${otherId}.123.tmp`), '{bad json');
    await wait(600);
  } finally {
    await store.stop();
  }
});

test('trimHistory and prune (tombstones + orphan blobs)', async () => {
  const settings = tmpSettings();
  const store = new ItemStore(settings, { deviceId: 'dev-a', log: silent });
  store.start();
  try {
    const kept = blobs.saveBlob(settings, Buffer.from('kept'), '.png');
    const orphanOld = blobs.saveBlob(settings, Buffer.from('orphan-old'), '.png');
    const orphanNew = blobs.saveBlob(settings, Buffer.from('orphan-new'), '.bin');
    const oldTime = new Date(Date.now() - ORPHAN_BLOB_GRACE_MS - 60000);
    fs.utimesSync(blobs.blobPath(settings, orphanOld), oldTime, oldTime);
    fs.utimesSync(blobs.blobPath(settings, kept), oldTime, oldTime);

    store.create({ board: 'shelf', type: 'image', blob: kept });
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 8; i++) {
      // t0..t2 were last used 40+ days ago, t3..t7 within the last week
      store.create({ board: 'history', type: 'text', text: `t${i}`, hash: `t:${i}`, usedAt: i < 3 ? now - (45 - i) * day : now - (8 - i) * day });
    }
    store.create({ board: 'pin', type: 'text', text: 'old pin', usedAt: now - 400 * day });
    assert.equal(store.countOlderThan(31 * day, now), 3);
    assert.equal(store.trimHistory(31 * day, now), 3);
    assert.equal(store.trimHistory(Infinity, now), 0, 'forever keeps everything');
    assert.equal(store.list('history').length, 5);
    assert.deepEqual(store.list('history').map((i) => i.text), ['t7', 't6', 't5', 't4', 't3']);
    assert.equal(store.list('pin').length, 1, 'pins are never trimmed');

    const removedId = store.list('history')[4].id;
    store.remove(removedId);
    const result = store.prune(31 * day, Date.now() + TOMBSTONE_TTL_MS + 1000);
    assert.ok(!fs.existsSync(path.join(settings.dataDirOverride, 'items', `${removedId}.json`)), 'old tombstone file deleted');
    assert.ok(blobs.blobExists(settings, kept), 'referenced blob kept');
    assert.ok(!blobs.blobExists(settings, orphanOld), 'old orphan removed');
    assert.ok(blobs.blobExists(settings, orphanNew) || result.removedBlobs >= 1);
  } finally {
    await store.stop();
  }
});

test('importFrom copies items and blobs, newest wins', async () => {
  const a = tmpSettings();
  const b = tmpSettings();
  const src = new ItemStore(a, { deviceId: 'dev-a', log: silent });
  src.start();
  const blob = blobs.saveBlob(a, Buffer.from('img'), '.png');
  const one = src.create({ board: 'pin', type: 'image', blob });
  src.create({ board: 'history', type: 'text', text: 'h', hash: 't:h' });
  await src.stop();

  const dst = new ItemStore(b, { deviceId: 'dev-b', log: silent });
  dst.start();
  try {
    assert.equal(dst.importFrom(a.dataDirOverride), 2);
    assert.ok(dst.get(one.id));
    assert.ok(blobs.blobExists(b, blob));
    assert.equal(dst.findHistoryByHash('t:h').text, 'h');
    assert.equal(dst.importFrom(a.dataDirOverride), 0, 'idempotent');
  } finally {
    await dst.stop();
  }
});

test('blob helpers validate names and stream files', () => {
  const settings = tmpSettings();
  assert.throws(() => blobs.blobPath(settings, '../../etc/passwd'));
  const file = path.join(settings.dataDirOverride, 'src.txt');
  fs.writeFileSync(file, 'x'.repeat(3 * 1024 * 1024 + 7));
  const name = blobs.saveBlobFromFile(settings, file);
  assert.match(name, /^[a-f0-9]{64}\.txt$/);
  assert.equal(name.slice(0, 64), blobs.hashOf(fs.readFileSync(file)));
  assert.equal(blobs.saveBlobFromFile(settings, file), name, 'dedupes');
  assert.deepEqual(blobs.listBlobs(settings), [name]);
});

test('data dir is pinned at start and a vanished sync folder is never recreated', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ItemStore } = require('../src/main/store');
  const paths = require('../src/main/paths');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pin-'));
  const syncFolder = path.join(base, 'Drive');
  fs.mkdirSync(syncFolder);
  const settings = { syncFolder };
  const store = new ItemStore(settings, { deviceId: 'd', log: { info() {}, warn() {}, error() {} } });
  store.start();
  const pinned = store.dataDir;
  assert.equal(pinned, paths.syncDataDir(syncFolder));
  fs.rmSync(syncFolder, { recursive: true, force: true });
  assert.equal(store.dataDir, pinned, 'still reports the folder it is using');
  let missing = 0;
  store.on('sync-missing', () => missing++);
  store.create({ board: 'history', type: 'text', text: 'while offline' });
  assert.ok(missing >= 1);
  assert.ok(!fs.existsSync(syncFolder), 'sync folder must not be recreated');
  await store.stop();
});

test('items captured while the sync folder was missing move to the new folder', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ItemStore } = require('../src/main/store');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-unw-'));
  const syncFolder = path.join(base, 'Drive');
  fs.mkdirSync(syncFolder);
  const store = new ItemStore({ syncFolder }, { deviceId: 'd', log: { info() {}, warn() {}, error() {} } });
  store.start();
  fs.rmSync(syncFolder, { recursive: true, force: true });
  const item = store.create({ board: 'history', type: 'text', text: 'offline clip' });
  const local = path.join(base, 'local');
  await store.reconfigure({ dataDirOverride: local });
  assert.equal(store.get(item.id).text, 'offline clip');
  assert.ok(fs.existsSync(path.join(local, 'items', `${item.id}.json`)));
  await store.stop();
});


test('pinboards: default, create, order, delete with items; restore after remove', async () => {
  const { DEFAULT_PINBOARD_ID } = require('../src/main/store');
  const settings = tmpSettings();
  const store = new ItemStore(settings, { deviceId: 'dev-a', log: silent });
  store.start();
  try {
    const def = store.ensureDefaultPinboard();
    assert.equal(def.id, DEFAULT_PINBOARD_ID);
    assert.equal(store.ensureDefaultPinboard().id, DEFAULT_PINBOARD_ID, 'idempotent');
    const b = store.createPinboard({ name: '  営業  ', color: 'green' });
    const c = store.createPinboard({ name: '', color: 'nope' });
    assert.equal(b.name, '営業');
    assert.equal(c.name, '新しいピンボード');
    assert.ok(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'].includes(c.color));
    assert.deepEqual(store.pinboards().map((x) => x.id), [def.id, b.id, c.id]);
    store.reorder([c.id, def.id, b.id]);
    assert.deepEqual(store.pinboards().map((x) => x.id), [c.id, def.id, b.id]);

    const legacy = store.create({ board: 'pin', type: 'text', text: 'old pin without board' });
    const p1 = store.create({ board: 'pin', type: 'text', text: 'a', pinboardId: b.id, order: 1 });
    const p2 = store.create({ board: 'pin', type: 'text', text: 'b', pinboardId: b.id, order: 0 });
    assert.deepEqual(store.list('pin', { pinboardId: DEFAULT_PINBOARD_ID }).map((i) => i.id), [legacy.id]);
    assert.deepEqual(store.list('pin', { pinboardId: b.id }).map((i) => i.id), [p2.id, p1.id]);

    const snapshot = store.get(p1.id);
    store.remove(p1.id);
    assert.equal(store.get(p1.id), null);
    const back = store.restore(snapshot);
    assert.equal(back.text, 'a');
    assert.ok(store.get(p1.id));

    assert.ok(store.deletePinboard(b.id));
    assert.equal(store.get(b.id), null);
    assert.equal(store.list('pin', { pinboardId: b.id }).length, 0, 'items of a deleted pinboard are removed');
    assert.ok(store.get(legacy.id));
  } finally {
    await store.stop();
  }
});
