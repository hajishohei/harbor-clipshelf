'use strict';
/* global CS, ClipShelfAccelerator */
(function () {
  const { api, isMac, el, toast, accDisplay, composing } = CS;
  const Acc = ClipShelfAccelerator;
  const $ = (id) => document.getElementById(id);
  const contentEl = $('content');
  const CMD = isMac ? '⌘' : 'Ctrl+';

  const SECTIONS = [
    ['welcome', 'はじめに', null],
    ['general', '一般', 'ClipShelf'],
    ['history', 'クリップボード履歴', 'クリップボード（Paste）'],
    ['shortcuts', 'ショートカット', 'クリップボード（Paste）'],
    ['privacy', 'プライバシー', 'クリップボード（Paste）'],
    ['shelf', '振る舞い', 'シェルフ（Yoink）'],
    ['shelfAdvanced', '詳細', 'シェルフ（Yoink）'],
    ['screenOcr', '画面から文字を読み取る', 'そのほかの機能'],
    ['snap', 'ウィンドウ整列', 'そのほかの機能'],
    ['focus', 'フォーカス自動切替', 'そのほかの機能'],
    ['keepAwake', 'スリープ防止', 'そのほかの機能'],
    ['sync', '同期', '管理'],
    ['permissions', 'アクセス権', '管理'],
    ['update', 'アップデート', '管理'],
    ['about', '情報', '管理']
  ];

  const state = {
    section: 'welcome',
    info: null,
    settings: null,
    status: null,
    shortcutResults: {},
    keepAwake: { active: false },
    update: null,
    recording: null,
    token: 0
  };
  const set = (patch) => api.setSettings(patch);

  // ------------------------------------------------------------ building blocks
  function section(title, desc) {
    const sec = el('section', 'section');
    if (title) {
      const head = el('header');
      head.append(el('h3', null, title));
      if (desc) head.append(el('p', null, desc));
      sec.append(head);
    }
    return sec;
  }

  function row(label, hint, ...controls) {
    const r = el('div', 'row');
    const text = el('div', 'text');
    text.append(el('div', null, label));
    if (hint) text.append(el('div', 'hint', hint));
    const c = el('div', 'control');
    c.append(...controls.filter(Boolean));
    r.append(text, c);
    return r;
  }

  function toggle(checked, onChange, ariaLabel) {
    const wrap = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
    input.onchange = () => onChange(input.checked);
    wrap.append(input, el('span'));
    return wrap;
  }

  function select(options, value, onChange) {
    const s = el('select', 'field');
    for (const [v, label] of options) {
      const o = el('option', null, label);
      o.value = String(v);
      if (String(v) === String(value)) o.selected = true;
      s.append(o);
    }
    s.onchange = () => onChange(s.value);
    return s;
  }

  function segmented(options, value, onChange) {
    const box = el('div', 'segmented');
    for (const [v, label] of options) {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === value));
      b.onclick = () => onChange(v);
      box.append(b);
    }
    return box;
  }

  function button(label, onClick, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = onClick;
    return b;
  }

  function notice(kind, text, ...controls) {
    const n = el('div', `notice ${kind}`);
    n.append(el('span', null, text));
    if (controls.length) {
      const c = el('span', 'control');
      c.append(...controls);
      n.append(c);
    }
    return n;
  }

  function heading(title, lead) {
    const frag = document.createDocumentFragment();
    frag.append(el('h2', null, title));
    if (lead) frag.append(el('p', 'lead', lead));
    return frag;
  }

  // ------------------------------------------------------------ shortcut recorder
  const SHORTCUT_ERRORS = {
    'in-use': '他のアプリかシステムが使用中のため、使えません',
    duplicate: '他の操作と同じ組み合わせです',
    invalid: 'この組み合わせは使えません'
  };

  function shortcutField(key, { local = false } = {}) {
    const wrap = el('div', 'shortcut');
    const btn = el('button', 'shortcut-btn');
    btn.type = 'button';
    const warn = el('span', 'warn');
    const show = () => {
      const current = state.settings.shortcuts[key];
      btn.textContent = current ? accDisplay(current) : 'なし';
      btn.classList.toggle('unset', !current);
    };
    show();
    const res = state.shortcutResults[key];
    if (!local && state.settings.shortcuts[key] && res && !res.registered && res.reason !== 'empty') {
      const c = (state.conflicts || []).find((x) => x.key === key);
      warn.textContent = res.reason === 'duplicate' ? SHORTCUT_ERRORS.duplicate : res.reason === 'invalid' ? SHORTCUT_ERRORS.invalid : c && c.app ? `「${c.app.name}」が使用中のため使えません` : SHORTCUT_ERRORS['in-use'];
    }
    btn.onclick = () => startRecording(key, btn, warn, show, local);
    const clear = button('×', () => set({ shortcuts: { [key]: '' } }), 'icon-btn');
    clear.title = '削除（なしにする）';
    const reset = button('↺', () => set({ shortcuts: { [key]: state.info.defaults[key] || '' } }), 'icon-btn');
    reset.title = '初期設定に戻す';
    wrap.append(warn, btn, clear, reset);
    return wrap;
  }

  async function startRecording(key, btn, warn, show, local) {
    if (state.recording) state.recording.stop();
    await api.suspendShortcuts();
    btn.classList.add('recording');
    btn.textContent = '記録中…';
    warn.textContent = '';
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = Acc.fromKeyboardEvent(e, api.platform);
      if (r.pending) {
        const mods = r.modifiers.map((m) => Acc.toDisplay(`${m}+X`, api.platform).replace(/X$/, '')).join('');
        btn.textContent = mods ? `${mods}…` : '記録中…';
        return;
      }
      if (r.cancel) return stop();
      if (r.clear) {
        await set({ shortcuts: { [key]: '' } });
        return stop();
      }
      if (r.error) {
        warn.textContent = r.error === 'needs-modifier' ? `${isMac ? '⌘ ⌃ ⌥' : 'Ctrl / Alt'} と組み合わせてください（F1〜F24 は単独でも可）` : SHORTCUT_ERRORS.invalid;
        return;
      }
      const dup = Object.entries(state.settings.shortcuts).find(([k, v]) => k !== key && v === r.accelerator && state.info.localShortcuts.includes(k) === local);
      if (dup) {
        warn.textContent = SHORTCUT_ERRORS.duplicate;
        return;
      }
      if (!local) {
        const check = await api.checkShortcut(r.accelerator);
        if (!check.ok) {
          warn.textContent = SHORTCUT_ERRORS[check.reason] || SHORTCUT_ERRORS.invalid;
          return;
        }
      }
      await set({ shortcuts: { [key]: r.accelerator } });
      stop();
    };
    const stop = async () => {
      window.removeEventListener('keydown', onKey, true);
      btn.removeEventListener('blur', stop);
      btn.classList.remove('recording');
      state.recording = null;
      show();
      const st = await api.resumeShortcuts();
      state.shortcutResults = st.results;
    };
    state.recording = { stop };
    window.addEventListener('keydown', onKey, true);
    btn.addEventListener('blur', stop);
  }

  // ------------------------------------------------------------ app list editor
  function appList(key, placeholder) {
    const box = el('div', 'applist');
    const list = state.settings[key] || [];
    if (!list.length) box.append(el('div', 'empty', '項目なし'));
    for (const name of list) {
      const item = el('div', 'item');
      item.append(el('span', null, name), button('−', () => set({ [key]: list.filter((x) => x !== name) }), 'icon-btn'));
      box.append(item);
    }
    const tools = el('div', 'tools');
    const input = el('input', 'field');
    input.placeholder = placeholder;
    const add = async (name) => {
      const v = String(name || '').trim();
      if (!v || list.includes(v)) return;
      await set({ [key]: list.concat(v) });
    };
    input.addEventListener('keydown', (e) => {
      if (composing(e)) return;
      if (e.key === 'Enter') add(input.value);
    });
    tools.append(input, button('追加', () => add(input.value)), button('アプリを選ぶ…', async () => add(await api.chooseApp())));
    box.append(tools);
    return box;
  }

  function stackRow(label, hint, control) {
    const r = el('div', 'row stack');
    const text = el('div', 'text');
    text.append(el('div', null, label));
    if (hint) text.append(el('div', 'hint', hint));
    r.append(text, control);
    return r;
  }

  // ------------------------------------------------------------ permissions
  function accessibilityNotice(sec, why) {
    if (!isMac || !state.status) return;
    if (state.status.accessibility === false) {
      sec.append(notice('warn', `${why}には「アクセシビリティ」の許可が必要です`, button('許可する', async () => {
        await api.requestAccessibility();
        await api.openPrivacy('accessibility');
      })));
    }
  }

  // ------------------------------------------------------------ sections
  const RENDER = {
    welcome(root) {
      const s = state.settings;
      root.append(heading('HarboR ClipShelf へようこそ', 'コピーしたものを全部覚えておく「クリップボード履歴」と、ファイルを一時的に置いておける「シェルフ」が使えます。操作は Paste と Yoink と同じです。'));
      const sec = section('クイックスタート');
      sec.classList.add('welcome-steps');
      sec.append(
        row('呼び出すショートカット', 'どのアプリからでも、このキーでクリップボード履歴を開けます', shortcutField('togglePanel')),
        row('履歴を保持する期間', 'これより前にコピーしたものは自動で消えます（固定したものは消えません）', retentionSelect()),
        row('ログイン時に開く', 'パソコンを起動したら自動で使える状態にします', toggle(s.launchAtLogin, (v) => set({ launchAtLogin: v })))
      );
      if (isMac) {
        sec.append(row('アプリに直接貼り付ける', 'Enter やダブルクリックで、元のアプリにそのまま貼り付けます（アクセシビリティの許可が必要）',
          state.status && state.status.accessibility ? el('span', 'hint', '許可済み') : button('許可する', async () => {
            await api.requestAccessibility();
            await api.openPrivacy('accessibility');
          })));
        fullDiskRow(sec);
        sec.append(row('Paste を使っていた方', 'Paste のコピー履歴とピンボードをそのまま取り込めます（Paste 側のデータは消えません）', button('Paste から取り込む', importFromPaste)));
      }
      conflictNotices(sec, ['togglePanel', 'toggleShelf']);
      root.append(sec);
      const how = section('使い方');
      const k = el('div', 'kbdlist');
      const pairs = [
        [accDisplay(s.shortcuts.togglePanel) || '—', 'クリップボード履歴を開く / 閉じる'],
        ['← →', 'アイテムを選ぶ（⇧ で複数選択）'],
        ['Return', 'アプリに貼り付け（⇧Return で書式なし）'],
        [`${CMD}1〜9`, 'その番号のアイテムをすぐ貼り付け'],
        ['Space', 'プレビュー'],
        ['文字を入力', '検索（画像の中の文字も対象）'],
        ...(s.shortcuts.pasteStack ? [[accDisplay(s.shortcuts.pasteStack), 'Paste Stack（コピーした順に連続で貼り付け）']] : []),
        ['ファイルをドラッグ', '画面端にシェルフが出てくるので、そこに置いておけます'],
        [accDisplay(s.shortcuts.toggleShelf) || '—', 'シェルフを表示 / 隠す（2回押しでクリップボードの内容を追加）']
      ];
      for (const [a, b] of pairs) k.append(el('span', null, a), el('span', null, b));
      how.append(k);
      root.append(how);
      const start = section();
      start.append(row('準備ができたら', `${accDisplay(s.shortcuts.togglePanel) || 'メニューのアイコン'} でいつでも開けます`, button('使ってみる', async () => {
        await set({ firstRunCompleted: true });
        await api.openPanel();
        window.close();
      }, 'btn primary')));
      root.append(start);
    },

    general(root) {
      const s = state.settings;
      root.append(heading('一般'));
      const app = section('アプリ');
      app.append(
        row('ログイン時に開く', null, toggle(s.launchAtLogin, (v) => set({ launchAtLogin: v }))),
        row(isMac ? 'メニューバーに表示する' : 'タスクトレイに表示する', 'OFF にしても、アプリをもう一度開けば設定を表示できます', toggle(s.showMenuBarIcon, (v) => set({ showMenuBarIcon: v }))),
        row('効果音', 'コピーしたとき・貼り付けたときに小さな音を鳴らします', toggle(s.soundEffects, (v) => set({ soundEffects: v }))),
        row('外観モード', null, segmented([['system', 'デフォルト'], ['light', 'ライト'], ['dark', 'ダーク']], s.appearance, (v) => set({ appearance: v })))
      );
      root.append(app);
    },

    history(root) {
      const s = state.settings;
      root.append(heading('クリップボード履歴', 'Paste と同じ操作で、コピーしたものを探して貼り付けます。'));
      const keep = section('履歴');
      keep.append(
        row('履歴を保持する', 'これより前に使ったアイテムは自動で削除されます（固定したアイテムとピンボードは対象外）', retentionSelect()),
        row('履歴を消去', '固定されたアイテムとピンボードは削除されません。この操作は元に戻せません', button('履歴を消去…', async () => {
          const ok = await api.confirm({ message: 'クリップボードの履歴を消去してもよろしいですか？', detail: '固定されたアイテムとピンボードは削除されません。この操作は元に戻せません。', ok: '消去' });
          if (ok) {
            const n = await api.eraseHistory();
            toast(`${n} 件を消去しました`);
          }
        }, 'btn danger'))
      );
      if (isMac) keep.append(row('Paste から取り込む', 'Paste（wiheads）のコピー履歴とピンボードを取り込みます。何度押しても同じ項目は二重になりません', button('取り込む…', importFromPaste)));
      root.append(keep);

      const paste = section('アイテムを貼り付ける', `Return キー・ダブルクリック・${CMD}1〜9 を押したときの動作`);
      paste.append(
        row('貼り付け先', s.pasteTarget === 'app' ? '現在使用中のアプリケーションに選択したアイテムを直接貼り付けます' : '選択したアイテムをクリップボードにコピーします（あとで手動で貼り付け）',
          segmented([['app', 'アクティブなアプリへ'], ['clipboard', 'クリップボードへ']], s.pasteTarget, (v) => set({ pasteTarget: v }))),
        row('常にプレーンテキストとして貼り付ける', '書式（太字・色・リンクなど）を外して貼り付けます', toggle(s.alwaysPlainText, (v) => set({ alwaysPlainText: v }))),
        row('複数のアイテムをまとめて貼り付けるときの区切り', null, select([['newline', '改行'], ['space', 'スペース'], ['none', 'なし']], s.multiPasteSeparator, (v) => set({ multiPasteSeparator: v })))
      );
      if (s.pasteTarget === 'app') accessibilityNotice(paste, 'アプリへの直接貼り付け');
      if (!isMac && !(state.status && state.status.windowService.supported)) paste.append(notice('warn', 'このOSでは直接貼り付けできないため、クリップボードへのコピーになります'));
      root.append(paste);

      const stack = section('Paste Stack', `${s.shortcuts.pasteStack ? accDisplay(s.shortcuts.pasteStack) : 'メニューバーのアイコン'} で開いている間、コピーしたものが順番に積まれ、${CMD}V で1つずつ貼り付けます。${s.shortcuts.pasteStack ? '' : 'ショートカットは初期設定では割り当てていません（ショートカットの設定で追加できます）'}`);
      stack.append(row('新しいアイテムの追加先', null, segmented([['fifo', '下に追加（上から順に貼り付け）'], ['lifo', '上に追加（新しい順に貼り付け）']], s.pasteStackOrder, (v) => set({ pasteStackOrder: v }))));
      root.append(stack);

      const rec = section('記録');
      rec.append(
        row('クリップボードを記録する', s.captureEnabled ? null : '一時停止中です', toggle(s.captureEnabled, (v) => (v ? api.resume() : api.pause(null)))),
        row('コピー元のアプリを記録する', 'カードの色とアイコン、アプリでの絞り込みに使います', toggle(s.recordSourceApp, (v) => set({ recordSourceApp: v }))),
        row('画像の中の文字も検索できるようにする', '画像を端末内で文字認識します（外部には送信しません）', toggle(s.ocrEnabled, (v) => set({ ocrEnabled: v })))
      );
      root.append(rec);
    },

    shortcuts(root) {
      const s = state.settings;
      root.append(heading('ショートカット', 'ボタンを押してから、割り当てたいキーを押してください。Delete キーで「なし」にできます。'));
      const paste = section('クリップボード（Paste）');
      conflictNotices(paste);
      paste.append(
        row('ClipShelf を開く', 'どのアプリからでも使えます', shortcutField('togglePanel')),
        row('Paste Stack を開く', '初期設定は「なし」（⇧⌘C は多くのアプリで使われるため）。割り当てるとそのキーで Paste Stack のウィンドウが開きます', shortcutField('pasteStack')),
        row('次のピンボードを表示', '履歴を開いている間だけ使えます', shortcutField('nextPinboard', { local: true })),
        row('前のピンボードを表示', '履歴を開いている間だけ使えます', shortcutField('prevPinboard', { local: true })),
        row('プレーンテキストモード', 'このキーを押しながら Return / ダブルクリック / Quick Paste すると書式なしで貼り付けます',
          select([['Shift', isMac ? '⇧ Shift' : 'Shift'], ['Option', isMac ? '⌥ Option' : 'Alt'], ['Control', isMac ? '⌃ Control' : 'Ctrl'], ['Command', isMac ? '⌘ Command' : 'Ctrl（Quick Paste と同じ）']], s.plainTextModifier, (v) => set({ plainTextModifier: v }))),
        row('Quick Paste', 'このキー＋数字（1〜9）で、その番号のアイテムをすぐ貼り付けます',
          select(isMac ? [['Command', '⌘ Command'], ['Control', '⌃ Control'], ['Option', '⌥ Option']] : [['Control', 'Ctrl'], ['Option', 'Alt']], s.quickPasteModifier, (v) => set({ quickPasteModifier: v })))
      );
      root.append(paste);
      const shelf = section('シェルフ（Yoink）');
      shelf.append(row('シェルフを表示 / 隠す', `長押しで直前に消した項目を戻す、2回連続で押すとクリップボードの内容を追加${isMac && /^F\d+$/.test(s.shortcuts.toggleShelf || '') ? '。MacBook などでは fn キーを押しながら押してください（システム設定 → キーボード →「F1、F2 などのキーを標準のファンクションキーとして使用」を ON にすると fn 不要）' : ''}`, shortcutField('toggleShelf')));
      root.append(shelf);
      const other = section('そのほかの機能');
      other.append(
        row('画面から文字を読み取る', s.screenOcrEnabled ? null : '機能がOFFのため、今は使われません', shortcutField('screenOcr')),
        row('スリープ防止 ON / OFF', s.keepAwake.enabled ? null : '機能がOFFのため、今は使われません', shortcutField('toggleKeepAwake'))
      );
      root.append(other);
      const snap = section('ウィンドウ整列', s.windowSnapEnabled ? null : '機能がOFFのため、今は使われません');
      for (const action of state.info.snapActions) snap.append(row(state.info.snapLabels[action] || action, null, shortcutField(action)));
      root.append(snap);
      const reset = section();
      reset.append(row('ショートカットを初期設定に戻す', null, button('リセット…', async () => {
        const ok = await api.confirm({ message: 'すべてのショートカットを初期設定に戻してもよろしいですか？', ok: 'リセット' });
        if (ok) await api.resetShortcuts();
      })));
      root.append(reset);
    },

    privacy(root) {
      const s = state.settings;
      root.append(heading('プライバシー'));
      const sec = section('記録しない内容');
      sec.append(
        stackRow('次のアプリケーションを無視する', '以下のアプリケーションからコピーしたコンテンツは保存しません', appList('ignoredApps', 'アプリ名（一部でも可）')),
        row('一時的なコンテンツを無視する', '他のアプリが一時的に作ったデータ（自動生成されたものなど）を保存しません', toggle(s.ignoreTransient, (v) => set({ ignoreTransient: v }))),
        row('機密情報を無視する', 'パスワード管理アプリなどが「機密」と印を付けたコピーを保存しません（初期設定: OFF＝パスワードも記録します）', toggle(s.ignoreConfidential, (v) => set({ ignoreConfidential: v })))
      );
      if (!s.ignoreConfidential) sec.append(notice('ok', 'パスワード等のコピーも履歴に残ります。履歴は画面共有中に映らないよう、下の設定も確認してください'));
      root.append(sec);
      const other = section('そのほか');
      other.append(
        row('リンクプレビューを生成する', 'コピーしたリンクのページ名と画像を取得します（ログイン用などの一回限りのリンクは取得しません）', toggle(s.linkPreviews, (v) => set({ linkPreviews: v }))),
        row('画面共有中に表示', 'OFF にすると、画面共有や録画に ClipShelf の画面が映りません', toggle(s.showDuringScreenSharing, (v) => set({ showDuringScreenSharing: v })))
      );
      root.append(other);
    },

    shelf(root) {
      const s = state.settings;
      root.append(heading('シェルフ（振る舞い）', 'Yoink と同じく、ファイルをドラッグし始めると画面の端に一時置き場が出てきます。'));
      const sec = section('表示');
      sec.append(
        row('シェルフを自動的に表示する…', null, toggle(s.shelfEnabled, (v) => set({ shelfEnabled: v })),
          select([['dragStart', '…ドラッグを開始したら'], ['mouse', '…ドラッグを開始したら、マウスカーソルの位置に'], ['edge', '…マウスを画面の端までドラッグしたら']], s.shelfShowMode, (v) => set({ shelfShowMode: v })))
      );
      sec.append(notice('ok', isMac
        ? 'チェックを外しても、下のショートカットやメニューバーのアイコンから手動で表示できます。一時的に出さないようにするには、ドラッグ中に fn キーを押したままにしてください'
        : 'チェックを外しても、下のショートカットやタスクトレイのアイコンから手動で表示できます。一時的に出さないようにするには、ドラッグ中に Alt キーを押したままにしてください'));
      sec.append(
        row('シェルフを手動で表示', '長押しで直前に消したファイルを戻す、2回連続で押すとクリップボードの内容を保存', shortcutField('toggleShelf')),
        stackRow('無視するアプリ', 'ここに追加したアプリからドラッグしたときは、シェルフを自動で表示しません', appList('shelfIgnoredApps', 'アプリ名（一部でも可）'))
      );
      root.append(sec);
      const place = section('ウインドウ');
      const positions = el('div', 'positions');
      for (const [v, label] of [['left-top', '左端、上辺'], ['right-top', '右端、上辺'], ['left-center', '左端、中央'], ['right-center', '右端、中央'], ['left-bottom', '左端、下辺'], ['right-bottom', '右端、下辺']]) {
        const b = button(label, () => api.setShelfPosition(v));
        b.setAttribute('aria-pressed', String(!s.shelfCustomPosition && s.shelfPosition === v));
        positions.append(b);
      }
      place.append(
        row('ウインドウの位置', s.shelfCustomPosition ? 'ドラッグで動かした位置に表示しています' : 'シェルフの上端をドラッグして好きな場所に動かすこともできます', positions),
        row('ウインドウの大きさ', null, select([['default', 'デフォルト（3 項目）'], ['auto', '自動調整（3 項目）'], ['autoMin', '自動調整（最小）']], s.shelfSize, (v) => set({ shelfSize: v })))
      );
      if (s.shelfCustomPosition) place.append(row('動かした位置を元に戻す', null, button('元に戻す', () => api.resetShelfPosition())));
      root.append(place);

      const after = section('置いたあとの動き');
      after.append(
        row('使っていないときは画面の端に収納する', 'データを置いてマウスを離すと、シェルフが細いタブになって画面の端へ移動します。タブにマウスを乗せると開き、ドラッグを始めると上の位置に出てきます', toggle(s.shelfCollapseWhenIdle, (v) => set({ shelfCollapseWhenIdle: v }))),
        row('収納する場所', null, segmented([['right', '画面の右端'], ['left', '画面の左端'], ['same', 'シェルフと同じ側']], s.shelfParkSide, (v) => set({ shelfParkSide: v }))),
        row('作業中のディスプレイに移動する', 'サブモニターなど別のディスプレイにマウスを動かすと、シェルフもそのディスプレイへ移動します', toggle(s.shelfFollowActiveDisplay, (v) => set({ shelfFollowActiveDisplay: v })))
      );
      root.append(after);
    },

    shelfAdvanced(root) {
      const s = state.settings;
      root.append(heading('シェルフ（詳細）'));
      const sec = section('ファイルの扱い');
      sec.append(
        row('シェルフに置いたファイル', s.shelfFileMode === 'reference'
          ? '元のファイルをそのまま参照します。取り出すと Finder / エクスプローラーと同じく「移動」になります（別のディスクならコピー）'
          : 'シェルフにコピーを保管します。元のファイルを動かしても取り出せ、同期フォルダ経由で他の端末にも届きます',
        segmented([['reference', '元のファイルを参照'], ['copy', 'コピーを保管']], s.shelfFileMode, (v) => set({ shelfFileMode: v }))),
        row('ドラッグアウトしたら項目を削除', 'シェルフからドラッグして取り出した項目を、自動的にリストから削除します（鍵のアイコンで個別に残せます）', toggle(s.shelfRemoveAfterDragOut, (v) => set({ shelfRemoveAfterDragOut: v }))),
        row('複数のファイルをスタックにまとめる', '一度にドラッグした複数のファイルを1つの項目として置きます', toggle(s.shelfStackMultiple, (v) => set({ shelfStackMultiple: v }))),
        row('ファイルアイコンの代わりにクイックルックプレビューを表示', null, toggle(s.shelfQuickLookThumbnails, (v) => set({ shelfQuickLookThumbnails: v }))),
        row('追加時にエイリアス・ショートカットを実体に置き換え', null, toggle(s.shelfResolveAliases, (v) => set({ shelfResolveAliases: v })))
      );
      if (state.status && !state.status.nativeDrag && (isMac || api.platform === 'win32')) {
        sec.append(notice('warn', 'この版には「移動」用の部品が含まれていないため、取り出すと常にコピーになります（GitHub で作ったインストーラでは移動できます）'));
      }
      root.append(sec);
    },

    screenOcr(root) {
      const s = state.settings;
      root.append(heading('画面から文字を読み取る', 'ショートカットを押して範囲をドラッグすると、写っている文字をコピーします（TextSniper と同じ使い方）。'));
      const sec = section();
      sec.append(row('この機能を使う', null, toggle(s.screenOcrEnabled, (v) => set({ screenOcrEnabled: v }))));
      if (s.screenOcrEnabled) {
        sec.append(row('ショートカット', null, shortcutField('screenOcr')));
        if (isMac && state.status && state.status.screenPermission !== 'granted') {
          sec.append(notice('warn', '「画面収録」の許可が必要です', button('許可する', async () => {
            await api.primeScreenPermission();
            await api.openPrivacy('screen');
          })));
        }
        sec.append(row('いま試す', 'この画面を閉じて、範囲選択を始めます', button('試す', () => {
          window.close();
          api.triggerScreenOcr();
        })));
      }
      root.append(sec);
    },

    snap(root) {
      const s = state.settings;
      root.append(heading('ウィンドウ整列', 'いま前面にあるウィンドウを、キー操作で画面の半分・3分の1・4分の1などに並べます（Magnet と同じ使い方）。'));
      const sec = section();
      sec.append(row('この機能を使う', null, toggle(s.windowSnapEnabled, (v) => set({ windowSnapEnabled: v }))));
      if (s.windowSnapEnabled) {
        permissionNotices(sec);
        sec.append(row('動作テスト', '1.5秒後に、この設定ウィンドウを左半分に並べます', button('試す', () => api.testSnap('snapLeft'))));
        for (const action of state.info.snapActions) sec.append(row(state.info.snapLabels[action] || action, null, shortcutField(action)));
      }
      root.append(sec);
    },

    focus(root) {
      const s = state.settings;
      root.append(heading('フォーカス自動切替', 'マウスを乗せて少し待つと、そのウィンドウが前面に来ます（AutoRaise と同じ使い方）。'));
      const sec = section();
      sec.append(row('この機能を使う', '慣れるまで戸惑うことがあるので、必要な人だけONにしてください', toggle(s.focusFollowMouse.enabled, (v) => set({ focusFollowMouse: { enabled: v } }))));
      if (s.focusFollowMouse.enabled) {
        permissionNotices(sec);
        sec.append(row('切り替わるまでの待ち時間', null,
          select([[0, 'すぐ'], [150, '0.15秒'], [250, '0.25秒'], [400, '0.4秒'], [700, '0.7秒'], [1000, '1秒']], s.focusFollowMouse.delayMs, (v) => set({ focusFollowMouse: { delayMs: Number(v) } }))));
        if (!isMac) sec.append(notice('ok', 'Windows標準の「マウスポインターを置いたウィンドウをアクティブにする」設定を使っています。OFFにすると元の設定に戻します'));
        if (state.status && state.status.focusFollow.lastError) sec.append(notice('warn', `うまく動いていません: ${state.status.focusFollow.lastError}`));
      }
      root.append(sec);
    },

    keepAwake(root) {
      const s = state.settings;
      const ka = s.keepAwake;
      root.append(heading('スリープ防止', 'AIエージェントの実行中や書き出し中など、離席してもスリープさせたくないときに使います（Capsomnia と同じ使い方）。'));
      const sec = section();
      sec.append(row('この機能を使う', 'メニューバー／タスクトレイから「1時間だけ」なども選べます', toggle(ka.enabled, (v) => set({ keepAwake: { enabled: v } }))));
      if (ka.enabled) {
        const active = state.keepAwake.active;
        const until = state.keepAwake.until;
        const stText = active ? `スリープ防止中${until ? `（あと約${Math.max(1, Math.round((until - Date.now()) / 60000))}分）` : ''}` : 'OFF（通常どおりスリープします）';
        sec.append(row('いまの状態', stText,
          active ? button('OFFにする', () => api.setKeepAwake({ active: false })) : button('ONにする', () => api.setKeepAwake({ active: true }), 'btn primary'),
          active ? null : button('1時間だけ', () => api.setKeepAwake({ active: true, durationMs: 3600000 }))));
        sec.append(row('モード', null, select([['system', 'パソコンだけ起こしておく（画面は消えてOK）'], ['display', '画面もつけたままにする']], ka.mode, (v) => set({ keepAwake: { mode: v } }))));
        const capsHint = state.status && state.status.monitor && state.status.monitor.ready
          ? `Caps Lock がONの間だけスリープしません（いまのCaps Lock: ${state.status.capsLock ? 'ON' : 'OFF'}）`
          : 'Caps Lock の状態を読み取れていません（補助プロセス停止中）';
        sec.append(row('Caps Lock と連動させる', capsHint, toggle(ka.followCapsLock, (v) => set({ keepAwake: { followCapsLock: v } }))));
        sec.append(row('ON/OFF のショートカット', '任意', shortcutField('toggleKeepAwake')));
        sec.append(notice('ok', 'MacBookを外部ディスプレイなしで閉じた状態までは防げません（管理者権限が必要なため対象外）'));
      }
      root.append(sec);
    },

    async sync(root) {
      const s = state.settings;
      const sync = await api.syncInfo();
      root.append(heading('同期（自分の端末どうし）', 'Google Drive・Dropbox・iCloud Drive など「常に同期されるフォルダ」を選ぶと、自分のMac/Windows間で履歴・ピンボード・シェルフが同期されます。'));
      const sec = section();
      const controls = [button(s.syncFolder ? '変更' : 'フォルダを選ぶ', async () => {
        const folder = await api.chooseSyncFolder();
        if (folder) {
          await set({ syncFolder: folder });
          toast('同期フォルダを設定しました');
        }
      })];
      if (s.syncFolder) controls.push(button('同期をやめる', async () => {
        await set({ syncFolder: null });
        toast('この端末の保存に切り替えました');
      }));
      sec.append(row('同期フォルダ', s.syncFolder || '未設定（この端末の中だけに保存）', ...controls));
      if (s.syncFolder && !sync.available) sec.append(notice('warn', 'フォルダが見つかりません。いまはこの端末の中に保存しています（見つかり次第、自動で同期に戻ります）'));
      else if (s.syncFolder && sync.usingSync) sec.append(notice('ok', '同期中です。別の端末でも同じフォルダを選ぶと、同じ内容が表示されます'));
      if (s.shelfFileMode === 'reference') sec.append(notice('ok', 'シェルフのファイルは「元のファイルを参照」の設定のため、ファイル本体は同期されません（シェルフ → 詳細 で「コピーを保管」にすると同期されます）'));
      root.append(sec);
    },

    permissions(root) {
      root.append(heading('アクセス権', 'Mac では機能によって「システム設定 → プライバシーとセキュリティ」での許可が必要です。'));
      const sec = section();
      const st = state.status;
      if (!isMac) {
        sec.append(row('Windows では追加の許可は不要です', null));
        root.append(sec);
        return;
      }
      const stateText = (v) => (v === true || v === 'granted' ? '許可済み' : v === false || v === 'denied' ? '未許可' : '未確認');
      sec.append(
        row('アクセシビリティ', `直接貼り付け・Paste Stack・ウィンドウ整列・フォーカス自動切替に必要（${stateText(st.accessibility)}）`,
          button('許可する', async () => {
            await api.requestAccessibility();
            await api.openPrivacy('accessibility');
          })),
        row('画面収録', `画面から文字を読み取る機能に必要（${stateText(st.screenPermission)}）`, button('許可する', async () => {
          await api.primeScreenPermission();
          await api.openPrivacy('screen');
        })),
        row('オートメーション（System Events）', 'ウィンドウ整列に必要。初回に確認ダイアログが出ます', button('確認する', async () => {
          const r = await api.probeAutomation();
          toast(r.ok ? '問題ありません' : '許可が必要です');
          refresh();
        }))
      );
      fullDiskRow(sec);
      sec.append(notice('ok', 'アップデート後に効かなくなったときは、一覧で HarboR ClipShelf を一度「−」で外してから、もう一度追加してください'));
      root.append(sec);
    },

    update(root) {
      root.append(heading('アップデート', '新しい版が公開されると、メニューのアイコンとお知らせで知らせます。'));
      root.append(updateSection());
    },

    about(root) {
      const st = state.status;
      root.append(heading('情報'));
      const sec = section();
      sec.append(
        row(`HarboR ClipShelf ${state.info.version}`, `記録方式: ${st.captureMode === 'monitor' ? 'イベント監視' : '定期チェック'}　ドラッグ部品: ${st.nativeDrag ? 'あり（移動に対応）' : 'なし（コピーのみ）'}`,
          button('保存フォルダを開く', () => api.openFolder('data')),
          button('ログを開く', () => api.openFolder('logs'))),
        row('お知らせ表示と効果音のテスト', null, button('試す', () => api.testHud())),
        row('補助プロセスを再起動', 'クリップボードの記録やウィンドウ操作が止まったときに', button('再起動', async () => {
          await api.retryHelpers();
          toast('再起動しました');
        }))
      );
      if (st.windowService.helper && st.windowService.helper.failed) sec.append(notice('warn', `補助プロセスを起動できませんでした: ${st.windowService.helper.lastError || ''}`));
      root.append(sec);
    }
  };

  function retentionSelect() {
    const s = state.settings;
    return select([['day', '1日'], ['week', '1週間'], ['month', '1ヶ月'], ['year', '1年'], ['forever', '無期限']], s.historyRetention, async (v) => {
      const n = await api.retentionPreview(v);
      if (n > 0) {
        const ok = await api.confirm({
          message: '新しい履歴制限よりも古いアイテムがあります。これらの古いアイテムを削除し、新しい制限を適用しますか？',
          detail: `${n} 件が削除されます。固定されたアイテムとピンボードは削除されません。この操作は元に戻せません。`,
          ok: '削除して適用'
        });
        if (!ok) return refresh();
      }
      await set({ historyRetention: v });
    });
  }

  function permissionNotices(sec) {
    const ws = state.status && state.status.windowService;
    if (!ws) return;
    if (!ws.supported) {
      sec.append(notice('warn', 'このOSでは使えません（Mac / Windows 専用）'));
      return;
    }
    accessibilityNotice(sec, 'この機能');
    if (ws.lastProblem && ws.lastProblem.reason === 'automation') {
      sec.append(notice('warn', '「オートメーション（System Events）」の許可が必要です', button('設定を開く', () => api.openPrivacy('automation'))));
    }
    if (ws.helper && ws.helper.failed) {
      sec.append(notice('warn', `補助プロセスを起動できませんでした: ${ws.helper.lastError || ''}`, button('再試行', async () => {
        await api.retryHelpers();
        refresh();
      })));
    }
  }

  // ------------------------------------------------------------ updates
  const UPDATE_ERRORS = {
    network: 'インターネットに接続できませんでした',
    timeout: '応答がありませんでした。時間をおいて試してください',
    'not-found': '公開されている版が見つかりませんでした',
    'rate-limited': '確認が集中しています。時間をおいて試してください',
    'invalid-feed': '更新情報を読み取れませんでした',
    corrupt: 'ダウンロードしたファイルが壊れていました。もう一度試してください',
    'swap-failed': 'アプリを置き換えられませんでした。「ブラウザでダウンロード」から入れ直してください'
  };

  function planHint(u) {
    const m = u.install && u.install.method;
    if (m === 'swap') return 'ボタンを押すとダウンロードして、自動で再起動します（数十秒）';
    if (m === 'installer') return 'ダウンロード後にインストーラが開きます（このアプリはいったん終了します）';
    if (m === 'dmg') return 'ダウンロード後にこのアプリは終了します。開いた画面でアプリを「Applications」へドラッグして置き換えてください';
    return 'ブラウザでダウンロードページを開きます';
  }

  function percentOf(u) {
    const p = u.progress;
    return p && p.total ? Math.min(100, Math.floor((p.received / p.total) * 100)) : null;
  }

  function updateSection() {
    const u = state.update;
    const sec = section();
    if (!u) return sec;
    if (u.status === 'unconfigured') {
      sec.append(notice('ok', 'この版には更新の確認先が設定されていません（GitHub Actions で作ったインストーラでは自動で設定されます）'));
      return sec;
    }
    sec.append(row('新しい版を自動で確認する', '起動時と6時間ごとに確認します', toggle(u.enabled, (v) => set({ updateCheckEnabled: v }))));
    const checked = u.checkedAt ? `（確認: ${new Date(u.checkedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}）` : '';
    let label = `いまの版: v${u.current}`;
    let hint = 'まだ確認していません';
    const controls = [];
    if (u.status === 'checking') hint = '確認中…';
    else if (u.status === 'latest') hint = `最新の版です${checked}`;
    else if (u.status === 'downloading') hint = `v${u.latest.version} をダウンロード中… ${percentOf(u) ?? ''}${percentOf(u) !== null ? '%' : ''}`;
    else if (u.status === 'installing') hint = `v${u.latest.version} に切り替えています…`;
    else if (u.newer) {
      label = `新しい版 v${u.latest.version} があります`;
      hint = `いまの版: v${u.current}　${u.status === 'error' ? (UPDATE_ERRORS[u.error] || u.error) : `${planHint(u)}${u.skipped ? '（この版はスキップ中）' : ''}`}`;
    } else if (u.status === 'error') hint = `${UPDATE_ERRORS[u.error] || '確認できませんでした'}${checked}`;
    if (u.newer && ['available', 'error'].includes(u.status)) {
      controls.push(button(u.status === 'error' ? 'もう一度試す' : 'アップデート', async () => {
        const st = await api.installUpdate();
        if (st && st.status === 'error') toast(UPDATE_ERRORS[st.error] || 'アップデートに失敗しました');
      }, 'btn primary'));
      if (u.status === 'error') controls.push(button('ブラウザでダウンロード', () => api.openUpdatePage('download')));
      if (u.latest.page) controls.push(button('変更内容', () => api.openUpdatePage('release')));
      if (!u.skipped) controls.push(button('この版はスキップ', () => api.skipUpdate(u.latest.version)));
      else controls.push(button('スキップを取り消す', () => api.skipUpdate(null)));
    }
    if (!['checking', 'downloading', 'installing'].includes(u.status)) {
      controls.push(button('今すぐ確認', async () => {
        const st = await api.checkUpdate();
        if (st.status === 'latest') toast('最新の版です');
        else if (st.status === 'error') toast(UPDATE_ERRORS[st.error] || '確認できませんでした');
      }, u.newer ? 'btn' : 'btn primary'));
    }
    const r = row(label, hint, ...controls);
    if (u.status === 'downloading') {
      const bar = el('div', 'progress');
      const fill = el('span');
      fill.style.width = `${percentOf(u) || 0}%`;
      bar.append(fill);
      r.querySelector('.text').append(bar);
    }
    sec.append(r);
    if (u.newer && u.latest.notes) sec.append(el('div', 'notes', u.latest.notes));
    return sec;
  }

  // ------------------------------------------------------------ navigation / refresh
  function renderSide() {
    const side = $('side');
    const nodes = [];
    let group = null;
    for (const [id, label, g] of SECTIONS) {
      if (id === 'welcome' && state.settings.firstRunCompleted && state.section !== 'welcome') continue;
      if (g && g !== group) {
        nodes.push(el('div', 'group', g));
        group = g;
      }
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('aria-current', String(state.section === id));
      if (id === 'update' && state.update && state.update.newer && !state.update.skipped) b.append(el('span', 'badge'));
      if (id === 'permissions' && isMac && state.status && state.status.accessibility === false) b.append(el('span', 'badge'));
      b.onclick = () => go(id);
      nodes.push(b);
    }
    side.replaceChildren(...nodes);
  }

  function go(id) {
    if (!RENDER[id]) return;
    if (state.recording) state.recording.stop();
    state.section = id;
    contentEl.scrollTop = 0;
    refresh({ force: true });
  }

  async function refresh({ force = false } = {}) {
    if (state.recording) return;
    const active = document.activeElement;
    const editing = active && contentEl.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
    if (editing && !force) return;
    const token = ++state.token;
    const [status, shortcutStatus, keepAwake, update] = await Promise.all([api.systemStatus(), api.shortcutStatus(), api.getKeepAwake(), api.updateState()]);
    if (token !== state.token) return;
    state.status = status;
    state.shortcutResults = shortcutStatus.results;
    state.conflicts = shortcutStatus.conflicts || [];
    state.keepAwake = keepAwake;
    state.update = update;
    const root = document.createDocumentFragment();
    await RENDER[state.section](root);
    if (token !== state.token) return;
    const scroll = contentEl.scrollTop;
    contentEl.replaceChildren(root);
    contentEl.scrollTop = scroll;
    renderSide();
  }

  api.onSettingsSection((id) => go(id));
  if (api.onShortcutStatus) {
    api.onShortcutStatus((st) => {
      if (!st) return;
      const before = JSON.stringify(state.conflicts || []);
      state.shortcutResults = st.results || state.shortcutResults;
      state.conflicts = st.conflicts || [];
      if (before !== JSON.stringify(state.conflicts)) refresh();
    });
  }

  // 「Paste が起動中のため ⇧⌘V が使えません」
  function conflictNotices(parent, keys) {
    for (const c of (state.conflicts || []).filter((x) => !keys || keys.includes(x.key))) {
      const text = c.app
        ? `「${c.app.name}」が起動中のため、${accDisplay(c.accelerator)} を ClipShelf で使えません。${c.app.name} を終了すると自動で使えるようになります（または別のキーに変更）。`
        : `${accDisplay(c.accelerator)} は他のアプリが使用中のため、ClipShelf で使えません。そのアプリを終了するか、別のキーに変更してください。`;
      const controls = c.app && c.app.bundleId
        ? [button(`${c.app.name} を終了`, async () => {
          const ok = await api.quitConflictingApp(c.app.bundleId);
          toast(ok ? `${c.app.name} を終了しました` : `${c.app.name} を終了できませんでした`);
          refresh({ force: true });
        })]
        : [];
      parent.append(notice('warn', text, ...controls));
    }
  }

  // ⌘ フルディスクアクセス（フォルダの確認をまとめて許可）
  function fullDiskRow(parent) {
    if (!isMac) return;
    const st = state.status || {};
    const granted = st.fullDiskAccess === true;
    parent.append(row('フォルダへのアクセスをまとめて許可（フルディスクアクセス）',
      granted
        ? '許可済みです。デスクトップ・書類・ダウンロード・iCloud Drive・外付けディスクなどの確認はもう出ません'
        : '「“HarboR ClipShelf”から“デスクトップ”フォルダ内のファイルにアクセスしようとしています」などの確認を、フォルダごとではなく一度で済ませます。開いた画面の「＋」を押して HarboR ClipShelf を追加し、ON にしてください（Finder に表示したアプリをドラッグして追加することもできます）',
      granted ? el('span', 'hint', '許可済み') : button('許可する', async () => {
        await api.revealApp();
        await api.openPrivacy('fullDisk');
      })));
  }

  async function importFromPaste() {
    const r = await api.importFromPaste();
    if (!r || r.canceled) return;
    if (r.error === 'permission') {
      const ok = await api.confirm({
        message: 'Paste のデータを読むには許可が必要です',
        detail: '「フルディスクアクセス」で HarboR ClipShelf を ON にしてから、もう一度「Paste から取り込む」を押してください。設定画面を開きますか？',
        ok: '設定を開く'
      });
      if (ok) {
        await api.revealApp();
        await api.openPrivacy('fullDisk');
      }
      return;
    }
    if (r.error === 'not-found') return toast('この Mac に Paste のデータが見つかりませんでした');
    if (r.error === 'empty') return toast('Paste のデータを読み取れませんでした（ログに詳細を記録しました）');
    if (r.error === 'mac-only') return toast('Paste からの取り込みは Mac だけで使えます');
    if (r.error === 'busy') return toast('取り込み中です。しばらくお待ちください');
    if (r.error === 'failed') return toast('取り込みに失敗しました（ログに詳細を記録しました）');
    const c = r.counts;
    toast(`取り込みました：履歴 ${c.history} 件・ピンボード ${c.pinned} 件${c.pinboards ? `（新しいピンボード ${c.pinboards} 個）` : ''}${c.duplicates ? `・取り込み済み ${c.duplicates} 件` : ''}`);
    refresh({ force: true });
  }
  api.onSettingsChanged((s) => {
    state.settings = s;
    refresh({ force: true });
  });
  api.onKeepAwakeChanged(() => refresh());
  api.onUpdateState((u) => {
    const prev = state.update;
    state.update = u;
    if (state.section === 'update' && !(prev && prev.status === u.status && u.status === 'downloading')) refresh({ force: true });
    else if (state.section === 'update') {
      const fill = contentEl.querySelector('.progress > span');
      if (fill) fill.style.width = `${percentOf(u) || 0}%`;
    }
    renderSide();
  });
  api.onPauseChanged(() => refresh());
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 5000);
  document.addEventListener('keydown', (e) => {
    if (composing(e) || state.recording) return;
    if (e.key === 'Escape') window.close();
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'w') window.close();
  });

  (async function init() {
    const [info, settings] = await Promise.all([api.appInfo(), api.getSettings()]);
    state.info = info;
    state.settings = settings;
    state.section = settings.firstRunCompleted ? 'general' : 'welcome';
    await refresh({ force: true });
  })();
})();
