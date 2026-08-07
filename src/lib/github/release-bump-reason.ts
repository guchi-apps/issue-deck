const BUMP_REASON_HEADING = "## バージョンの判断根拠";

/**
 * release-develop-to-main.ymlがバンプPR本文に埋め込む「## バージョンの判断根拠」セクションの
 * テキストを抜き出す。ワークフロー側のPR本文テンプレートと対になっているため、見出し文言を
 * 変更する場合は両方を合わせて直すこと。
 */
export function extractBumpReason(body: string | null | undefined): string | null {
  if (!body) return null;

  const startIdx = body.indexOf(BUMP_REASON_HEADING);
  if (startIdx === -1) return null;

  const afterHeading = body.slice(startIdx + BUMP_REASON_HEADING.length);
  const nextHeadingMatch = /\n##\s/.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const trimmed = section.trim();
  return trimmed.length > 0 ? trimmed : null;
}
