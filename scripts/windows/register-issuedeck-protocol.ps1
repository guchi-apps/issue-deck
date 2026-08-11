<#
  issuedeck:// プロトコルをWindowsに登録する（#1049）。初回1回だけ実行する。

  使い方（Windows側のPowerShellで実行。管理者権限は不要）:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\register-issuedeck-protocol.ps1 -Unregister

  HKCU（HKEY_CURRENT_USER）配下に登録するため管理者権限は要らない。
  ハンドラ本体（issuedeck-protocol.ps1）は %LOCALAPPDATA%\issue-deck\ へ複製したうえで
  登録する。WSL上のパス（\\wsl.localhost\...）を直接登録すると、WSLが停止している状態から
  の初回起動でパス解決に失敗しうるため。issue-deck側のハンドラを更新したときは、
  このスクリプトを再実行して複製を更新する。
#>

param(
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

$registryKey = "HKCU:\Software\Classes\issuedeck"
$installDir = Join-Path $env:LOCALAPPDATA "issue-deck"
$installedHandler = Join-Path $installDir "issuedeck-protocol.ps1"

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
    exit 0
}

$sourceHandler = Join-Path $PSScriptRoot "issuedeck-protocol.ps1"
if (-not (Test-Path $sourceHandler)) {
    throw "ハンドラ本体が見つかりません: $sourceHandler"
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -Path $sourceHandler -Destination $installedHandler -Force
Write-Host "ハンドラを配置しました: $installedHandler"

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
Write-Host "確認方法: ブラウザのアドレスバーに issuedeck://start/guchi-apps/issue-deck/1 を入力する"
