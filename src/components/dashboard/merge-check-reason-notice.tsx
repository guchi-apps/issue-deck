import { TriangleAlert } from "lucide-react";
import { Fragment } from "react";

import type { MergeCheckReasons } from "@/lib/merge-check-reasons";
import { cn } from "@/lib/utils";

/** `**強調**`を太字にする。コード以外の部分にだけ適用する */
function renderEmphasis(text: string) {
  return text.split(/\*\*([^*]+)\*\*/).map((part, index) =>
    // 奇数番目が`**`で囲まれていた部分
    index % 2 === 1 ? (
      <strong key={index} className="font-semibold">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * 理由の本文にはラベル名がバックティック付きで入り（ワークフローが書く
 * 「Issueに `22.merge-confirm-required` ラベルが付与されているため」など）、レビュー
 * エージェントが自由文で書く二次判定には`**GitHub Actionsやデプロイ設定**: …`のように
 * 該当カテゴリの強調が入る（#2062）。そのまま描くと記号が生で出るため、この2つだけを解釈する。
 * **Markdown全体は解釈しない** — ここに来るのは箇条書き1行ぶんの文で、見出しやリンクは入らない。
 */
function InlineReasonText({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, index) =>
        // 奇数番目がバックティックで囲まれていた部分
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {part}
          </code>
        ) : (
          <Fragment key={index}>{renderEmphasis(part)}</Fragment>
        ),
      )}
    </>
  );
}

/** 理由の出所を表す1行。`unknown`は出所が無いので何も出さない */
const SOURCE_LABEL: Record<MergeCheckReasons["source"], string | null> = {
  review: "自動レビューの判定",
  label: "Issueのラベルから判定",
  unknown: null,
};

/**
 * なぜ自動マージされず、ユーザーのマージ操作が必要なのかを出す（#1631）。
 *
 * 進捗ステッパーのバッジ（「ユーザー確認待ち・PRのマージ」）は**何を求めているか**しか
 * 表さず、**なぜ**はタイムラインの奥の理由コメントにしか無かった。マージボタンと同じ
 * 入れ物の中へ置くことで、押す前に理由が目に入るようにする。
 *
 * 置き場所は「マージ待ち」の3か所（PCのIssue詳細・スマホのIssue詳細・コメント欄のマージ待ち
 * カード）で、**同じ内容を同じ体裁で出す**。読む場所によって理由が違って見えないようにする。
 * 色は既存のマージ待ち表示（`IssueDetailSection`の`tone="attention"`）と同じamberで揃える。
 */
export function MergeCheckReasonNotice({
  reasons,
  className,
}: {
  reasons: MergeCheckReasons;
  className?: string;
}) {
  const sourceLabel = SOURCE_LABEL[reasons.source];

  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-md bg-amber-500/15 px-2.5 py-2 ring-1 ring-inset ring-amber-500/40",
        className,
      )}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        自動マージされなかった理由
      </p>
      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[13px] leading-relaxed">
        {reasons.items.map((item) => (
          <li key={item} className="break-words">
            <InlineReasonText text={item} />
          </li>
        ))}
      </ul>
      {sourceLabel && (
        <p className="text-[11px] text-muted-foreground">
          {sourceLabel}
          {reasons.postedAtLabel && ` · ${reasons.postedAtLabel}`}
        </p>
      )}
    </div>
  );
}
