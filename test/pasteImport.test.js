'use strict';
// 「Paste から取り込む」: a synthetic Core Data store shaped like Paste's
// v5 model, with the pasteboard data archived in several encodings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bplistCreate = require('bplist-creator');
const imp = require('../src/main/pasteImport');

const UID = (n) => ({ UID: n });
const coreDate = (ms) => (ms - 978307200000) / 1000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function keyedArchive(pairs) {
  // NSArray of NSDictionary { type: NSString, data: NSData }
  const objects = ['$null'];
  const push = (o) => objects.push(o) - 1;
  const cls = push({ $classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject'] });
  const arrCls = push({ $classname: 'NSArray', $classes: ['NSArray', 'NSObject'] });
  const dicts = pairs.map(([type, data]) => {
    const kType = push('type');
    const kData = push('data');
    const vType = push(type);
    const vData = push(data);
    return push({ 'NS.keys': [UID(kType), UID(kData)], 'NS.objects': [UID(vType), UID(vData)], $class: UID(cls) });
  });
  const root = push({ 'NS.objects': dicts.map(UID), $class: UID(arrCls) });
  return bplistCreate({ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root: UID(root) }, $objects: objects });
}

function makeStore(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'Paste.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE ZITEMENTITY (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZRAWTYPE INTEGER, ZTITLE VARCHAR, ZRAWPREVIEW BLOB,
      ZTIMESTAMP TIMESTAMP, ZCREATEDAT TIMESTAMP, ZLIST INTEGER, ZSOURCEAPPLICATION INTEGER, ZDISPLAYORDERINPINBOARD INTEGER,
      ZIDENTIFIER VARCHAR, ZCHECKSUM VARCHAR);
    CREATE TABLE ZITEMDATAENTITY (Z_PK INTEGER PRIMARY KEY, ZITEM INTEGER, ZRAWPASTEBOARDITEMS BLOB, ZDATA BLOB);
    CREATE TABLE ZLISTENTITY (Z_PK INTEGER PRIMARY KEY, ZNAME VARCHAR, ZRAWATTRIBUTES BLOB, ZIDENTIFIER VARCHAR, ZINDEX INTEGER);
    CREATE TABLE ZAPPLICATIONENTITY (Z_PK INTEGER PRIMARY KEY, ZNAME VARCHAR, ZBUNDLEIDENTIFIER VARCHAR, ZRAWCOLOR BLOB);
  `);
  db.prepare('INSERT INTO ZAPPLICATIONENTITY VALUES (1, ?, ?, NULL)').run('Safari', 'com.apple.Safari');
  db.prepare('INSERT INTO ZLISTENTITY VALUES (1, NULL, ?, ?, 0)').run(bplistCreate({ kind: 'history' }), 'L-HIST');
  db.prepare('INSERT INTO ZLISTENTITY VALUES (2, ?, ?, ?, 1)').run('よく使う', bplistCreate({ kind: 'pinboard', color: 'green' }), 'L-PIN');
  const now = Date.now();
  const insItem = db.prepare('INSERT INTO ZITEMENTITY VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)');
  const insData = db.prepare('INSERT INTO ZITEMDATAENTITY VALUES (?, ?, ?, NULL)');

  // 1: Codable-style binary plist, plain text, history
  insItem.run(1, 0, null, null, coreDate(now - 3000), coreDate(now - 3000), 1, 1, null, 'I-1');
  insData.run(1, 1, bplistCreate([{ type: 'public.utf8-plain-text', data: Buffer.from('こんにちは Paste') }, { type: 'public.html', data: Buffer.from('<b>こんにちは</b>') }]));
  // 2: NSKeyedArchiver, a link, pinned
  insItem.run(2, 1, 'HarboR', null, coreDate(now - 2000), coreDate(now - 5000), 2, 1, 3, 'I-2');
  insData.run(2, 2, keyedArchive([['public.utf8-plain-text', Buffer.from('https://harbor-live.com')], ['public.url', Buffer.from('https://harbor-live.com')]]));
  // 3: JSON with base64 image, history
  insItem.run(3, 2, null, null, coreDate(now - 1000), coreDate(now - 1000), 1, null, null, 'I-3');
  insData.run(3, 3, Buffer.from(JSON.stringify([{ typeIdentifier: 'public.png', data: PNG.toString('base64') }])));
  // 4: external storage (0x02 + UUID) → a file URL, history
  const uuid = crypto.randomUUID().toUpperCase();
  const ext = path.join(dir, '.Paste_SUPPORT', '_EXTERNAL_DATA');
  fs.mkdirSync(ext, { recursive: true });
  const target = path.join(dir, 'report.pdf');
  fs.writeFileSync(target, 'pdf');
  fs.writeFileSync(path.join(ext, uuid), bplistCreate([{ type: 'public.file-url', data: Buffer.from(`file://${encodeURI(target)}`) }]));
  insItem.run(4, 3, null, null, coreDate(now - 500), coreDate(now - 500), 1, null, null, 'I-4');
  insData.run(4, 4, Buffer.concat([Buffer.from([2]), Buffer.from(uuid + '\u0000', 'latin1')]));
  // 5: nothing decodable, only a title → text from the title, pinned
  insItem.run(5, 0, 'メモのタイトル', null, coreDate(now - 100), coreDate(now - 100), 2, null, 1, 'I-5');
  // 6: very old history item
  insItem.run(6, 0, null, null, coreDate(now - 400 * 86400000), coreDate(now - 400 * 86400000), 1, null, null, 'I-6');
  insData.run(6, 6, bplistCreate([{ type: 'public.utf8-plain-text', data: Buffer.from('古い履歴') }]));
  db.close();
  return { file, target, now };
}

function fakeStore() {
  const items = [];
  const byHash = new Map();
  let n = 0;
  const api = {
    items,
    list: (board) => items.filter((i) => i.board === board),
    pinboards: () => items.filter((i) => i.board === 'meta' && i.type === 'pinboard'),
    createPinboard: ({ name, color }) => api.create({ board: 'meta', type: 'pinboard', name, color }),
    update: (id, patch) => Object.assign(items.find((i) => i.id === id), patch),
    findHistoryByHash: (h) => byHash.get(h) || null,
    quietCreates: 0,
    create: (partial, opts = {}) => {
      if (opts.quiet) api.quietCreates++;
      const item = { id: `id-${++n}`, ...partial };
      items.push(item);
      if (item.board === 'history' && item.hash) byHash.set(item.hash, item);
      return item;
    }
  };
  return api;
}

test('decodes archived pasteboards in several encodings', () => {
  const pairs = imp.collectPasteboard(imp.decodeBlob(keyedArchive([['public.utf8-plain-text', Buffer.from('abc')]])));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].type, 'public.utf8-plain-text');
  assert.equal(pairs[0].data.toString(), 'abc');
  const flat = imp.collectPasteboard({ 'public.utf8-plain-text': Buffer.from('x'), other: { 'public.rtf': Buffer.from('{\\rtf1}') } });
  assert.deepEqual(flat.map((p) => p.type).sort(), ['public.rtf', 'public.utf8-plain-text']);
  const pairList = imp.collectPasteboard(['public.utf8-plain-text', Buffer.from('y')]);
  assert.equal(pairList[0].data.toString(), 'y');
  assert.equal(imp.toMs(0), null);
  assert.equal(imp.toMs(coreDate(1700000000000)), 1700000000000);
});

test('reads a Paste-like store and imports history and pinboards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-'));
  const { file, target, now } = makeStore(dir);
  const found = imp.findStores({ roots: [dir] });
  assert.deepEqual(found.stores, [file]);

  const info = imp.inspectStore(file);
  assert.equal(info.total, 6);
  assert.equal(info.pinned, 2);

  const store = fakeStore();
  const saved = [];
  const opts = {
    store,
    saveBlob: (buf) => {
      saved.push(buf);
      return `blob-${saved.length}.png`;
    },
    statFile: (p) => (fs.existsSync(p) ? { name: path.basename(p), path: p, size: fs.statSync(p).size, isDir: false, blob: null } : null),
    since: now - 30 * 86400000,
    quiet: true
  };
  const { counts, report } = await imp.importStore(file, opts);
  assert.deepEqual(counts, { history: 3, pinned: 2, pinboards: 1, skipped: 1, duplicates: 0 });
  assert.equal(report.rows, 6);
  assert.equal(report.decoded, 5);
  assert.ok(report.typeNames['public.png'] >= 1);
  assert.ok(!JSON.stringify(report).includes('こんにちは'), 'report has no clipboard content');
  const history = store.list('history');
  const text = history.find((i) => i.type === 'text');
  assert.equal(text.text, 'こんにちは Paste');
  assert.equal(text.html, '<b>こんにちは</b>');
  assert.equal(text.sourceApp, 'Safari');
  assert.ok(Math.abs(text.usedAt - (now - 3000)) < 5);
  assert.equal(history.find((i) => i.type === 'image').blob, 'blob-1.png');
  assert.ok(saved[0].equals(PNG));
  assert.equal(history.find((i) => i.type === 'file').files[0].path, target);
  const board = store.pinboards()[0];
  assert.equal(board.name, 'よく使う');
  assert.equal(board.color, 'green');
  const pins = store.list('pin');
  assert.equal(pins.find((i) => i.type === 'url').text, 'https://harbor-live.com');
  assert.equal(pins.find((i) => i.type === 'url').label, null);
  assert.equal(pins.find((i) => i.text === 'メモのタイトル').pinboardId, board.id);
  assert.ok(store.quietCreates > 0, 'bulk import does not announce every item');

  // importing again adds nothing
  const again = await imp.importStore(file, { ...opts, saveBlob: () => 'b.png', statFile: () => null });
  assert.equal(again.counts.history + again.counts.pinned + again.counts.pinboards, 0);
  assert.equal(again.counts.duplicates, 5);
  assert.equal(store.pinboards().length, 1);
  // a longer period brings in the older one too
  const older = await imp.importStore(file, { ...opts, since: 0 });
  assert.equal(older.counts.history, 1);
  // temp copies are cleaned up
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith('clipshelf-paste-') && fs.existsSync(path.join(os.tmpdir(), n, 'store.sqlite'))));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an item with several data rows keeps all of its content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-import-'));
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'p.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ZITEMENTITY (Z_PK INTEGER PRIMARY KEY, ZTIMESTAMP TIMESTAMP, ZIDENTIFIER VARCHAR);
    CREATE TABLE ZITEMDATAENTITY (Z_PK INTEGER PRIMARY KEY, ZITEM INTEGER, ZRAWPASTEBOARDITEMS BLOB);
    CREATE TABLE ZLISTENTITY (Z_PK INTEGER PRIMARY KEY, ZNAME VARCHAR, ZRAWATTRIBUTES BLOB);`);
  db.prepare('INSERT INTO ZITEMENTITY VALUES (1, ?, ?)').run(coreDate(Date.now()), 'multi');
  db.prepare('INSERT INTO ZITEMDATAENTITY VALUES (1, 1, ?)').run(bplistCreate([{ type: 'public.rtf', data: Buffer.from('{\\rtf1 x}') }]));
  db.prepare('INSERT INTO ZITEMDATAENTITY VALUES (2, 1, ?)').run(bplistCreate([{ type: 'public.utf8-plain-text', data: Buffer.from('本文') }]));
  // a huge integer in the list attributes (BigInt in bplist) must not break reading
  db.prepare('INSERT INTO ZLISTENTITY VALUES (1, ?, ?)').run('大きな数', bplistCreate({ big: 2 ** 60 }));
  db.close();
  const store = fakeStore();
  const { counts } = await imp.importStore(file, { store, saveBlob: () => 'x', statFile: () => null, since: 0 });
  assert.equal(counts.history, 1);
  const item = store.list('history')[0];
  assert.equal(item.text, '本文');
  assert.ok(item.rtf.includes('rtf1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a store that cannot be copied leaves no temp files behind', () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('clipshelf-paste-')).length;
  assert.throws(() => imp.inspectStore(path.join(os.tmpdir(), 'nope', 'missing.sqlite')));
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('clipshelf-paste-')).length;
  assert.equal(after, before);
});

test('permission problems are reported, missing folders are not', () => {
  const r = imp.findStores({ roots: [path.join(os.tmpdir(), 'no-such-paste-dir', 'x')] });
  assert.deepEqual(r, { stores: [], denied: false });
});
