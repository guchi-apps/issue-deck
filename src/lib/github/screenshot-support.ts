/**
 * 無人実行（GitHub Actions）でスクリーンショットを撮れるリポジトリの対応表（#1118）。
 *
 * `24.screenshot-required`のラベル自体は全リポジトリへ配ってあるが、**撮影が成立するのは
 * 撮る仕組みを自前で持っているリポジトリだけ**。持っていないリポジトリで選ぶと、実装は
 * 進むのに画像だけが出ないまま完了報告に至る（dayspanは全画面が認証の背後にありCIバイパスが
 * 無い、solitaireは`runtime-setup: minimal`でPlaywrightが入らない、など）。
 * ここは「そのリポジトリで撮れるか」を判定する**唯一の場所**にする。
 *
 * **一覧に載っていないリポジトリは「撮れない」として扱う。** `resolveScreenshotRejection`
 * （`src/lib/dispatch/dispatch-job.ts`）が申告の無いホストを塞がないのとは、わざと逆に倒して
 * いる。あちらの「未申告」は古いpollerであって撮れる可能性が十分あるが、こちらの「未登録」は
 * 下の2つの仕組みをどちらも置いていないということで、その状態で撮れることは無い。新しく
 * 繋いだリポジトリを黙って失敗させないことを優先する。**判定材料そのものが無いとき
 * （リポジトリ名が渡らない）だけは塞がない** ——そこは本当に「分からない」ため。
 *
 * **撮影の仕組みは2種類あり、リポジトリごとに別物。** どちらで対応と判断したかを
 * `basis`に残す（将来、同期時のGitHub API判定へ移すときの材料にもなる）。
 *
 * 1. 実装エージェントが`<package manager> run capture:issue-screenshots`を呼ぶ方式
 *    （`.github/prompts/implement.md`。issue-deck本体）
 * 2. 実装後フック`post-implement-script`で自前のスクリプトを走らせる方式
 *    （`.github/workflows/reusable-issue-dispatch.yml`。shopping-list）
 *
 * **対応表の正はここで、docsではない。** `docs/supported-repositories.md`の表と
 * `docs/multi-agent/screenshots.md`にも撮影可否の記述はあるが、画面の判定はこのファイルだけを
 * 見る。撮影に対応させたリポジトリが増えたら、まずここへ足す。
 */

/** 撮影に対応しているリポジトリ1件ぶん */
export type ScreenshotCapableRepository = {
  /** `owner/repo`形式 */
  fullName: string;
  /** 対応していると判断した材料（上記1・2のどちらか） */
  basis: string;
};

export const SCREENSHOT_CAPABLE_REPOSITORIES: readonly ScreenshotCapableRepository[] = [
  {
    fullName: "guchi-apps/issue-deck",
    basis: "`capture:issue-screenshots`のnpm scriptを持つ（`scripts/capture-issue-screenshots.sh`）",
  },
  {
    fullName: "guchi-apps/shopping-list",
    basis:
      "callerが`post-implement-script`で撮影スクリプトを指定している（`scripts/ci-post-implement.sh`）",
  },
];

/** そのリポジトリが無人実行での撮影に対応しているか */
export function isScreenshotCapableRepository(repositoryFullName: string): boolean {
  return SCREENSHOT_CAPABLE_REPOSITORIES.some((repo) => repo.fullName === repositoryFullName);
}

/**
 * そのリポジトリで`24.screenshot-required`を選べるか（#1118）。選べない理由を返し、選べるなら`null`。
 *
 * **呼ぶのは実行先がGitHub Actionsのときだけ。** サブPC・ローカルのセッションは開発サーバーを
 * tailnetへ出せるうえ、必要ならその場で手で撮れるため、この理由は当てはまらない。ホスト側の
 * 事情（Playwrightが入っていない・#1268）は`resolveScreenshotRejection`が別に見る。
 */
export function resolveScreenshotRepositoryRejection(
  repositoryFullName: string | null | undefined,
): string | null {
  // リポジトリが分からない状態で塞ぐと、読み込み中に押せないだけの時間ができる
  if (!repositoryFullName) return null;
  if (isScreenshotCapableRepository(repositoryFullName)) return null;
  return `${repositoryFullName}は無人実行での撮影に対応していないため、GitHub Actionsではスクリーンショットを取得できません（サブPC・ローカルのセッションなら実行中の画面を確認できます）。`;
}
