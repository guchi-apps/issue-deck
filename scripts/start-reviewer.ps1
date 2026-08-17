<#
  Windows側から wsl.exe 経由で scripts/start-reviewer.sh を呼び出す薄いラッパー。
  新しいWindows Terminalタブを1つ開き、その中でstart-reviewer.shを実行する。

  使い方:
    .\scripts\start-reviewer.ps1                成果物の関門（G2）。develop向けの未処理PRを見てマージする
    .\scripts\start-reviewer.ps1 -Plan 1218     計画の関門（G1）。Issueの計画をリポジトリの実態と突き合わせる
    .\scripts\start-reviewer.ps1 -Distro Ubuntu
#>

param(
    [string]$Distro = "Ubuntu",

    # WSL側から見たリポジトリのパス（既定: ~/apps/issue-deck）
    [string]$RepoPath = "~/apps/issue-deck",

    # 指定するとそのIssueの計画レビュー（G1・#1218）として起動する。未指定なら従来どおりG2。
    [int]$Plan = 0
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command wt.exe -ErrorAction SilentlyContinue)) {
    Write-Error "wt.exe (Windows Terminal) が見つかりません。Windows Terminal をインストールしてください。"
    exit 1
}

if ($Plan -gt 0) {
    $tabTitle = "plan-review #$Plan"
    $reviewerArgs = "--plan $Plan"
} else {
    $tabTitle = "reviewer"
    $reviewerArgs = ""
}

Write-Host "新しいWindows Terminalタブで scripts/start-reviewer.sh $reviewerArgs を起動します..."
$bashCmd = "cd $RepoPath && ./scripts/start-reviewer.sh $reviewerArgs"
wt.exe -w 0 new-tab --title $tabTitle -- wsl.exe -d $Distro -- bash -lc $bashCmd
