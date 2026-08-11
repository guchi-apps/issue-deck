<#
  issuedeck:// URLを受け取り、WSL上のClaude Codeセッションを起動するプロトコルハンドラ（#1049）。

  呼び出し経路:
    issue-deckの画面の「ローカルで開始」
      → issuedeck://start/<owner>/<repo>/<番号>
      → （Windowsのレジストリ登録経由で）このスクリプト
      → wt.exe → wsl.exe → <repo>/scripts/start-local-session.sh
      → scripts/start-issue.sh

  登録は scripts/windows/register-issuedeck-protocol.ps1 で行う（このファイルを
  %LOCALAPPDATA%\issue-deck\ へ複製したうえでHKCUに登録する）。

  重要: プロトコルが登録されていると、このスクリプトは**任意のWebページ**から
  任意の文字列を引数にして呼び出されうる。URLは必ず下の正規表現で全体を検証し、
  検証を通った値以外はコマンドラインへ一切埋め込まない。
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Url
)

$ErrorActionPreference = "Stop"

function Fail([string]$message) {
    Write-Host "エラー: $message" -ForegroundColor Red
    Write-Host "URL: $Url"
    Read-Host "Enterで閉じます"
    exit 1
}

# 全体一致で検証する。ここを通った owner/repo/number は英数字・`.`・`_`・`-`・数字のみで、
# 空白・引用符・`;`（Windows Terminalのサブコマンド区切り）・シェルのメタ文字を含まない。
# 末尾スラッシュは、ブラウザがURLを正規化して付けてくる場合があるため許容する。
$pattern = '^issuedeck://start/(?<owner>[A-Za-z0-9._-]{1,100})/(?<repo>[A-Za-z0-9._-]{1,100})/(?<number>[1-9][0-9]{0,9})/?$'
$match = [regex]::Match($Url, $pattern)
if (-not $match.Success) {
    Fail "URLの形式が正しくありません（想定: issuedeck://start/<owner>/<repo>/<issue番号>）"
}

$owner = $match.Groups["owner"].Value
$repo = $match.Groups["repo"].Value
$number = $match.Groups["number"].Value

# `.` を許可文字に含めているため `.` `..` 自体は上の正規表現を通る。パスの一部として
# 使われるので明示的に弾く（WSL側の start-local-session.sh でも同じ判定をしている）。
if ($owner -match '^\.+$' -or $repo -match '^\.+$') {
    Fail "owner・repoにディレクトリ参照は指定できません: $owner/$repo"
}

$distro = $env:ISSUEDECK_WSL_DISTRO
if ([string]::IsNullOrWhiteSpace($distro)) {
    $distro = "Ubuntu"
}

# 受け口は常にissue-deck側の start-local-session.sh に固定する。
# 対象リポジトリ→ローカルのチェックアウト先の解決は、そちらの対応表が持つ。
$bashCmd = "~/apps/issue-deck/scripts/start-local-session.sh $owner $repo $number"

# 上の検証を通った値しか埋め込んでいないため、引用符・区切り文字が壊れる余地はない。
$wtArgs = "-w 0 new-tab --title issue-$number -- wsl.exe -d $distro -- bash -lc `"$bashCmd`""

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    Start-Process -FilePath "wt.exe" -ArgumentList $wtArgs
} else {
    # Windows Terminalが無い環境では、wsl.exeを直接起動する（タブではなく単独ウィンドウになる）。
    Start-Process -FilePath "wsl.exe" -ArgumentList "-d $distro -- bash -lc `"$bashCmd`""
}
