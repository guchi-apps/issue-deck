const BUMP_REASON_HEADING = "## バージョンの判断根拠";
const BUMP_CHANGELOG_HEADING = "## 更新履歴（生成された利用者向け文言）";
const BUMP_USAGE_HEADING = "## 使い方（生成された利用者向け文言）";

function extractSection(body: string | null | undefined, heading: string): string | null {
  if (!body) return null;

  const startIdx = body.indexOf(heading);
  if (startIdx === -1) return null;

  const afterHeading = body.slice(startIdx + heading.length);
  const nextHeadingMatch = /\n##\s/.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const trimmed = section.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * release-develop-to-main.ymlがバンプPR本文に埋め込む「## バージョンの判断根拠」セクションの
 * テキストを抜き出す。ワークフロー側のPR本文テンプレートと対になっているため、見出し文言を
 * 変更する場合は両方を合わせて直すこと。
 */
export function extractBumpReason(body: string | null | undefined): string | null {
  return extractSection(body, BUMP_REASON_HEADING);
}

/**
 * release-develop-to-main.ymlがバンプPR本文に埋め込む「## 更新履歴（生成された利用者向け文言）」
 * セクションのテキストを抜き出す。チェンジログファイルを持たないリポジトリ（"version" npm
 * lifecycleスクリプトが未定義のリポジトリ）ではこのセクション自体がPR本文に現れないためnullを返す。
 * ワークフロー側のPR本文テンプレートと対になっているため、見出し文言を変更する場合は両方を
 * 合わせて直すこと。
 */
export function extractBumpChangelog(body: string | null | undefined): string | null {
  return extractSection(body, BUMP_CHANGELOG_HEADING);
}

/**
 * release-develop-to-main.ymlがバンプPR本文に埋め込む「## 使い方（生成された利用者向け文言）」
 * セクションのテキストを抜き出す（#1729）。更新履歴が「何が変わったか」であるのに対し、
 * こちらは「どこを開く・何を押す・どうなれば成功か」という操作手順。
 *
 * **画面で使える変化が無いリリースではセクション自体が現れない**ためnullを返す。更新履歴と違い、
 * `version` lifecycleスクリプトの有無ではなくリリース内容で出たり出なかったりする。
 * ワークフロー側のPR本文テンプレートと対になっているため、見出し文言を変更する場合は両方を
 * 合わせて直すこと。
 */
export function extractBumpUsage(body: string | null | undefined): string | null {
  return extractSection(body, BUMP_USAGE_HEADING);
}
