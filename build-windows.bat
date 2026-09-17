@echo off
chcp 65001 >nul
rem ダブルクリックで Windows 用のインストーラ（.exe）を作ります。
cd /d "%~dp0"
echo === HarboR ClipShelf : Windows版をビルドします ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。ダウンロードページを開きます。LTS版をインストールしてから、もう一度実行してください。
  start "" "https://nodejs.org/ja/download"
  pause
  exit /b 1
)
call npm ci || call npm install
if errorlevel 1 (
  echo 依存関係のインストールに失敗しました。
  pause
  exit /b 1
)
call npm run build:win
if errorlevel 1 (
  echo ビルドに失敗しました。上のメッセージをツールの管理担当者に送ってください。
  pause
  exit /b 1
)
start "" "%~dp0release"
echo.
echo 完了しました。開いたフォルダの .exe を社内に配布してください。
pause
