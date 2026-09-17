#!/bin/bash
# ダブルクリックで Mac 用のインストーラ（.dmg）を作ります。
cd "$(dirname "$0")" || exit 1
echo "=== HarboR ClipShelf : Mac版をビルドします ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。ブラウザでダウンロードページを開きます（LTS版をインストールしてから、もう一度ダブルクリックしてください）。"
  open "https://nodejs.org/ja/download"
  read -r -p "Enterキーで閉じます" _
  exit 1
fi
echo "Node.js $(node -v)"
(npm ci || npm install) || { read -r -p "依存関係のインストールに失敗しました。Enterキーで閉じます" _; exit 1; }
npm run build:mac || { read -r -p "ビルドに失敗しました。上のメッセージをツールの管理担当者に送ってください。Enterキーで閉じます" _; exit 1; }
open release
echo ""
echo "完了しました。開いたフォルダの .dmg を社内に配布してください。"
read -r -p "Enterキーで閉じます" _
