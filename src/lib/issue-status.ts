import { isCheckUserReasonLabel } from "@/lib/github/approval-labels";

// 01〜09番台の数字プレフィックスを持つラベル（"02.wip"など）は、かつてIssueの進行状況を
// 示すステップ運用として使われていた。#991 Phase 5（#1010）で廃止済みだが、導入前の世代の
// ラベルが残るリポジトリを取り込んだときに現れ得るため、判定自体は残してある
// （docs/multi-agent/labels.md参照）。
// 00番台はステップではなく「要対応」を示す横断的なフラグ用途（例: 00.check-user）として
// 現役で使われている。
const STATUS_STEP_PATTERN = /^0([1-9])\./;
const ATTENTION_PATTERN = /^00\./;

export const STATUS_STEP_MAX = 9;

/**
 * 廃止済みの進捗ステップラベルなら、そのステップ番号を返す。
 *
 * **`01.check-*`（`00.check-user`の理由ラベル。#1490）は番号の形が同じでもステップではない。**
 * 除外しないと詳細のラベル欄に「ステップ1/9」の進捗バーとツールチップが誤って描画される。
 */
export function matchStatusStep(labelName: string): number | null {
  if (isCheckUserReasonLabel(labelName)) return null;
  const match = STATUS_STEP_PATTERN.exec(labelName);
  return match ? Number(match[1]) : null;
}

/** 00番台の「要対応」ラベル、または`00.check-user`の理由を表す`01.check-*`ラベルかどうか */
export function isAttentionLabel(labelName: string): boolean {
  return ATTENTION_PATTERN.test(labelName) || isCheckUserReasonLabel(labelName);
}

/** 要対応ラベル、または廃止済みの01〜09番台の進捗ラベルかどうかを判定する（人が選ぶ対象から外すため） */
export function isProgressLabel(labelName: string): boolean {
  return isAttentionLabel(labelName) || matchStatusStep(labelName) !== null;
}

// ラベル自動付与（Issue本文からClaudeにタイトル・ラベルを推定させる機能）の対象範囲（#1662）。
// 30〜89番台は不具合・新機能・デザイン・優先度といった「本文の内容から決まる」分類で、
// ここだけが推定に向く。それ以外は運用の都合で人やワークフローが付けるものなので外す。
const AUTO_ASSIGNABLE_MIN_BAND = 30;
// 上限に優先度（`80.`/`89.`）を含めるのは#1702の決定。優先度はバックログ全体との相対で決まる
// 予定判断で本来は推定に向かないが、本文へ緊急性が書かれているときに拾える利便を優先した。
// 外せば範囲が30〜70番台の連続した帯になり下の除外も不要になるが、整理のために機能は削らない。
const AUTO_ASSIGNABLE_MAX_BAND = 89;
// 71番台（`71.manual-step`）は、タイトルが`[手作業]`で始まるIssueへ`reusable-issue-labels.yml`の
// `manual-step-label`ジョブが付けるルールベースのラベル（docs/multi-agent/labels.md参照）。
// 推定で付くと「ユーザーの作業待ち」ビューへ紛れ込み、Issue詳細から実装の導線が消える。
// **この例外は恒久的な仕様**（#1702）。`71.manual-step`を実行状態の帯（`11.local`の隣）へ移して
// 例外を無くす案は、約70か所の参照・8リポジトリのラベル改名・14リポジトリへの
// `reusable-issue-labels.yml`再配布に見合わないため見送っている。
const AUTO_ASSIGNABLE_EXCLUDED_BAND = 71;
const NUMBER_BAND_PATTERN = /^(\d{2})\./;

/**
 * ラベル自動付与（Claudeによるタイトル・ラベル生成）の対象にしてよいラベルかどうか（#1662）。
 *
 * **番号プレフィックスを持たないラベルは対象外。** issue-deckのラベル体系を配っていない
 * リポジトリに残るGitHub既定の`bug`・`enhancement`等は、番号帯で性質を判別できないため
 * 推定に載せない（そのリポジトリでは自動生成がラベルを付けず、タイトルだけを生成する）。
 */
export function isAutoAssignableLabelName(labelName: string): boolean {
  const match = NUMBER_BAND_PATTERN.exec(labelName);
  if (!match) return false;
  const band = Number(match[1]);
  if (band === AUTO_ASSIGNABLE_EXCLUDED_BAND) return false;
  return band >= AUTO_ASSIGNABLE_MIN_BAND && band <= AUTO_ASSIGNABLE_MAX_BAND;
}
