'use strict';
// End-to-end smoke test, run inside the real app:
//   CLIPSHELF_SMOKE=1 CLIPSHELF_USER_DATA=/tmp/x CLIPSHELF_SMOKE_OUT=/tmp/out \
//   CLIPSHELF_SMOKE_OCR_IMAGE=/path/sample.png xvfb-run -a electron . --no-sandbox
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clipboard, ClipboardItem, nativeImage, BrowserWindow, powerSaveBlocker } = require('electron');
const { pathToFileURL } = require('url');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function smoke(ctx) {
  const { app, store, watcher, ops, panel, shelf, stack, pasteService, settingsWindow, previewWindow, keepAwake, screenOcr, hud, log, setSettings, getSettings, updater, pause, monitor } = ctx;
  const out = process.env.CLIPSHELF_SMOKE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-smoke-'));
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    log.info(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const until = async (fn, timeout = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = await fn();
      if (v) return v;
      await wait(100);
    }
    return null;
  };
  const history = () => store.list('history');
  const byText = (t) => history().find((i) => i.text === t);
  const shot = async (win, name) => {
    if (!win || win.isDestroyed()) return;
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  };
  const exec = (win, code) => win.webContents.executeJavaScript(code);
  const inPanel = (code) => exec(panel.win, code);
  const key = async (win, keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(120);
  };

  try {
    await wait(1500);
    check('capture mode', true, watcher.mode);
    check('settings v4 defaults (passwords recorded, no Paste Stack key)', getSettings().version === 4 && getSettings().ignoreConfidential === false && getSettings().ignoredApps.length === 0 && getSettings().shortcuts.pasteStack === '');

    // --- clipboard capture: text
    await clipboard.writeText('スモークテスト テキスト');
    check('text captured', await until(() => byText('スモークテスト テキスト')));

    await clipboard.write([new ClipboardItem({ 'text/plain': 'rich one', 'text/html': '<b>rich one</b>' })]);
    const rich = await until(() => byText('rich one'));
    check('rich text captured with html', rich && rich.html && rich.html.includes('<b>'), rich && rich.html);

    await clipboard.writeText('スモークテスト テキスト');
    await wait(1800);
    const dupes = history().filter((i) => i.text === 'スモークテスト テキスト').length;
    check('same text is deduplicated', dupes === 1 && history()[0].text === 'スモークテスト テキスト', `count=${dupes}`);

    await clipboard.writeText('https://harbor-live.com/');
    const url = await until(() => byText('https://harbor-live.com/'));
    check('url classified', url && url.type === 'url');

    // --- password managers: recorded by default now
    const concealed = async (text) => clipboard.write([new ClipboardItem({
      'text/plain': text,
      'electron application/osclipboard;format="org.nspasteboard.ConcealedType"': ''
    })]);
    await concealed('secret-password-123');
    const secret = await until(() => byText('secret-password-123'), 5000);
    check('confidential copy is recorded (default)', secret && secret.confidential === true);
    setSettings({ ignoreConfidential: true });
    await concealed('secret-password-456');
    await wait(2000);
    check('confidential copy skipped when "ignore confidential" is on', !byText('secret-password-456'));
    setSettings({ ignoreConfidential: false });
    await clipboard.write([new ClipboardItem({ 'text/plain': 'transient-data', 'electron application/osclipboard;format="org.nspasteboard.TransientType"': '' })]);
    await wait(2000);
    check('transient copy is skipped', !byText('transient-data'));

    // --- pause (⌘T)
    pause.pause(60 * 1000);
    await clipboard.writeText('while-paused');
    await wait(1800);
    check('paused: copies are not recorded', !byText('while-paused') && getSettings().captureEnabled === false && getSettings().pausedUntil > Date.now());
    pause.resume();
    check('resumed', getSettings().captureEnabled === true && getSettings().pausedUntil === null);

    // --- image + OCR
    const ocrImage = process.env.CLIPSHELF_SMOKE_OCR_IMAGE;
    if (ocrImage && fs.existsSync(ocrImage)) {
      const png = fs.readFileSync(ocrImage);
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      const img = await until(() => history().find((i) => i.type === 'image'));
      check('image captured', img && img.blob, img && img.preview);
      const ocred = await until(() => {
        const cur = img && store.get(img.id);
        return cur && cur.ocrText ? cur : null;
      }, 60000);
      check('image OCR text', ocred && /ライブコマース/.test(ocred.ocrText), ocred && ocred.ocrText);
    }

    // --- files
    const tmpFile = path.join(out, 'sample file.txt');
    const tmpFile2 = path.join(out, 'second.txt');
    fs.writeFileSync(tmpFile, 'hello shelf');
    fs.writeFileSync(tmpFile2, 'second');
    await clipboard.write([new ClipboardItem({ 'text/uri-list': pathToFileURL(tmpFile).href })]);
    const fileItem = await until(() => history().find((i) => i.type === 'file'));
    check('file copy captured', fileItem && fileItem.files[0].path === tmpFile, fileItem && JSON.stringify(fileItem.files));

    // --- Paste-style panel
    await panel.show();
    await until(() => panel.win && panel.ready && panel.visible, 10000);
    await wait(900);
    const bounds = panel.win.getBounds();
    const area = require('electron').screen.getPrimaryDisplay().workArea;
    check('panel is a bar along the bottom edge', bounds.width > area.width - 40 && bounds.y + bounds.height >= area.y + area.height - 20, JSON.stringify(bounds));
    await shot(panel.win, '01-panel');
    const firstSel = await inPanel(`window.__panel.state.selected[0] === window.__panel.visibleItems()[0].id`);
    check('panel selects the newest item', firstSel);
    const cardCount = await inPanel(`document.querySelectorAll('.card[data-id]').length`);
    check('panel shows cards', cardCount === history().length, `cards=${cardCount} history=${history().length}`);
    await key(panel.win, 'Right');
    const moved = await inPanel(`window.__panel.state.selected[0] === window.__panel.visibleItems()[1].id`);
    check('→ moves the selection', moved);
    await key(panel.win, 'Right', ['shift']);
    const multi = await inPanel(`window.__panel.state.selected.length`);
    check('⇧→ extends the selection', multi === 2, `selected=${multi}`);
    await key(panel.win, 'h');
    for (const ch of 'arbor') await key(panel.win, ch);
    await wait(300);
    const filtered = await inPanel(`[document.getElementById('search').value, window.__panel.visibleItems().length]`);
    check('typing starts a search (text, links and text inside images)', filtered[0] === 'harbor' && filtered[1] === 2, JSON.stringify(filtered));
    await shot(panel.win, '02-panel-search');
    await key(panel.win, 'Escape');
    const cleared = await inPanel(`document.getElementById('search').value === '' && window.__panel.visibleItems().length > 1`);
    check('Esc clears the search first', cleared && panel.visible);
    await key(panel.win, 'Escape');
    await wait(300);
    check('Esc again closes the panel', !panel.visible);

    // paste (this OS has no direct paste → copies to the clipboard)
    const before = history().length;
    const r1 = await pasteService.paste([rich.id], { plain: true });
    await wait(400);
    const now = await clipboard.readText();
    const types1 = (await clipboard.read())[0].types;
    check('paste as plain text', r1.ok && now === 'rich one' && !types1.includes('text/html'), `${JSON.stringify(r1)} ${types1.join(',')}`);
    await wait(900);
    check('own paste is not re-captured, item moves to top', history().length === before && history()[0].id === rich.id);
    await pasteService.paste([rich.id]);
    await wait(300);
    check('paste keeps formatting', (await clipboard.read())[0].types.includes('text/html'));
    await pasteService.paste([url.id, secret.id]);
    await wait(300);
    check('multi-item paste joins with newlines', (await clipboard.readText()) === 'https://harbor-live.com/\nsecret-password-123', JSON.stringify(await clipboard.readText()));
    await pasteService.copy([fileItem.id]);
    await wait(300);
    check('file item copies as a file list', (await clipboard.read())[0].types.includes('text/uri-list'));

    // pinboards
    const def = store.pinboards();
    check('default pinboard exists', def.length === 1 && def[0].name === 'ピン留め');
    await panel.show();
    await until(() => panel.visible);
    await wait(500);
    const board = await inPanel(`window.clipshelf.createPinboard({ name: '営業テンプレ', color: 'green' })`);
    check('pinboard created', board && store.get(board.id).color === 'green');
    const pinned = await inPanel(`window.clipshelf.pinTo([${JSON.stringify(fileItem.id)}, ${JSON.stringify(url.id)}], ${JSON.stringify(board.id)})`);
    const pins = store.list('pin', { pinboardId: board.id });
    check('items pinned to the pinboard', pinned === 2 && pins.length === 2 && pins.some((p) => p.type === 'file' && p.files[0].blob), JSON.stringify(pins.map((p) => p.type)));
    const created = await inPanel(`window.clipshelf.createText({ text: '〒060-0063 札幌市中央区…', label: '会社住所', board: 'pin', pinboardId: ${JSON.stringify(board.id)} })`);
    check('new text item in pinboard', created && store.get(created.id).pinboardId === board.id);
    await inPanel(`window.clipshelf.updateItem(${JSON.stringify(created.id)}, { text: '更新後の住所' })`);
    check('item edited', store.get(created.id).text === '更新後の住所');
    const order = store.list('pin', { pinboardId: board.id }).map((i) => i.id).reverse();
    await inPanel(`window.clipshelf.reorderItems(${JSON.stringify(order)})`);
    check('pins reordered', JSON.stringify(store.list('pin', { pinboardId: board.id }).map((i) => i.id)) === JSON.stringify(order));
    await inPanel(`document.querySelector('.board[data-id="${board.id}"]').click()`);
    await wait(500);
    const pinCards = await inPanel(`document.querySelectorAll('.card[data-id]').length`);
    check('switching to the pinboard shows its items', pinCards === 3, `cards=${pinCards}`);
    await shot(panel.win, '03-panel-pinboard');
    await key(panel.win, 'Left', ['meta']);
    await key(panel.win, 'Left', process.platform === 'darwin' ? ['meta'] : ['control']);
    const back = await inPanel(`window.__panel.state.boardId`);
    check('pinboard navigation shortcut', back !== board.id, back);

    // an edit in progress survives live updates
    await inPanel(`document.querySelector('.board[data-id="${board.id}"]').click()`);
    await wait(300);
    panel.win.focus();
    await inPanel(`(() => { const id = ${JSON.stringify(created.id)}; const c = document.querySelector('.card[data-id="' + id + '"]'); c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
    await key(panel.win, 'E', [process.platform === 'darwin' ? 'meta' : 'control']);
    await wait(300);
    await inPanel(`(() => { const t = document.querySelector('.editor textarea'); t.value = '編集中のテキスト'; })()`);
    store.create({ board: 'history', type: 'text', text: 'arrives-while-editing', hash: 't:arrives', preview: 'x' });
    await wait(500);
    const kept = await inPanel(`document.querySelector('.editor textarea') && document.querySelector('.editor textarea').value`);
    check('edit in progress survives a live update', kept === '編集中のテキスト', String(kept));
    await key(panel.win, 'Escape');
    await wait(200);
    check('panel stays open while editing', panel.visible);

    // delete + undo
    const victim = byText('スモークテスト テキスト');
    await inPanel(`window.clipshelf.removeItems([${JSON.stringify(victim.id)}], 'panel')`);
    check('item deleted', !store.get(victim.id));
    await inPanel(`window.clipshelf.undoRemove()`);
    check('⌘Z restores the deleted item', store.get(victim.id) && store.get(victim.id).text === 'スモークテスト テキスト');

    // retention (Paste: keep history for a period)
    const old = store.create({ board: 'history', type: 'text', text: 'old one', hash: 't:old', preview: 'old one', usedAt: Date.now() - 40 * 86400000 });
    check('retention preview counts old items', (await inPanel(`window.clipshelf.retentionPreview('month')`)) >= 1);
    store.trimHistory(31 * 86400000);
    check('retention removes items older than the period', !store.get(old.id) && store.get(victim.id));

    // preview (Space)
    await inPanel(`window.clipshelf.previewItem(${JSON.stringify(rich.id)}, 'panel')`);
    const pv = await until(() => previewWindow.isOpen() && previewWindow.ready && previewWindow.win, 5000);
    await wait(500);
    check('preview window opens', !!pv);
    if (pv) await shot(previewWindow.win, '04-preview');
    check('panel stays open while previewing', panel.visible);
    previewWindow.close();
    await wait(300);
    panel.hide({ restoreFocus: false });
    await wait(300);

    // --- Paste Stack
    stack.open();
    await until(() => stack.win && stack.ready, 5000);
    await clipboard.writeText('stack-1');
    await until(() => stack.ids.length === 1, 4000);
    await clipboard.writeText('stack-2');
    await until(() => stack.ids.length === 2, 4000);
    const stackTexts = stack.state().items.map((i) => i.text);
    check('Paste Stack does not take over ⌘V/Ctrl+V when it cannot paste', stack.hooked === false && !require('electron').globalShortcut.isRegistered(process.platform === 'darwin' ? 'Command+V' : 'Control+V'));
    check('Paste Stack collects copies in order', JSON.stringify(stackTexts) === JSON.stringify(['stack-1', 'stack-2']), JSON.stringify(stackTexts));
    await wait(500);
    await shot(stack.win, '05-paste-stack');
    stack.remove([stack.ids[0]]);
    check('Paste Stack remove', stack.ids.length === 1);
    stack.close();
    check('Paste Stack closes', !stack.active && !stack.win.isVisible());

    // --- Yoink-style shelf
    const { screen } = require('electron');
    const realCursor = screen.getCursorScreenPoint.bind(screen);
    let fakeCursor = null;
    screen.getCursorScreenPoint = () => fakeCursor || realCursor();
    setSettings({ shelfCollapseWhenIdle: false });
    check('shelf hidden while empty', !shelf.isVisible());
    monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: false, pid: 999999 });
    await wait(400);
    check('shelf appears when a drag starts', shelf.isVisible());
    await wait(500);
    await shot(shelf.win, '06-shelf-empty-during-drag');
    monitor.emit('drag', { type: 'drag', active: false });
    await wait(900);
    check('shelf hides again after a drag without drop', !shelf.isVisible());
    monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: true, pid: 999999 });
    await wait(300);
    check('fn / Alt held: shelf does not appear', !shelf.isVisible());
    monitor.emit('drag', { type: 'drag', active: false });
    await wait(600);

    monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: false, pid: 999999 });
    await wait(300);
    const added = await exec(shelf.win, `window.clipshelf.addPathsToShelf([${JSON.stringify(tmpFile)}, ${JSON.stringify(tmpFile2)}])`);
    monitor.emit('drag', { type: 'drag', active: false });
    await wait(900);
    check('multiple files become one stack', added.length === 1 && added[0].files.length === 2 && !added[0].files[0].blob, JSON.stringify(added.map((a) => a.files.length)));
    check('shelf stays visible while it has items', shelf.isVisible());
    await wait(600);
    await shot(shelf.win, '07-shelf-stack');
    const stackId = added[0].id;
    check('reference mode drags the original files', JSON.stringify(ops.dragPaths([store.get(stackId)], { source: 'shelf' })) === JSON.stringify([tmpFile, tmpFile2]));
    const n = await exec(shelf.win, `window.clipshelf.splitStack(${JSON.stringify(stackId)})`);
    const tiles = store.list('shelf');
    check('split stack', n === 2 && tiles.length === 2 && tiles.every((t) => t.files.length === 1));
    await exec(shelf.win, `window.clipshelf.lockItems([${JSON.stringify(tiles[0].id)}], true)`);
    check('lock item', store.get(tiles[0].id).locked === true);
    const textItem = await exec(shelf.win, `window.clipshelf.addTextToShelf('棚に置いたメモ')`);
    const staged = ops.dragPaths([store.get(textItem.id)], { source: 'shelf' });
    check('text drags out as a snippet file', staged.length === 1 && fs.readFileSync(staged[0], 'utf8').includes('棚に置いたメモ'), staged[0]);
    const thumb = await exec(shelf.win, `window.clipshelf.thumbnail(${JSON.stringify(tiles[1].id)}, 160)`);
    check('file thumbnail', typeof thumb === 'string' && thumb.startsWith('data:image'), thumb ? thumb.slice(0, 30) : thumb);
    await exec(shelf.win, `window.clipshelf.removeItems([${JSON.stringify(tiles[1].id)}, ${JSON.stringify(textItem.id)}], 'shelf')`);
    check('removed from shelf', store.list('shelf').length === 1);
    const restored = await exec(shelf.win, `window.clipshelf.restoreShelf()`);
    check('restore recently removed', restored === 2 && store.list('shelf').length === 3, `restored=${restored}`);
    const wiped = await exec(shelf.win, `window.clipshelf.wipeShelf()`);
    check('wipe all keeps locked items', wiped === 2 && store.list('shelf').length === 1 && store.list('shelf')[0].locked);
    setSettings({ shelfFileMode: 'copy' });
    const copied = await exec(shelf.win, `window.clipshelf.addPathsToShelf([${JSON.stringify(tmpFile2)}])`);
    const copyPaths = ops.dragPaths([store.get(copied[0].id)], { source: 'shelf' });
    check('copy mode keeps a copy and drags a staged copy', copied[0].files[0].blob && copyPaths[0] !== tmpFile2 && fs.readFileSync(copyPaths[0], 'utf8') === 'second');
    setSettings({ shelfFileMode: 'reference' });
    await exec(shelf.win, `window.clipshelf.setShelfPosition('right-bottom')`);
    await wait(300);
    const sb = shelf.win.getBounds();
    check('shelf position (right, bottom)', sb.x + sb.width === area.x + area.width && sb.y + sb.height > area.y + area.height - 60, JSON.stringify(sb));
    await shot(shelf.win, '08-shelf-right-bottom');
    await exec(shelf.win, `window.clipshelf.removeItems(${JSON.stringify(store.list('shelf').map((i) => i.id))}, 'shelf')`);
    await exec(shelf.win, `window.clipshelf.lockItems(${JSON.stringify(store.list('shelf').map((i) => i.id))}, false)`);
    await exec(shelf.win, `window.clipshelf.wipeShelf()`);
    await wait(600);
    check('shelf hides when it becomes empty', store.list('shelf').length === 0 && !shelf.isVisible());
    shelf.toggle();
    await wait(300);
    check('shortcut shows the (empty) shelf', shelf.isVisible());
    shelf.toggle();
    await wait(200);
    check('shortcut hides it again', !shelf.isVisible());

    // hidden with the shortcut, then a file dropped during a drag: stays visible
    fs.writeFileSync(path.join(out, 'third.txt'), 'third');
    shelf.toggle(); // show (empty)
    shelf.toggle(); // user hides it
    monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: false, pid: 999999 });
    await wait(300);
    await exec(shelf.win, `window.clipshelf.addPathsToShelf([${JSON.stringify(path.join(out, 'third.txt'))}])`);
    monitor.emit('drag', { type: 'drag', active: false });
    await wait(900);
    check('drop after hiding with the shortcut keeps the shelf visible', shelf.isVisible() && store.list('shelf').length === 1);
    ops.isActiveShelfDragPath = (p2) => p2 === path.join(out, 'third.txt');
    const dup = await exec(shelf.win, `window.clipshelf.addPathsToShelf([${JSON.stringify(path.join(out, 'third.txt'))}])`);
    ops.isActiveShelfDragPath = () => false;
    check('dragging a shelf item back onto the shelf does not duplicate it', dup.length === 0 && store.list('shelf').length === 1);
    await exec(shelf.win, `window.clipshelf.wipeShelf()`);
    await wait(600);

    // --- shelf: tuck into the right edge after a drop, hover opens, drag brings it home
    {
      setSettings({ shelfCollapseWhenIdle: true, shelfParkSide: 'right', shelfPosition: 'left-center', shelfCustomPosition: null, shelfShowMode: 'dragStart' });
      const d = screen.getPrimaryDisplay();
      const area = d.workArea;
      const f1 = path.join(out, 'park-1.txt');
      const f2 = path.join(out, 'park-2.png');
      const f3 = path.join(out, 'park-3.txt');
      fs.writeFileSync(f1, 'one');
      fs.writeFileSync(f2, nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-256.png')).toPNG());
      fs.writeFileSync(f3, 'three');
      fakeCursor = { x: area.x + 40, y: area.y + area.height / 2 }; // over the shelf (left edge)
      monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: false, pid: 999999 });
      await wait(300);
      const stackItems = await exec(shelf.win, `window.clipshelf.addPathsToShelf(${JSON.stringify([f1, f2, f3])})`);
      monitor.emit('drag', { type: 'drag', active: false });
      await wait(700);
      const home = shelf.win.getBounds();
      check('dropped: shelf is at its home position (left)', shelf.isVisible() && !shelf.isCollapsed() && home.x === area.x, JSON.stringify(home));
      fakeCursor = { x: area.x + area.width / 2, y: area.y + area.height / 2 }; // mouse moves away
      const tucked = await until(() => shelf.isCollapsed(), 4000);
      await wait(500);
      const tb = shelf.win.getBounds();
      check('mouse away: shelf tucks into a tab at the right edge', tucked && tb.width < 30 && tb.x + tb.width === area.x + area.width, JSON.stringify(tb));
      await shot(shelf.win, '08b-shelf-tab');
      check('tab shows the item count', (await exec(shelf.win, `document.body.classList.contains('collapsed') && document.getElementById('tabCount').textContent`)) === '1');
      fakeCursor = { x: tb.x + 5, y: tb.y + tb.height / 2 }; // hover the tab
      const opened = await until(() => !shelf.isCollapsed(), 3000);
      await wait(500);
      const pb = shelf.win.getBounds();
      check('hovering the tab opens the shelf at the right edge', opened && pb.x + pb.width === area.x + area.width && pb.width > 100, JSON.stringify(pb));
      // pick single files out of the stack
      const stackId = stackItems[0].id;
      await exec(shelf.win, `window.__shelf.toggleStack(${JSON.stringify(stackId)})`);
      await wait(300);
      const childRows = await exec(shelf.win, `document.querySelectorAll('.tile.child').length`);
      check('stack opens to show its files', childRows === 3, childRows);
      await exec(shelf.win, `window.__shelf.selectAll()`);
      check('select all includes the stack files', (await exec(shelf.win, `window.__shelf.state.selected.length`)) === 4);
      await shot(shelf.win, '08c-shelf-stack-open');
      const childThumb = await exec(shelf.win, `window.clipshelf.thumbnail(${JSON.stringify(`${stackId}#1`)}, 96)`);
      check('stack file has its own thumbnail', typeof childThumb === 'string' && childThumb.startsWith('data:image'));
      check('one stack file drags on its own', JSON.stringify(ops.dragPaths([ops.virtual(`${stackId}#2`)], { source: 'shelf' })) === JSON.stringify([f3]));
      await exec(shelf.win, `window.clipshelf.removeItems([${JSON.stringify(`${stackId}#0`)}], 'shelf')`);
      await wait(200);
      const left = store.get(stackId);
      check('taking one file out keeps the rest of the stack', left && left.files.length === 2 && left.files[0].path === f2, left && left.files.map((f) => f.name).join(','));
      await exec(shelf.win, `window.clipshelf.restoreShelf()`);
      await wait(200);
      check('the taken-out file comes back as its own item', store.list('shelf').some((i) => i.files && i.files.length === 1 && i.files[0].path === f1));

      // preview popup next to the shelf
      await exec(shelf.win, `window.clipshelf.previewItem(${JSON.stringify(stackId)}, 'shelf')`);
      const popup = await until(() => previewWindow.isOpen() && previewWindow.ready && previewWindow.win, 5000);
      await wait(600);
      const ppb = popup && popup.getBounds();
      check('eye button: preview pops up beside the shelf', !!popup && ppb.x + ppb.width <= pb.x, ppb && JSON.stringify(ppb));
      const kind = popup && (await exec(popup, `document.body.dataset.kind + '|' + document.querySelectorAll('.strip-item').length`));
      check('file preview with the stack strip', kind === 'image|2', kind);
      if (popup) await shot(popup, '08d-preview-popup');
      check('shelf stays open while the preview is open', !shelf.isCollapsed() && shelf.previewOpen);
      await exec(popup, `document.querySelectorAll('.strip-item')[1].click()`);
      await wait(600);
      const switched = await exec(popup, `document.body.dataset.kind + '|' + document.querySelector('.strip-item.on span').textContent`);
      check('preview switches to another file of the stack', switched === 'text|park-3.txt' && previewWindow.isOpen(), switched);
      await shot(popup, '08e-preview-image');
      // pressing the eye button again: the click first takes focus away (blur), then the button fires
      previewWindow.win.emit('blur');
      await exec(shelf.win, `window.clipshelf.previewItem(${JSON.stringify(stackId)}, 'shelf')`);
      await wait(700);
      check('eye button again closes it (no reopen)', !previewWindow.isOpen() && !previewWindow.win && !shelf.previewOpen);
      await exec(shelf.win, `window.clipshelf.previewItem(${JSON.stringify(stackId)}, 'shelf')`);
      await until(() => previewWindow.isOpen(), 4000);
      await wait(400);
      previewWindow.win.emit('blur');
      await wait(400);
      check('clicking elsewhere closes the preview', !previewWindow.isOpen() && !shelf.previewOpen);
      await wait(500);

      // media / folders / other files
      const pc = require(path.join(__dirname, '..', 'src', 'main', 'previewContent'));
      const wav = path.join(out, 'tone.wav');
      const samples = 8000;
      const buf = Buffer.alloc(44 + samples);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(8000, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(samples, 40);
      for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(60 * Math.sin(i / 4));
      fs.writeFileSync(wav, buf);
      const audio = await pc.describeFile(wav);
      check('audio preview uses the private media URL', audio.kind === 'audio' && audio.src.startsWith('clipshelf-media://preview/'));
      const audioItem = await exec(shelf.win, `window.clipshelf.addPathsToShelf([${JSON.stringify(wav)}])`);
      await exec(shelf.win, `window.clipshelf.previewItem(${JSON.stringify(audioItem[0].id)}, 'shelf')`);
      const ap = await until(() => previewWindow.isOpen() && previewWindow.ready && previewWindow.win, 5000);
      await wait(800);
      const { net } = require('electron');
      const loaded = ap && (await exec(ap, `new Promise((res) => { const a = document.querySelector('audio'); if (!a) return res('no-audio'); const done = () => res(a.readyState + ':' + (a.duration ? a.duration.toFixed(1) : 0)); if (a.readyState >= 1) done(); else { a.addEventListener('loadedmetadata', done); a.addEventListener('error', () => res('error:' + (a.error && a.error.code))); setTimeout(done, 3000); } })`));
      check('audio loads in the preview popup', !!loaded && /^[1-4]:1\.0$/.test(loaded), loaded);
      const src = ap && (await exec(ap, `document.querySelector('audio').src`));
      const res = src && (await net.fetch(src, { headers: { Range: 'bytes=0-11' } }));
      const head = res && Buffer.from(await res.arrayBuffer()).toString('latin1', 0, 4);
      check('media streams with range requests', !!res && res.status === 206 && res.headers.get('content-range') === `bytes 0-11/${buf.length}` && head === 'RIFF', res && `${res.status} ${res.headers.get('content-range')} ${head}`);
      const bogus = await net.fetch('clipshelf-media://preview/0000').then((r) => r.status, () => 'blocked');
      check('unknown media tokens are refused', bogus === 404 || bogus === 'blocked', bogus);
      const fetchBlocked = ap && (await exec(ap, `fetch(${JSON.stringify(String(src))}).then(() => 'allowed', () => 'blocked')`));
      check('page scripts cannot read media files (CSP)', fetchBlocked === 'blocked', fetchBlocked);
      previewWindow.close();
      await wait(300);
      const folder = await pc.describeFile(out, { isDir: true });
      check('folder preview lists its contents', folder.kind === 'folder' && folder.entries.some((e) => e.name === 'park-1.txt'));
      const txt = await pc.describeFile(f1);
      check('text file preview', txt.kind === 'text' && txt.text === 'one');

      // follows the user to another display
      const fake = { ...d, id: 424242, bounds: { x: area.x + area.width, y: area.y, width: 1000, height: 700 }, workArea: { x: area.x + area.width, y: area.y, width: 1000, height: 700 } };
      const realNearest = screen.getDisplayNearestPoint.bind(screen);
      const realAll = screen.getAllDisplays.bind(screen);
      screen.getDisplayNearestPoint = (pt) => (pt.x >= fake.workArea.x ? fake : realNearest(pt));
      screen.getAllDisplays = () => realAll().concat(fake);
      fakeCursor = { x: fake.workArea.x + 500, y: fake.workArea.y + 300 };
      const moved = await until(() => shelf.displayId === fake.id, 3000);
      await wait(300);
      const mb = shelf.win.getBounds();
      check('shelf moves to the display being used', moved && mb.x >= fake.workArea.x, JSON.stringify(mb));
      setSettings({ shelfFollowActiveDisplay: false });
      fakeCursor = { x: area.x + area.width / 2, y: area.y + 200 };
      await wait(600);
      check('following can be turned off', shelf.displayId === fake.id);
      setSettings({ shelfFollowActiveDisplay: true });
      await until(() => shelf.displayId !== fake.id, 3000);
      screen.getDisplayNearestPoint = realNearest;
      screen.getAllDisplays = realAll;

      // a new drag brings it back to the home position
      fakeCursor = { x: area.x + area.width / 2, y: area.y + 200 };
      await until(() => shelf.isCollapsed(), 4000);
      monitor.emit('drag', { type: 'drag', active: true, kind: 'files', bypass: false, pid: 999999 });
      await wait(400);
      const hb = shelf.win.getBounds();
      check('starting a drag opens it at the home position again', !shelf.isCollapsed() && hb.x === area.x && hb.width > 100, JSON.stringify(hb));
      monitor.emit('drag', { type: 'drag', active: false });
      await wait(600);
      setSettings({ shelfParkSide: 'same' });
      await until(() => shelf.isCollapsed(), 4000);
      await wait(400);
      check('park side "same" tucks it at the left edge', shelf.win.getBounds().x === area.x && shelf.win.getBounds().width < 30);
      // dragged to a custom place near the top: the tab and the opened shelf line up (no open/close loop)
      setSettings({ shelfParkSide: 'right', shelfCustomPosition: { x: area.x + 300, y: area.y + 10 } });
      await wait(300);
      shelf.expand();
      fakeCursor = { x: area.x + 600, y: area.y + 400 };
      await until(() => shelf.isCollapsed(), 4000);
      await wait(500);
      const tb2 = shelf.win.getBounds();
      fakeCursor = { x: tb2.x + 4, y: tb2.y + tb2.height / 2 };
      await until(() => !shelf.isCollapsed(), 3000);
      await wait(2000);
      const ob = shelf.win.getBounds();
      const inside = fakeCursor.x >= ob.x && fakeCursor.x <= ob.x + ob.width && fakeCursor.y >= ob.y && fakeCursor.y <= ob.y + ob.height;
      check('pointer resting on the tab keeps the shelf open', !shelf.isCollapsed() && inside, JSON.stringify({ tab: tb2, open: ob }));
      setSettings({ shelfCustomPosition: null, shelfCollapseWhenIdle: false });
      await wait(300);
      check('turning collapsing off opens it again', !shelf.isCollapsed());
      await exec(shelf.win, `window.clipshelf.lockItems(${JSON.stringify(store.list('shelf').map((i) => i.id))}, false)`);
      await exec(shelf.win, `window.clipshelf.wipeShelf()`);
      await wait(600);
      fakeCursor = null;
    }

    // --- Paste から取り込む (Electron's node:sqlite + the real store)
    {
      const imp = require(path.join(__dirname, '..', 'src', 'main', 'pasteImport'));
      const { DatabaseSync } = require('node:sqlite');
      const bplistCreate = require('bplist-creator');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-paste-'));
      const dbFile = path.join(dir, 'Paste.sqlite');
      const db = new DatabaseSync(dbFile);
      db.exec(`CREATE TABLE ZITEMENTITY (Z_PK INTEGER PRIMARY KEY, ZTITLE VARCHAR, ZTIMESTAMP TIMESTAMP, ZLIST INTEGER, ZIDENTIFIER VARCHAR, ZDISPLAYORDERINPINBOARD INTEGER);
        CREATE TABLE ZITEMDATAENTITY (Z_PK INTEGER PRIMARY KEY, ZITEM INTEGER, ZRAWPASTEBOARDITEMS BLOB);
        CREATE TABLE ZLISTENTITY (Z_PK INTEGER PRIMARY KEY, ZNAME VARCHAR, ZIDENTIFIER VARCHAR);`);
      db.prepare('INSERT INTO ZLISTENTITY VALUES (1, NULL, ?)').run('H');
      db.prepare('INSERT INTO ZLISTENTITY VALUES (2, ?, ?)').run('Paste のピンボード', 'P');
      const ts = (Date.now() - 978307200000) / 1000;
      db.prepare('INSERT INTO ZITEMENTITY VALUES (1, NULL, ?, 1, ?, NULL)').run(ts - 10, 'x1');
      db.prepare('INSERT INTO ZITEMDATAENTITY VALUES (1, 1, ?)').run(bplistCreate([{ type: 'public.utf8-plain-text', data: Buffer.from('Paste から来た履歴') }]));
      db.prepare('INSERT INTO ZITEMENTITY VALUES (2, NULL, ?, 2, ?, 0)').run(ts - 5, 'x2');
      db.prepare('INSERT INTO ZITEMDATAENTITY VALUES (2, 2, ?)').run(bplistCreate([{ type: 'public.png', data: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon-256.png')).toPNG() }]));
      db.close();
      const info = imp.inspectStore(dbFile);
      check('Paste store inspection', info.total === 2 && info.pinned === 1, JSON.stringify(info));
      const { counts } = await imp.importStore(dbFile, {
        store,
        quiet: true,
        saveBlob: (b, ext) => require(path.join(__dirname, '..', 'src', 'main', 'blobs')).saveBlob(store.settings, b, ext || '.png'),
        statFile: () => null,
        since: 0
      });
      store.emit('reset');
      await wait(300);
      check('Paste import (history + pinboard)', counts.history === 1 && counts.pinned === 1 && counts.pinboards === 1, JSON.stringify(counts));
      const board = store.pinboards().find((b) => b.name === 'Paste のピンボード');
      const pinnedImage = board && store.list('pin', { pinboardId: board.id }).find((i) => i.type === 'image');
      check('imported image is readable', !!(pinnedImage && (await ops.thumbnail(pinnedImage.id, 64))));
      check('imported history appears in the panel list', !!byText('Paste から来た履歴'));
      const mac = await inPanel(`window.clipshelf.importFromPaste()`);
      check('import button answers on this OS', process.platform === 'darwin' ? !!mac : mac && mac.error === 'mac-only', JSON.stringify(mac));
      const st = await inPanel(`window.clipshelf.systemStatus()`);
      check('status reports folder access and shortcut conflicts', 'fullDiskAccess' in st && Array.isArray(st.shortcutConflicts));
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // --- settings window: every section renders
    const sw = settingsWindow.show('general');
    await until(() => settingsWindow.ready, 8000);
    await wait(800);
    setSettings({ screenOcrEnabled: true, windowSnapEnabled: true, focusFollowMouse: { enabled: true }, keepAwake: { enabled: true, followCapsLock: true } });
    const sections = ['welcome', 'general', 'history', 'shortcuts', 'privacy', 'shelf', 'shelfAdvanced', 'screenOcr', 'snap', 'focus', 'keepAwake', 'sync', 'permissions', 'update', 'about'];
    let broken = [];
    for (const [i, id] of sections.entries()) {
      sw.webContents.send('settings:section', id);
      await wait(450);
      const ok = await exec(sw, `document.querySelector('#content h2') ? document.querySelector('#content h2').textContent : ''`);
      if (!ok) broken.push(id);
      await shot(sw, `09-settings-${String(i).padStart(2, '0')}-${id}`);
    }
    check('all settings sections render', broken.length === 0, broken.join(','));
    const tallRows = await exec(sw, `Array.from(document.querySelectorAll('.row')).filter((r) => r.getBoundingClientRect().height > 140 && !r.classList.contains('stack')).length`);
    check('settings rows have sane heights', tallRows === 0, `tall rows: ${tallRows}`);
    sw.webContents.send('settings:section', 'shortcuts');
    await wait(500);
    const shortcutLabels = await exec(sw, `document.querySelectorAll('.shortcut-btn').length`);
    check('shortcut editors listed', shortcutLabels >= 25, `count=${shortcutLabels}`);
    const snapRes = await ctx.snapper.apply('snapLeft');
    check('snap fails soft on unsupported OS', !snapRes.ok && snapRes.reason === 'unsupported', JSON.stringify(snapRes));
    sw.close();

    // keep awake
    const ka = keepAwake.start({ durationMs: 60000 });
    check('keep-awake on', ka.active && powerSaveBlocker.isStarted(keepAwake.blockerId) && ka.until);
    keepAwake.stop();
    check('keep-awake off', !keepAwake.isActive());

    // HUD + sound
    hud.show('コピーしました', 'スモークテストの表示確認');
    hud.sound('copy');
    await wait(700);
    const hudWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'ClipShelf HUD');
    await shot(hudWin, '10-hud');
    check('hud window visible', hudWin && hudWin.isVisible());

    // screen OCR end-to-end: show the sample image, select it, expect the text on the clipboard
    if (ocrImage && fs.existsSync(ocrImage)) {
      const size = nativeImage.createFromPath(ocrImage).getSize();
      const viewer = new BrowserWindow({ x: 40, y: 40, width: size.width, height: size.height, frame: false, show: true, useContentSize: true });
      await viewer.loadFile(ocrImage);
      await wait(800);
      await wait(300);
      await screenOcr.trigger();
      const overlay = await until(() => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'ClipShelf OCR' && w.isVisible()), 8000);
      check('screen OCR overlay opened', !!overlay);
      if (overlay) {
        await wait(800);
        await shot(overlay, '09-ocr-overlay');
        const b = viewer.getContentBounds();
        const d = require('electron').screen.getDisplayMatching(b).bounds;
        overlay.webContents.send('noop');
        // not awaited: the overlay closes itself as part of this call
        overlay.webContents
          .executeJavaScript(`window.clipshelf.screenOcrSelected(${JSON.stringify({ x: b.x - d.x, y: b.y - d.y, width: b.width, height: b.height })})`)
          .catch(() => {});
        const text = await until(async () => {
          const t = await clipboard.readText();
          return /ライブコマース/.test(t) ? t : null;
        }, 60000);
        check('screen OCR copied text', !!text, text);
        check('screen OCR saved to history', !!(await until(() => history().find((i) => i.sourceApp === '画面から読み取り'), 5000)));
      }
      viewer.destroy();
    }

    // --- update notice (local fake release feed; set by scripts/run-smoke.js)
    const feedUrl = process.env.CLIPSHELF_UPDATE_FEED;
    if (feedUrl && updater) {
      const http = require('http');
      const crypto = require('crypto');
      const port = Number(new URL(feedUrl).port);
      const payload = Buffer.from('fake-installer-'.repeat(5000));
      const base = `http://127.0.0.1:${port}`;
      const feed = {
        version: '9.9.9',
        notes: '- テスト用の新しい版\n- 2行目',
        page: 'https://github.com/example/releases/tag/v9.9.9',
        assets: [
          { name: 'HarboR-ClipShelf-9.9.9-linux-x64.AppImage', url: `${base}/app.AppImage`, size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') },
          { name: 'HarboR-ClipShelf-9.9.9-win-x64.exe', url: `${base}/app.exe`, size: 1 }
        ]
      };
      const server = http.createServer((req, res) => {
        if (req.url === '/latest.json') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(feed));
        } else if (req.url === '/app.AppImage') {
          res.setHeader('content-length', payload.length);
          res.end(payload);
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      try {
        const st = await updater.check({ manual: true });
        check('update: newer version detected', st.status === 'available' && st.newer && st.latest.version === '9.9.9', JSON.stringify({ status: st.status, error: st.error }));
        const file = await updater.download(updater.latest.assets[0]);
        check('update: download verified', fs.readFileSync(file).equals(payload));
        updater.cleanup();
        const sw2 = settingsWindow.show('update');
        await until(() => settingsWindow.ready, 8000);
        const sec = await until(() => exec(sw2, `document.querySelector('.notes') && document.querySelector('.notes').textContent`), 4000);
        check('update: settings section shows notes', sec && sec.includes('テスト用の新しい版'), sec);
        const badge = await exec(sw2, `!!document.querySelector('.side .badge')`);
        check('update: sidebar badge', badge);
        await wait(300);
        await shot(sw2, '11-update-settings');
        await updater.skip('9.9.9');
        check('update: skip remembered', updater.state().skipped && getSettings().skippedUpdateVersion === '9.9.9');
        await updater.skip(null);
      } finally {
        server.close();
      }
    }

    // renderer errors are forwarded to the log (probe, then make sure nothing else was)
    await inPanel(`console.error('smoke-probe-error')`);
    await wait(300);
    const probeLog = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), 'utf8');
    check('renderer errors reach the log', probeLog.includes('[renderer:panel] smoke-probe-error'));
    const logText = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'main.log'), 'utf8');
    // the CSP probe above is expected to be refused (and logged)
    const rendererErrors = logText.split('\n').filter((l) => !l.includes('smoke-probe-error') && !(l.includes('[renderer:preview]') && l.includes('clipshelf-media://') && /Content Security Policy/.test(l))).filter((l) => l.includes('[renderer:') || l.includes('[ipc]') || l.includes('[uncaught]') || l.includes('[unhandled]'));
    check('no renderer / ipc errors', rendererErrors.length === 0, rendererErrors.join(' | '));
  } catch (err) {
    check('smoke run crashed', false, err && err.stack);
  }

  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  log.info(`[smoke] done: ${results.length - failed.length}/${results.length} passed → ${out}`);
  app.exit(failed.length ? 1 : 0);
};
