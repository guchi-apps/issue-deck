import { isTrustedGithubAuthor } from "@/lib/github/trusted-author";

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

/** 公開準備のworkflowが候補PRへ書くコメントの1行目。`v<版>`まで含めて、どの版の判定かを見分ける */
const FINALIZE_COMMENT_PREFIX = "公開準備: 正式版を **v";
/** 判断根拠の節の1行目（「〜バージョンと判定しました。」）。上げ幅は画面が別に出すので重ねない */
const FINALIZE_REASON_LEAD = /^コード差分の内容から\S+バージョンと判定しました。\s*/;
/** 判断根拠の節の末尾に続く定型文。判定の理由ではないので外す */
const FINALIZE_REASON_TRAILER = "バンプ前の検証結果は、バンプ後のheadの合否に使いません。";

export type FinalizeReasonComment = { body: string | null; login: string; association: string | null; createdAt: string };

/**
 * 公開準備（#4496）で確定した版`version`について、上げ幅の判断根拠を候補PRのコメントから抜き出す（#4937）。
 * 判断根拠はDBに保存しておらず、`reusable-release-develop-to-main.yml`の`finalize`ジョブが候補PRへ書く
 * コメントにだけ残る。**見出し・1行目の文言はworkflow側のコメント本文と対になっている**ので、変えるときは両方を直す。
 *
 * - PRはPUBLICで誰でもコメントできるため、信頼できる投稿者（`isTrustedGithubAuthor`）のものだけを読む
 * - 同じ版を予約し直してバンプし直すと複数書かれるため、最新を使う
 */
export function extractFinalizeBumpReason(comments: FinalizeReasonComment[], version: string): string | null {
  const prefix = `${FINALIZE_COMMENT_PREFIX}${version}**`;
  const matched = comments
    .filter((c) => c.body?.startsWith(prefix) && isTrustedGithubAuthor({ login: c.login, association: c.association }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const comment of matched) {
    const section = extractBumpReason(comment.body);
    if (!section) continue;
    const trailer = section.indexOf(FINALIZE_REASON_TRAILER);
    const reason = (trailer === -1 ? section : section.slice(0, trailer)).replace(FINALIZE_REASON_LEAD, "").trim();
    if (reason.length > 0) return reason;
  }
  return null;
}
