/**
 * 手元のMacでXcodeビルドして実機へ入れるまで反映されないリポジトリ（#3468）。
 *
 * これらは`main`へのマージでは何も起こらない（`deploy.yml`が無い）。そこで
 * **「`main`にある版＝Xcodeで実機に入れた版」と運用で定義する。** Macで`command`を
 * 実行すると、`develop`の先端をXcodeで開き、実機へ入れたあとでそのコミットだけを
 * `main`へマージする（`gh pr merge --match-head-commit`。`develop`が先へ進んでいたら止まる）。
 *
 * ブランチ画面はこの表に載ったリポジトリだけ、`main`の先頭を「実機に入っている版」として
 * 出し、「本番未反映」「本番反映」の文言を`pendingLabel`・`reflectedLabel`へ置き換え、`main`へのマージボタンを出さない
 * （画面からマージすると、ビルドしていない版が実機に入ったように記録されるため）。
 *
 * **リポジトリ名の固定リストで持つ。** `Repository`に種別の列は無い
 * （`code-review-excluded-repos.ts`と同じ判断）。運用の詳細は
 * [docs/multi-agent/release.md](../../docs/multi-agent/release.md)「Xcodeで実機へ反映するリポジトリ」。
 */
export type DeviceBuildRepository = {
  /** 反映が済んでいない束の札（ビルド成否は分からない） */
  pendingLabel: string;
  /** 反映が済んだ束の日付に添える語（「◯/◯に本番反映」の「本番反映」の代わり） */
  reflectedLabel: string;
  /** Macで実行するコマンド。画面にそのままコピーできる形で出す */
  command: string;
};

const DEVICE_BUILD_REPOSITORIES: Readonly<Record<string, DeviceBuildRepository>> = {
  "guchi-apps/aide-ios": {
    pendingLabel: "実機未反映",
    reflectedLabel: "実機反映（Xcode）",
    command: "cd ~/Projects/AIDEios &&\ngit switch develop &&\ngit pull --ff-only origin develop &&\nsecurity unlock-keychain ~/Library/Keychains/login.keychain-db &&\nscripts/xcode-release.sh",
  },
};

export function getDeviceBuildRepository(
  repositoryFullName: string,
): DeviceBuildRepository | null {
  return DEVICE_BUILD_REPOSITORIES[repositoryFullName] ?? null;
}
