<#
  Windows側から wsl.exe 経由で scripts/start-reviewer.sh を呼び出す薄いラッパー。
  新しいWindows Terminalタブを1つ開き、その中でstart-reviewer.shを実行する。

  使い方:
    .\scripts\start-reviewer.ps1
    .\scripts\start-reviewer.ps1 -Distro Ubuntu
#>

param(
    [string]$Distro = "Ubuntu",

    # WSL側から見たリポジトリのパス（既定: ~/apps/issue-deck）
    [string]$RepoPath = "~/apps/issue-deck"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    Write-Error "wt.exe (Windows Terminal) が見つかりません。Windows Terminal をインストールしてください。"
    exit 1
}

Write-Host "新しいWindows Terminalタブで scripts/start-reviewer.sh を起動します..."
$bashCmd = "cd $RepoPath && ./scripts/start-reviewer.sh"
wt.exe -w 0 new-tab --title "reviewer" -- wsl.exe -d $Distro -- bash -lc $bashCmd
