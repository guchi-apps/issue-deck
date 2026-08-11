<#
  issuedeck:// プロトコルをWindowsに登録する（#1049）。初回1回だけ実行する。

  使い方（Windows側のPowerShellで実行。管理者権限は不要）:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1 -Unregister

  HKCU（HKEY_CURRENT_USER）配下に登録するため管理者権限は要らない。
  ハンドラ本体（issuedeck-protocol.ps1）は %LOCALAPPDATA%\issue-deck\ へ複製したうえで
  登録する。WSL上のパス（\\wsl.localhost\...）を直接登録すると、WSLが停止している状態から
  の初回起動でパス解決に失敗しうるため。

  受け口（scripts/start-local-session.sh）もWSL側の固定の場所へ複製する（#1076）。
  リポジトリの作業ディレクトリを直接叩く形にすると、そこが別Issueのブランチに
  切り替わっている間はファイルが存在せず起動できない。

  issue-deck側のハンドラ・受け口を更新したときは、このスクリプトを再実行して複製を更新する。
#>

param(
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

$registryKey = "HKCU:\Software\Classes\issuedeck"
$installDir = Join-Path $env:LOCALAPPDATA "issue-deck"
$installedHandler = Join-Path $installDir "issuedeck-protocol.ps1"

$distro = $env:ISSUEDECK_WSL_DISTRO
if ([string]::IsNullOrWhiteSpace($distro)) {
    $distro = "Ubuntu"
}
# WSL側で受け口スクリプトを置く場所。issuedeck-protocol.ps1 の $launcher と同じ値にする。
$launcherWslPath = "~/.local/share/issue-deck/start-local-session.sh"

if ($Unregister) {
    if (Test-Path $registryKey) {
        Remove-Item -Path $registryKey -Recurse -Force
        Write-Host "レジストリ登録を削除しました: $registryKey"
    } else {
        Write-Host "レジストリ登録は見つかりませんでした: $registryKey"
    }
    if (Test-Path $installedHandler) {
        Remove-Item -Path $installedHandler -Force
        Write-Host "ハンドラを削除しました: $installedHandler"
    }
    try {
        & wsl.exe -d $distro -- bash -lc "rm -f $launcherWslPath" 2>$null | Out-Null
        Write-Host "受け口スクリプトを削除しました: $launcherWslPath（WSL側）"
    } catch {
        Write-Warning "受け口スクリプトの削除に失敗しました: $launcherWslPath"
    }
    exit 0
}

$sourceHandler = Join-Path $PSScriptRoot "issuedeck-protocol.ps1"
if (-not (Test-Path $sourceHandler)) {
    throw "ハンドラ本体が見つかりません: $sourceHandler"
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -Path $sourceHandler -Destination $installedHandler -Force
Write-Host "ハンドラを配置しました: $installedHandler"

# Windows側のパスをWSLのパスへ読み替える。
function ConvertTo-WslPath([string]$windowsPath) {
    $full = (Resolve-Path -LiteralPath $windowsPath).ProviderPath
    # \\wsl$\<ディストロ>\... と \\wsl.localhost\<ディストロ>\... はそのまま読み替えられる。
    if ($full -match '^\\\\wsl(\$|\.localhost)\\[^\\]+\\(.*)$') {
        return '/' + ($Matches[2] -replace '\\', '/')
    }
    # Cドライブ等から実行された場合は wslpath に任せる。
    try {
        $converted = & wsl.exe -d $distro -- wslpath -u "$full" 2>$null
        if ($LASTEXITCODE -eq 0 -and $converted) {
            return ([string]($converted | Select-Object -First 1)).Trim()
        }
    } catch {
        return $null
    }
    return $null
}

$sourceLauncher = Join-Path $PSScriptRoot "..\start-local-session.sh"
if (-not (Test-Path $sourceLauncher)) {
    throw "受け口スクリプトが見つかりません: $sourceLauncher"
}
$sourceLauncherWsl = ConvertTo-WslPath $sourceLauncher
if (-not $sourceLauncherWsl) {
    Write-Warning "受け口スクリプトのWSL上のパスを特定できませんでした。WSL側で次を実行してください:"
    Write-Warning "  install -D -m 755 <リポジトリ>/scripts/start-local-session.sh $launcherWslPath"
} elseif ($sourceLauncherWsl.Contains("'")) {
    Write-Warning "複製元のパスに ' が含まれるため自動配置を見送りました: $sourceLauncherWsl"
} else {
    try {
        & wsl.exe -d $distro -- bash -lc "install -D -m 755 '$sourceLauncherWsl' $launcherWslPath" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "受け口スクリプトを配置しました: $launcherWslPath（複製元: $sourceLauncherWsl）"
        } else {
            Write-Warning "受け口スクリプトの配置に失敗しました（複製元: $sourceLauncherWsl）。"
        }
    } catch {
        Write-Warning "受け口スクリプトの配置に失敗しました（複製元: $sourceLauncherWsl）。"
    }
}

# powershell.exe の実体を絶対パスで埋め込む（レジストリからの起動時にPATHへ依存しないため）。
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path $powershell)) {
    throw "powershell.exe が見つかりません: $powershell"
}

$command = "`"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$installedHandler`" -Url `"%1`""

New-Item -Path $registryKey -Force | Out-Null
Set-ItemProperty -Path $registryKey -Name "(Default)" -Value "URL:issue-deck Local Session"
# 値が空文字の "URL Protocol" があることが、カスタムURLスキームとして扱われる条件。
Set-ItemProperty -Path $registryKey -Name "URL Protocol" -Value ""

$commandKey = "$registryKey\shell\open\command"
New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name "(Default)" -Value $command

Write-Host "登録しました: issuedeck:// → $command"
Write-Host ""
Write-Host "確認方法: ブラウザのアドレスバーに issuedeck://start/guchi-apps/issue-deck/99999 を入力する"
Write-Host "  Windows Terminalに新しいタブが開き「issue #99999 の取得に失敗しました」で止まれば、"
Write-Host "  レジストリ登録からWSLの受け口までが繋がっている。"
Write-Host "  存在しないIssue番号を使うのは、Issueの取得に失敗した時点で止まり、ブランチも"
Write-Host "  worktreeも作られないため。実在する番号を使うと、その場で実装セッションが始まる。"
