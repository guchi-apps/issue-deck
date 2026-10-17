"use client";

import type { RcCandidateView } from "@/lib/release-rc-run";
import { describeRcPrimaryAction } from "@/lib/release-rc-action";

/**
 * 候補の現在状態と次の操作を1つのカードにまとめる（#4635。スマホのリリースシート用）。
 * 主操作そのもの（公開準備・本番公開）は別の部品が持つので、ここでは**いまの工程で何をするか**を短く示す。
 * 失敗・取得不能・記録との食い違いがあるときは「操作不要・自動で進む」と言わない
 */
export function ReleaseRcNextStep({ candidate }: { candidate: RcCandidateView }) {
  const { status } = candidate;
  const action = describeRcPrimaryAction({ status: status.status, publishable: false });
  const stuck = status.attention !== null;
  let next: string;
  if (action.kind === "recheck_production") {
    // 稼働確認の停止（#4712）。自動では進まないので「操作不要」と言わず、原因を直す操作を出す
    next = `${status.reason}（公開準備パネルの「稼働確認をやり直す」で確かめ直せます）`;
  } else if (stuck) {
    next = "状態を確認してください。記録と実際の候補が食い違っているため、先へは進めません。";
  } else if (action.kind === "prepare") {
    next = "全体レビュー・統合検証に合格しました。「本番公開へ進む（公開承認）」を押すと、正式バンプと最終検証のあと自動で本番公開します。";
  } else if (action.kind === "fix" || action.kind === "rerun_review") {
    next = "検証の失敗・指摘が出ています。下の結果を確認し、再実行するか修正を取り込んでください。";
  } else if (status.status === "awaiting_approval" && status.label === "自動公開待ち") {
    next = "操作は不要です。公開承認済みのため、mainへのマージ・本番反映・稼働確認まで自動で進みます。";
  } else if (status.status === "awaiting_approval") {
    next = "最終検証まで合格しました。この候補には公開承認の記録が無いため、本番PRの詳細で内容を確かめて1回だけ承認してください。";
  } else if (action.kind === "wait") {
    next = "操作は不要です。自動で進みます。";
  } else {
    next = "進める操作はありません。";
  }
  return (
    <section aria-label="現在の候補の状態と次の操作" className="flex flex-col gap-1 rounded-[10px] border-2 border-primary/60 bg-card p-3 text-sm" data-testid="release-rc-next-step">
      <p className="font-semibold">
        {candidate.label} ・ revision {candidate.currentRevision} <span className="ml-1 rounded bg-muted px-1.5 text-xs">{status.label}</span>
      </p>
      <p className="break-words text-xs text-muted-foreground">{status.attention ?? status.reason}</p>
      <p className="break-words text-sm font-medium" data-testid="release-rc-next-step-action">
        次の操作: {next}
      </p>
    </section>
  );
}
