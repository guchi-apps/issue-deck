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

# 受け口は、プロトコル登録時にWSL側の固定の場所へ複製したものを使う（#1076）。
# リポジトリの作業ディレクトリを直接叩くと、そこが別Issueのブランチに切り替わっている間は
# ファイルが存在せず起動できない（実際に踏んだ）。
# 対象リポジトリ→ローカルのチェックアウト先の解決は、そちらの対応表が持つ。
$launcher = "~/.local/share/issue-deck/start-local-session.sh"

# 見つからない場合、bash側は終了コード127を返すだけで原因が読めない。受け口側のエラー表示
# （pause_on_error）もスクリプトが起動する前なので働かない。ここで先に確かめる。
$launcherReady = $false
try {
    & wsl.exe -d $distro -- bash -lc "test -x $launcher" 2>$null | Out-Null
    $launcherReady = ($LASTEXITCODE -eq 0)
} catch {
    $launcherReady = $false
}
if (-not $launcherReady) {
    Fail "受け口スクリプトが見つかりません（WSL: $launcher）。register-issuedeck-protocol.ps1 を実行し直してください。"
}

$bashCmd = "$launcher $owner $repo $number"

# 上の検証を通った値しか埋め込んでいないため、引用符・区切り文字が壊れる余地はない。
# タブ名は「<repo> #<Issue番号>」。複数リポジトリ・複数Issueのタブを並べても、どのリポジトリの
# どのIssueかがタブだけで分かるようにする（#1105）。ownerまで入れると幅を食うためrepoのみ。
$wtArgs = "-w 0 new-tab --title `"$repo #$number`" -- wsl.exe -d $distro -- bash -lc `"$bashCmd`""

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    Start-Process -FilePath "wt.exe" -ArgumentList $wtArgs
} else {
    # Windows Terminalが無い環境では、wsl.exeを直接起動する（タブではなく単独ウィンドウになる）。
    Start-Process -FilePath "wsl.exe" -ArgumentList "-d $distro -- bash -lc `"$bashCmd`""
}
