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

const WEBVIEW_IOS_REPOSITORIES: Readonly<Record<string, WebviewIosRepository>> = {
  "guchi-apps/myroom": {
    appLabel: "kurashio",
    xcodeProjectPath: "ios/Kurashio.xcodeproj",
    command:
      "cd ~/apps/myroom &&\ngit status --short &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nopen ios/Kurashio.xcodeproj",
    setupReferences: [
      { label: "myroom#528（初回セットアップ）", url: "https://github.com/guchi-apps/myroom/issues/528" },
      {
        label: "ios/README.md",
        url: "https://github.com/guchi-apps/myroom/blob/develop/ios/README.md",
      },
    ],
  },
};

export function getWebviewIosRepository(repositoryFullName: string): WebviewIosRepository | null {
  return WEBVIEW_IOS_REPOSITORIES[repositoryFullName] ?? null;
}
