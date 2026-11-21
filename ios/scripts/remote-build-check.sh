#!/usr/bin/env bash
# subpc の作業ツリーの ios/ を Tailscale 越しに Mac へ送り、署名なしでビルドできるか確かめる（#3846）。
# subpc に Xcode が無いため、Swift の変更をコミットする前に「コンパイルが通るか」を見る用途。
# 署名・アーカイブ・TestFlightへのアップロードはしない（それは remote-upload-testflight.sh / CI）。
#
#   ios/scripts/remote-build-check.sh
#
# 環境変数（すべて任意）:
#   MAC_HOST      SSH先（既定 guchimac-mini）。local を指定するか、Mac 自身（Darwin）で実行するとSSHせずローカルで実行する
#   MAC_WORK_DIR  Mac 上の作業ディレクトリ（既定 /tmp/issue-deck-ios-build-check）。毎回この中身を置き換える
#
# 実機での動作（日本語入力・キーボード・TestFlightからの起動）はここでは確かめられない。
set -euo pipefail

HOST="${MAC_HOST:-guchimac-mini}"
WORK_DIR="${MAC_WORK_DIR:-/tmp/issue-deck-ios-build-check}"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Mac 自身で動いている（uname -s が Darwin）か MAC_HOST=local のときは、自分自身へ SSH せずその場で実行する
if [[ "$HOST" == "local" || "$(uname -s)" == "Darwin" ]]; then
  LOCAL=1
else
  LOCAL=0
fi

# ビルド本体。終了コードをパイプで隠さない（pipefail）。生成物は作業ディレクトリ内の DerivedData に閉じる。
# SSH 先のログインシェルは zsh で PIPESTATUS が無いため、bash -l -s へ標準入力で渡して実行する
build_script() {
  cat <<EOS
set -o pipefail
cd '$WORK_DIR/ios' || exit 1
xcodebuild \\
  -project IssueDeck.xcodeproj -scheme IssueDeck -configuration Debug \\
  -destination 'generic/platform=iOS Simulator' \\
  -derivedDataPath '$WORK_DIR/DerivedData' \\
  CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -n 8
EOS
}

if ((LOCAL)); then
  mkdir -p "$WORK_DIR/ios"
  rsync -a --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$WORK_DIR/ios/"
  build_script | bash -l -s
else
  ssh "$HOST" "mkdir -p '$WORK_DIR'"
  rsync -az --delete --exclude build --exclude DerivedData "$IOS_DIR/" "$HOST:$WORK_DIR/ios/"
  build_script | ssh "$HOST" "bash -l -s"
fi
