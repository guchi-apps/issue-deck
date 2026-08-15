/**
 * バージョンの上げ幅（#1548）。`release-develop-to-main.yml`が判定する`bump_kind`と同じ語彙で、
 * 画面から指定するときもこの3値をそのままworkflowのinputへ渡す。
 */
export type BumpKind = "major" | "minor" | "patch";

export const BUMP_KINDS: readonly BumpKind[] = ["major", "minor", "patch"];

export function isBumpKind(value: unknown): value is BumpKind {
  return typeof value === "string" && (BUMP_KINDS as readonly string[]).includes(value);
}

/**
 * 上げ幅の基準（#1548）。**文面は`reusable-release-develop-to-main.yml`の判定プロンプトに
 * 書いてある基準と同じ内容を人向けに写したもの。** 自動判定と人の指定が別の基準で動くと、
 * 「自動ならminorだが自分で選ぶとpatch」のような食い違いが起きるため、片方を直すときは
 * もう片方も揃える。
 */
export const BUMP_KIND_CRITERIA: Record<BumpKind, string> = {
  major: "既存の挙動・データ構造・公開APIに対する後方互換性のない変更が含まれるとき",
  minor: "後方互換性を保ったまま機能が追加されているとき",
  patch: "バグ修正・リファクタリング・ドキュメント更新など、上の2つに当たらない変更だけのとき",
};

/** `1.2.3`形式のバージョン文字列。前置の`v`は許容する */
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * 指定した上げ幅で次のバージョンを計算する。確認ダイアログに`3.21.0 → 3.22.0`の目安を出すためだけに
 * 使う（**実際にバージョンを書き換えるのはworkflow側の`npm version`**で、ここでの計算結果は
 * どこへも渡さない）。`1.2.3`形式として読めない場合はnullを返し、画面は目安を出さない。
 */
export function nextVersion(version: string | null, kind: BumpKind): string | null {
  if (!version) return null;
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return null;

  const [major, minor, patch] = match.slice(1, 4).map(Number);
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}
