# HarboR ClipShelf - Windows 用インストーラ（社員向け）
#
# PowerShell（Windows ターミナル）に次の1行を貼り付けて Enter:
#   irm https://raw.githubusercontent.com/hajishohei/harbor-clipshelf/main/scripts/install-windows.ps1 | iex
#
# 最新版を GitHub のリリースから取得し（x64 / ARM を自動判別）、チェックサムを
# 確認してから、管理者権限なしでインストールして起動します。再実行すると最新版に更新します。
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue' # Windows PowerShell 5.1 のダウンロードを速くする
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

    $repo = if ($env:CLIPSHELF_REPO) { $env:CLIPSHELF_REPO } else { 'hajishohei/harbor-clipshelf' }
    $appName = 'HarboR ClipShelf'

    function Fail([string]$message) {
        Write-Host ''
        Write-Host "[!] $message" -ForegroundColor Yellow
        throw $message
    }

    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Fail 'このコマンドは Windows 専用です。Mac はターミナル用の1行を使ってください。' }

    Write-Host ''
    Write-Host "$appName をインストールします…"

    # 1. 最新版の情報
    $feedUrl = if ($env:CLIPSHELF_FEED) { $env:CLIPSHELF_FEED } else { "https://github.com/$repo/releases/latest/download/latest.json" }
    try {
        $feed = Invoke-RestMethod -Uri $feedUrl -UseBasicParsing
    } catch {
        Fail '最新版の情報を取得できませんでした。ネット接続を確認して、もう一度実行してください。'
    }

    # 2. このPCに合うインストーラ（ARM 版 Windows → arm64、それ以外 → x64）
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = if ($cpu -eq 'ARM64') { 'arm64' } else { 'x64' }
    $candidates = @($feed.assets | Where-Object { $_.platform -eq 'win32' -and $_.kind -eq 'exe' })
    $asset = $candidates | Where-Object { $_.arch -eq $arch } | Select-Object -First 1
    if (-not $asset) { $asset = $candidates | Where-Object { $_.arch -eq 'x64' } | Select-Object -First 1 }
    if (-not $asset) { $asset = $candidates | Select-Object -First 1 }
    if (-not $asset -or $asset.url -notmatch '^https://' -or $asset.sha256 -notmatch '^[0-9a-f]{64}$') {
        Fail '最新版の情報を読み取れませんでした。ツールの管理担当者に連絡してください。'
    }
    $sizeMb = [math]::Round($asset.size / 1MB)
    Write-Host "バージョン $($feed.version)（$($asset.arch) 版・約${sizeMb}MB）をダウンロードしています…"

    # 3. ダウンロードして壊れていないか確認
    $setup = Join-Path ([IO.Path]::GetTempPath()) ("HarboR-ClipShelf-Setup-{0}-{1}.exe" -f $feed.version, [Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        Invoke-WebRequest -Uri $asset.url -OutFile $setup -UseBasicParsing
    } catch {
        Fail 'ダウンロードに失敗しました。もう一度実行してください。'
    }
    $hash = (Get-FileHash -Path $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $asset.sha256.ToLowerInvariant()) {
        Remove-Item -Path $setup -Force -ErrorAction SilentlyContinue
        Fail 'ダウンロードしたファイルが壊れています（チェックサム不一致）。もう一度実行してください。'
    }

    if ($env:CLIPSHELF_DRYRUN) {
        Write-Host "（確認のみ）$setup"
        Remove-Item -Path $setup -Force -ErrorAction SilentlyContinue
        return
    }

    # 4. 起動中なら終了
    $running = Get-Process -Name $appName -ErrorAction SilentlyContinue
    if ($running) {
        Write-Host "起動中の $appName を終了します…"
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    # 5. インストール（ユーザー単位・管理者権限なし・画面なし）
    Write-Host 'インストールしています…'
    $proc = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
    Remove-Item -Path $setup -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) { Fail "インストールに失敗しました（コード $($proc.ExitCode)）。もう一度実行してください。" }

    # 6. インストール先を探して起動
    $exe = $null
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($k in $keys) {
        $entry = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$appName*" -and $_.InstallLocation } | Select-Object -First 1
        if ($entry) {
            $candidate = Join-Path $entry.InstallLocation "$appName.exe"
            if (Test-Path $candidate) { $exe = $candidate; break }
        }
    }
    if (-not $exe) {
        $fallback = Join-Path $env:LOCALAPPDATA "Programs\$appName\$appName.exe"
        if (Test-Path $fallback) { $exe = $fallback }
    }
    if (-not $exe) { Fail 'インストール先が見つかりませんでした。スタートメニューから HarboR ClipShelf を開いてください。' }

    Start-Sleep -Seconds 1
    if (-not (Get-Process -Name $appName -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $exe
    }

    Write-Host ''
    Write-Host "インストールが完了しました（$exe）" -ForegroundColor Green
    Write-Host ''
    Write-Host '・画面右下（タスクトレイ）にアイコンが出ます。Ctrl+Shift+V で履歴が開きます。'
    Write-Host '・「はじめに」の画面で「使ってみる」を押してください。'
    Write-Host '・新しい版はアプリ内の「アップデート」ボタンで更新できます。'
    Write-Host ''
}
