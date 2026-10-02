/**
 * 自動レビューの指摘を「確認して、対応しない」と記録する（#3739）。
 *
 * develop向けPRの自動レビューが要確認・要修正でも、人が読んで対応しないと決めることがある。
 * 記録が無いと、リリースPR（develop→main）の検証結果に同じ指摘が毎回並び、マージ確認で止められる。
 *
 * **記録の置き場は、develop向けPRへ投稿するコメント。** DBに持つとリリースを作るワークフローから
 * 読めず、GitHub上でも追えない。コメントには次のマーカーを付ける。
 *
 * - 記録: `<!-- issue-deck-review-ack sha=<レビューしたコミット> by=<記録した人> -->`
 * - 取り消し: `<!-- issue-deck-review-ack-revoke sha=<レビューしたコミット> -->`
 *
 * **採用するのはissue-deckのApp botが投稿したコメントだけ**（`isTrustedAckAuthor`）。このリポジトリは
 * PUBLICで、誰でも同じマーカーをコメントできるため、投稿者を絞らないと第三者が本番マージ前の
 * 指摘を確認済みにできる。ワークフロー（`reusable-release-develop-to-main.yml`の「対象issueの
 * 検証結果を集計する」）は同じ条件をRESTのコメントで絞っている。**`gh --json`（GraphQL）ではbotの
 * loginが`issue-deck`になり`[bot]`が付かないので、そちらでは絞れない**。
 *
 * **`sha`はレビューが指したコミット。** 追いコミットで再レビューされると別のshaになり、前の記録は
 * 効かなくなる（直した後の新しい指摘を、以前の「対応しない」で素通りさせないため）。
 *
 * 文字列は`scripts/check-review-verdict-marker.sh`がワークフローと突き合わせる。
 */

/** 記録・取り消しのコメントに付ける印。ワークフローと対（CIで突き合わせる） */
export const REVIEW_ACK_MARKER_PREFIX = "issue-deck-review-ack";
const ACK_PATTERN = /<!--\s*issue-deck-review-ack\s+sha=([0-9a-fA-F]+)(?:\s+by=(\S+))?\s*-->/;
const REVOKE_PATTERN = /<!--\s*issue-deck-review-ack-revoke\s+sha=([0-9a-fA-F]+)\s*-->/;

/** 理由の上限。コメントとPR本文の肥大を避ける */
export const REVIEW_ACK_REASON_MAX_LENGTH = 500;

/** 記録できる判定。要確認・要修正だけ（問題なし・レビューなしに「対応しない」は要らない） */
export type AcknowledgeableVerdict = "needs-check" | "changes-requested";

const VERDICT_LABEL: Record<AcknowledgeableVerdict, string> = {
  "needs-check": "要確認",
  "changes-requested": "要修正",
};
const VERDICT_MARK: Record<AcknowledgeableVerdict, string> = {
  "needs-check": "⚠️",
  "changes-requested": "❌",
};

export type ReviewAcknowledgement = {
  sha: string;
  /** 記録した人のGitHubログイン。マーカーに無ければnull */
  recordedBy: string | null;
};

/** 理由を1コメントに収まる形へ整える。HTMLコメントを閉じる`-->`は、マーカーの読み取りを壊すため落とす */
export function sanitizeAckReason(reason: string): string {
  return reason
    .replace(/<!--|-->/g, "")
    .trim()
    .slice(0, REVIEW_ACK_REASON_MAX_LENGTH);
}

/** 記録のコメント本文 */
export function buildAckComment(params: {
  sha: string;
  recordedBy: string;
  verdict: AcknowledgeableVerdict;
  reason: string;
}): string {
  const reason = sanitizeAckReason(params.reason);
  return [
    `<!-- ${REVIEW_ACK_MARKER_PREFIX} sha=${params.sha} by=${params.recordedBy} -->`,
    `自動レビューの指摘（${VERDICT_LABEL[params.verdict]}）を確認し、**対応しない**と記録しました（記録: @${params.recordedBy}）。`,
    "",
    `理由: ${reason || "（未記入）"}`,
    "",
    "追いコミットで再レビューされた場合、この記録は引き継がれません。",
  ].join("\n");
}

/** 取り消しのコメント本文 */
export function buildRevokeComment(params: { sha: string; revokedBy: string }): string {
  return [
    `<!-- ${REVIEW_ACK_MARKER_PREFIX}-revoke sha=${params.sha} -->`,
    `「対応しない」の記録を取り消しました（取り消し: @${params.revokedBy}）。`,
  ].join("\n");
}

/**
 * そのコメントを記録として採用してよい投稿者か。REST形式（`user.login`・`user.type`）で渡す。
 * `slug`はApp名（`NEXT_PUBLIC_GITHUB_APP_SLUG`）。
 */
export function isTrustedAckAuthor(
  author: { login: string; type?: string | null },
  slug: string | undefined,
): boolean {
  if (!slug) return false;
  return author.login === `${slug}[bot]` && author.type === "Bot";
}

export type AckCommentSource = {
  body: string | null;
  author: { login: string; type?: string | null };
};

/**
 * コメント列（古い順）から、指定のレビューshaに対する現在の記録を返す。無ければnull。
 * 記録と取り消しは後勝ち。信頼できない投稿者・別のshaのコメントは読まない。
 */
export function currentAcknowledgement(
  comments: readonly AckCommentSource[],
  reviewedSha: string,
  slug: string | undefined,
): ReviewAcknowledgement | null {
  const target = reviewedSha.toLowerCase();
  let current: ReviewAcknowledgement | null = null;
  for (const comment of comments) {
    if (!comment.body || !isTrustedAckAuthor(comment.author, slug)) continue;
    const revoke = REVOKE_PATTERN.exec(comment.body);
    if (revoke && revoke[1].toLowerCase() === target) {
      current = null;
      continue;
    }
    const ack = ACK_PATTERN.exec(comment.body);
    if (ack && ack[1].toLowerCase() === target) {
      current = { sha: ack[1], recordedBy: ack[2] ?? null };
    }
  }
  return current;
}

/**
 * リリースPR本文の検証結果の表で、確認済みの行に書くセル。
 * **先頭は✅**（画面は先頭の記号で判定を読む）。`reusable-release-develop-to-main.yml`が同じ文言を書く。
 */
export function acknowledgedCell(verdict: AcknowledgeableVerdict, recordedBy: string | null): string {
  const by = recordedBy ? `、記録: ${recordedBy}` : "";
  return `✅ 確認済み（元の判定: ${VERDICT_LABEL[verdict]}${by}）`;
}

/** 記録を取り消したときに戻すセル */
export function unacknowledgedCell(verdict: AcknowledgeableVerdict): string {
  return `${VERDICT_MARK[verdict]} ${VERDICT_LABEL[verdict]}`;
}

const ACKNOWLEDGED_CELL_PATTERN = /^確認済み（元の判定: (要確認|要修正)(?:、記録: ([^）]+))?）$/;

/** 表のセル（先頭の記号を落としたもの）が確認済みの記録なら、元の判定と記録者を返す */
export function parseAcknowledgedCell(
  label: string,
): { verdict: AcknowledgeableVerdict; recordedBy: string | null } | null {
  const matched = ACKNOWLEDGED_CELL_PATTERN.exec(label.trim());
  if (!matched) return null;
  return {
    verdict: matched[1] === "要確認" ? "needs-check" : "changes-requested",
    recordedBy: matched[2] ?? null,
  };
}

/**
 * リリースPR本文で、指定Issueの行を確認済み（またはその取り消し）に書き換える。
 * 対象の行が見つからない・既に同じ状態のときはnull（書き換えない）。
 *
 * 書き換えるのは表のセルと、レビュー本文の折りたたみの見出し（`<summary>#N の自動レビュー（…）`）。
 * 「#N で修正済み」など、要確認・要修正で始まらないセルには触れない。
 */
export function applyAcknowledgementToReleaseBody(
  body: string,
  issueNumber: number,
  change:
    | { type: "acknowledge"; verdict: AcknowledgeableVerdict; recordedBy: string }
    | { type: "revoke" },
): string | null {
  const lines = body.split("\n");
  const rowPrefix = new RegExp(`^\\|\\s*#${issueNumber}\\s*\\|`);
  const summaryPattern = new RegExp(`^(<summary>#${issueNumber} の自動レビュー（)(.*)(）</summary>)\\s*$`);
  let changed = false;

  const nextCell = (cell: string): string | null => {
    if (change.type === "acknowledge") {
      const verdict = Object.entries(VERDICT_MARK).find(([, mark]) => cell.startsWith(mark));
      if (!verdict) return null;
      return acknowledgedCell(verdict[0] as AcknowledgeableVerdict, change.recordedBy);
    }
    const acknowledged = parseAcknowledgedCell(cell.replace(/^✅\s*/, ""));
    if (!acknowledged) return null;
    return unacknowledgedCell(acknowledged.verdict);
  };

  const result = lines.map((line) => {
    if (rowPrefix.test(line)) {
      const cells = line.split("|");
      // `| #N | PR | 自動レビュー | リスク |` → 先頭と末尾の空要素を含めて6要素
      if (cells.length >= 6) {
        const replaced = nextCell(cells[3].trim());
        if (replaced) {
          cells[3] = ` ${replaced} `;
          changed = true;
          return cells.join("|");
        }
      }
      return line;
    }
    const summary = summaryPattern.exec(line);
    if (summary) {
      const replaced = nextCell(summary[2].trim());
      if (replaced) {
        changed = true;
        return `${summary[1]}${replaced}${summary[3]}`;
      }
    }
    return line;
  });

  return changed ? result.join("\n") : null;
}
