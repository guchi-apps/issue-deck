<#
  Windows側から wsl.exe 経由で scripts/start-issue.sh を呼び出す薄いラッパー。
  Issue番号ごとに新しいWindows Terminalタブを開き、その中でstart-issue.shを実行する。

  使い方:
    .\scripts\start-issue.ps1 <issue番号> [issue番号...]
    .\scripts\start-issue.ps1 -Distro Ubuntu 46 47
#>

param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$IssueNumbers,

    [string]$Distro = "Ubuntu",

    # WSL側から見たリポジトリのパス（既定: ~/apps/issue-deck）
    [string]$RepoPath = "~/apps/issue-deck"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    Write-Error "wt.exe (Windows Terminal) が見つかりません。Windows Terminal をインストールしてください。"
    exit 1
}

foreach ($n in $IssueNumbers) {
    if ($n -notmatch '^[0-9]+$') {
        Write-Error "issue番号は数字で指定してください: $n"
        exit 1
    }
}

foreach ($n in $IssueNumbers) {
    Write-Host "#$n : 新しいWindows Terminalタブで scripts/start-issue.sh を起動します..."
    $bashCmd = "cd $RepoPath && ./scripts/start-issue.sh $n"
    wt.exe -w 0 new-tab --title "issue-$n" -- wsl.exe -d $Distro -- bash -lc $bashCmd
}
