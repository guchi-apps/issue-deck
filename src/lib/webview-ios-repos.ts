/**
 * WebViewでネイティブアプリを包む形のiOSアプリを持つリポジトリ（#3579）。
 *
 * `guchi-apps/aide-ios`（`device-build-repos.ts`）と違い、`main`へのマージ（Web側の変更）は
 * 通常どおり`deploy.yml`が本番へ反映する。**`ios/`やアプリアイコンを変えたときだけ**、Mac mini
 * でXcodeを開いて実機へ入れ直す必要がある。
 *
 * Web側の変更か`ios/`側の変更かは自動判定しない（`ReleaseStatus`に変更ファイルの情報が無く、
 * 判定にはGitHub compare APIの追加呼び出しが要るため）。両方の手順を並べて示し、
 * どちらに当たるかは利用者が判断する。
 *
 * **リポジトリ名の固定リストで持つ。** `Repository`に種別の列は無い（`device-build-repos.ts`と
 * 同じ判断）。単に`ios/`フォルダがあるだけの対象外リポジトリを誤って拾わないため。
 */
export type WebviewIosRepository = {
  /** 画面に出すアプリ名（「kurashio」） */
  appLabel: string;
  /** Xcodeで開くプロジェクトファイルの相対パス */
  xcodeProjectPath: string;
  /** Macで実行するコマンド。画面にそのままコピーできる形で出す */
  command: string;
  /** 初回セットアップの手順が書かれたIssue・READMEへのリンク */
  setupReferences: { label: string; url: string }[];
};

/**
 * `guchi-apps/myroom`は`guchi-apps/kurashio`へリネームされた（#3594）。issue-deckの`Repository`の
 * 名前は再同期されるまで旧名のままなので、**旧名も同じ内容で引けるようにしてある**。
 * 旧名の行は再同期の完了を確かめてから消してよい。
 *
 * コマンドの`cd ~/apps/myroom`はMac mini側のチェックアウト先。ディレクトリ名はリネームで
 * 自動では変わらないため、Mac側で`~/apps/kurashio`へ移したときにここも揃える。
 */
const KURASHIO: WebviewIosRepository = {
  appLabel: "kurashio",
  xcodeProjectPath: "ios/Kurashio.xcodeproj",
  command:
    "cd ~/apps/myroom &&\ngit status --short &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nopen ios/Kurashio.xcodeproj",
  setupReferences: [
    { label: "kurashio#528（初回セットアップ）", url: "https://github.com/guchi-apps/kurashio/issues/528" },
    {
      label: "ios/README.md",
      url: "https://github.com/guchi-apps/kurashio/blob/develop/ios/README.md",
    },
  ],
};

/** yoteiflow（旧DaySpan）。kurashioと同じ契約のTestFlight自動配信を持つ（#3737） */
const YOTEIFLOW: WebviewIosRepository = {
  appLabel: "yoteiflow",
  xcodeProjectPath: "ios/YoteiFlow.xcodeproj",
  command:
    "cd ~/apps/yoteiflow &&\ngit status --short &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nopen ios/YoteiFlow.xcodeproj",
  setupReferences: [
    { label: "yoteiflow#961（TestFlight自動配信）", url: "https://github.com/guchi-apps/yoteiflow/issues/961" },
    {
      label: "ios/README.md",
      url: "https://github.com/guchi-apps/yoteiflow/blob/develop/ios/README.md",
    },
  ],
};

/** aide。ios/配下のAIDEiosをTestFlightへ自動配信する（#3834）。Mac miniのチェックアウトは`~/apps/aide` */
const AIDE: WebviewIosRepository = {
  appLabel: "aide",
  xcodeProjectPath: "ios/AIDEios.xcodeproj",
  command:
    "cd ~/apps/aide &&\ngit status --short &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nopen ios/AIDEios.xcodeproj",
  setupReferences: [
    {
      label: "ios/README.md",
      url: "https://github.com/guchi-apps/aide/blob/develop/ios/README.md",
    },
  ],
};

/** morrow。ios/配下のMorrowをTestFlightへ自動配信する（#3834）。Mac miniのチェックアウトは`~/apps/morrow` */
const MORROW: WebviewIosRepository = {
  appLabel: "morrow",
  xcodeProjectPath: "ios/Morrow.xcodeproj",
  command:
    "cd ~/apps/morrow &&\ngit status --short &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nopen ios/Morrow.xcodeproj",
  setupReferences: [
    {
      label: "ios/README.md",
      url: "https://github.com/guchi-apps/morrow/blob/develop/ios/README.md",
    },
  ],
};

const WEBVIEW_IOS_REPOSITORIES: Readonly<Record<string, WebviewIosRepository>> = {
  "guchi-apps/kurashio": KURASHIO,
  "guchi-apps/myroom": KURASHIO,
  "guchi-apps/yoteiflow": YOTEIFLOW,
  "guchi-apps/aide": AIDE,
  "guchi-apps/morrow": MORROW,
};

export function getWebviewIosRepository(repositoryFullName: string): WebviewIosRepository | null {
  return WEBVIEW_IOS_REPOSITORIES[repositoryFullName] ?? null;
}
