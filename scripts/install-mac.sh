#!/bin/bash
# HarboR ClipShelf ‑ Mac 用インストーラ（社員向け）
#
# ターミナルに次の1行を貼り付けて Return:
#   curl -fsSL https://raw.githubusercontent.com/hajishohei/harbor-clipshelf/main/scripts/install-mac.sh | bash
#
# 最新版を GitHub のリリースから取得し、チェックサムを確認してから
# 「アプリケーション」フォルダに入れて起動します。再実行すると最新版に入れ替えます。
set -euo pipefail

REPO="${CLIPSHELF_REPO:-hajishohei/harbor-clipshelf}"
APP_NAME="HarboR ClipShelf"
BUNDLE_ID="com.harbor-live.clipshelf"

PROC_PATTERN="/${APP_NAME}.app/Contents/MacOS/"

say() { printf '%s\n' "$*"; }
is_running() { /usr/bin/pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; }
fail() { printf '\n⚠️  %s\n' "$*" >&2; exit 1; }

main() {
[ "$(uname -s)" = "Darwin" ] || fail "このコマンドは Mac 専用です。Windows はダウンロードページの .exe を使ってください。"

say ""
say "HarboR ClipShelf をインストールします…"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/clipshelf-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# 1. 最新版の情報（latest.json）を取得
FEED="https://github.com/${REPO}/releases/latest/download/latest.json"
curl -fsSL --retry 3 -o "$TMP/latest.json" "$FEED" || fail "最新版の情報を取得できませんでした。ネット接続を確認して、もう一度実行してください。"

INFO="$(/usr/bin/osascript -l JavaScript -e '
ObjC.import("Foundation");
function run(argv) {
  var text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (!text || text.isNil()) return "";
  var j = JSON.parse(text.js);
  var a = (j.assets || []).filter(function (x) { return x.platform === "darwin" && x.kind === "zip"; })[0];
  if (!a || !/^https:\/\//.test(a.url) || !/^[0-9a-f]{64}$/.test(a.sha256)) return "";
  return [j.version, a.url, a.sha256, Math.round((a.size || 0) / 1048576)].join("\n");
}' "$TMP/latest.json")" || true
[ -n "$INFO" ] || fail "最新版の情報を読み取れませんでした。ツールの管理担当者に連絡してください。"

VERSION="$(printf '%s\n' "$INFO" | sed -n 1p)"
URL="$(printf '%s\n' "$INFO" | sed -n 2p)"
SHA="$(printf '%s\n' "$INFO" | sed -n 3p)"
SIZE_MB="$(printf '%s\n' "$INFO" | sed -n 4p)"

# 2. ダウンロードして壊れていないか確認
say "バージョン ${VERSION} をダウンロードしています（約${SIZE_MB}MB・1〜数分）…"
curl -fL --retry 3 --progress-bar -o "$TMP/app.zip" "$URL" || fail "ダウンロードに失敗しました。もう一度実行してください。"
GOT="$(/usr/bin/shasum -a 256 "$TMP/app.zip" | awk '{print $1}')"
[ "$GOT" = "$SHA" ] || fail "ダウンロードしたファイルが壊れています（チェックサム不一致）。もう一度実行してください。"

# 3. 展開
/usr/bin/ditto -x -k "$TMP/app.zip" "$TMP/x"
[ -d "$TMP/x/${APP_NAME}.app" ] || fail "アプリが見つかりませんでした。ツールの管理担当者に連絡してください。"

# 4. 起動中なら終了
if is_running; then
  say "起動中の ${APP_NAME} を終了します…"
  /usr/bin/osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do is_running || break; sleep 1; done
  /usr/bin/pkill -f "$PROC_PATTERN" 2>/dev/null || true
  sleep 1
fi

# 5. 「アプリケーション」フォルダへ（書き込めない場合は自分用の ~/Applications）
DEST="/Applications"
if [ ! -w "$DEST" ] || { [ -e "$DEST/${APP_NAME}.app" ] && [ ! -w "$DEST/${APP_NAME}.app" ]; }; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi
TARGET="$DEST/${APP_NAME}.app"
rm -rf "$TARGET" 2>/dev/null || fail "古い ${APP_NAME} を置き換えられませんでした。Finder で「${DEST}」の ${APP_NAME} をゴミ箱に入れてから、もう一度実行してください。"
/usr/bin/ditto "$TMP/x/${APP_NAME}.app" "$TARGET" || fail "「${DEST}」にコピーできませんでした。"

# 6. 起動
/usr/bin/open "$TARGET"

say ""
say "✅ インストールが完了しました（${TARGET}）"
say ""
say "・「はじめに」の画面で「アプリに直接貼り付ける」の「許可する」を押し、"
say "  システム設定の「アクセシビリティ」で HarboR ClipShelf を ON にしてください。"
say "・画面右上のメニューバーにアイコンが出ます。⇧⌘V で履歴が開きます。"
say "・新しい版はアプリ内の「アップデート」ボタンで更新できます。"
say ""
}

main "$@"
