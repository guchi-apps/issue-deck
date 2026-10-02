"use client";

import { CheckCheck, ChevronDown, ChevronRight, FilePlus2, Undo2 } from "lucide-react";
import { useState } from "react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { ReleaseRebuildButton } from "@/components/dashboard/release-rebuild-button";
import { VerdictText } from "@/components/dashboard/review-verdict";
import { Button } from "@/components/ui/button";
import type {
  ReleaseVerification,
  ReleaseVerificationRow,
  ReviewVerdictKind,
} from "@/lib/github/release-verification";
import { cn } from "@/lib/utils";

/**
 * 1件ぶんの行。レビュー本文が載っている場合（#2488）は開いて読めるようにする。
 *
 * **既定は閉じたまま。** リリースには10件以上のIssueが載ることがあり、全部を開いて出すと
 * 「何件のうち何件が問題なしか」を先に読むためのこの帯が、本文と同じ長さになってしまう。
 */
/** 「修正をIssueにする」ボタンを出す判定（#2838）。それ以外の判定では現状の見た目を変えない */
function canRequestFixIssue(kind: ReviewVerdictKind): boolean {
  return kind === "changes-requested" || kind === "needs-check";
}

/** 「確認済み・対応しない」を出す判定（#3739）。要確認・要修正の行だけ */
function canAcknowledge(kind: ReviewVerdictKind): boolean {
  return kind === "changes-requested" || kind === "needs-check";
}

function Row({
  row,
  repositoryFullName,
  onCreateFixIssue,
  onAcknowledge,
  onRevokeAcknowledgement,
}: {
  row: ReleaseVerificationRow;
  repositoryFullName: string;
  /** 指摘を新規Issueの下書きにして開く（#2838）。渡さない画面ではボタンを出さない */
  onCreateFixIssue?: (row: ReleaseVerificationRow) => void;
  /** 指摘を確認して「対応しない」と記録する（#3739）。理由を添えて呼ぶ。渡さない画面ではボタンを出さない */
  onAcknowledge?: (row: ReleaseVerificationRow, reason: string) => Promise<void>;
  /** 記録を取り消す */
  onRevokeAcknowledgement?: (row: ReleaseVerificationRow) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isAcknowledging, setIsAcknowledging] = useState(false);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const showAcknowledgeButton =
    onAcknowledge !== undefined && row.acknowledgement === null && canAcknowledge(row.reviewKind);
  const showRevokeButton = onRevokeAcknowledgement !== undefined && row.acknowledgement !== null;

  const submit = async (action: () => Promise<void>) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await action();
      setIsAcknowledging(false);
      setReason("");
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "記録できませんでした");
    } finally {
      setIsSubmitting(false);
    }
  };
  const showFixButton = onCreateFixIssue !== undefined && canRequestFixIssue(row.reviewKind);

  return (
    <li className="border-b px-4 py-2 text-xs last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <GithubReferenceLink
          href={`https://github.com/${repositoryFullName}/issues/${row.issueNumber}`}
          reference={{ repositoryFullName, number: row.issueNumber, kind: "issue" }}
          className="shrink-0 font-mono text-[11px] text-primary tabular-nums hover:underline"
        >
          #{row.issueNumber}
        </GithubReferenceLink>
        {row.issueTitle && (
          <span className="min-w-[8rem] flex-1 truncate text-muted-foreground">{row.issueTitle}</span>
        )}
        {row.pullRequestNumber === null ? (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">PR —</span>
        ) : (
          <GithubReferenceLink
            href={`https://github.com/${repositoryFullName}/pull/${row.pullRequestNumber}`}
            reference={{ repositoryFullName, number: row.pullRequestNumber, kind: "pull" }}
            className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums hover:underline"
          >
            PR #{row.pullRequestNumber}
          </GithubReferenceLink>
        )}
        <VerdictText kind={row.reviewKind} label={row.reviewLabel} />
        <span
          className={cn(
            "whitespace-nowrap",
            row.riskKind === "hit" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          リスク{row.riskLabel}
        </span>
        {(showFixButton || showAcknowledgeButton || showRevokeButton || row.reviewBody) && (
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            {showAcknowledgeButton && !isAcknowledging && (
              <Button size="xs" variant="outline" onClick={() => setIsAcknowledging(true)}>
                <CheckCheck />
                確認済み・対応しない
              </Button>
            )}
            {showRevokeButton && (
              <Button
                size="xs"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => void submit(() => onRevokeAcknowledgement(row))}
              >
                <Undo2 />
                取り消す
              </Button>
            )}
            {showFixButton && (
              <Button
                size="xs"
                variant={row.reviewKind === "changes-requested" ? "destructive" : "outline"}
                className={cn(
                  row.reviewKind === "needs-check" &&
                    "border-amber-600/30 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400",
                )}
                onClick={() => onCreateFixIssue?.(row)}
              >
                <FilePlus2 />
                修正をIssueにする
              </Button>
            )}
            {row.reviewBody && (
              <button
                type="button"
                onClick={() => setIsOpen((open) => !open)}
                aria-expanded={isOpen}
                className="flex shrink-0 cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                レビュー内容
              </button>
            )}
          </div>
        )}
      </div>
      {isAcknowledging && onAcknowledge && (
        <div className="mt-2 flex flex-col gap-2 rounded-md border bg-muted/40 p-2.5">
          <label htmlFor={`ack-reason-${row.issueNumber}`} className="text-muted-foreground">
            対応しない理由（PRのコメントとして残ります）
          </label>
          <textarea
            id={`ack-reason-${row.issueNumber}`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-11 resize-none rounded-md border bg-background p-1.5 text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              disabled={isSubmitting}
              onClick={() => void submit(() => onAcknowledge(row, reason))}
            >
              対応しないと記録する
            </Button>
            <Button size="xs" variant="outline" disabled={isSubmitting} onClick={() => setIsAcknowledging(false)}>
              やめる
            </Button>
            <span className="text-muted-foreground">
              追いコミットで再レビューされると、この記録は引き継がれません。
            </span>
          </div>
        </div>
      )}
      {submitError && <p className="mt-1 text-destructive">{submitError}</p>}
      {row.reviewBody && isOpen && (
        <MarkdownBody
          content={row.reviewBody}
          repositoryFullName={repositoryFullName}
          className="mt-2 rounded-md border bg-muted/30 px-3 py-2 text-[0.8125rem] leading-[1.8]"
        />
      )}
    </li>
  );
}

/**
 * リリースPR（develop→main）の本文に載っている「コードレビューの検証結果」をパネルにする（#2448）。
 *
 * **本文をそのまま読むだけで、ここから問い合わせはしない。** 判定はdevelop向けPRの本文へ
 * `## 検証結果`として残り（`reusable-claude-review-develop.yml`）、リリースPRを作るときに
 * 対象issueぶん集められている（`reusable-release-develop-to-main.yml`）。画面はその表を
 * 読み直して、内訳を先に出しているだけ。**レビューコメントの本文（#2488）も同じ本文の
 * 折りたたみに入っている**ので、行の「レビュー内容」を開けばここで読める。
 *
 * **本文には同じ表がそのまま出る。** 重複に見えるが、mainへ出すかどうかを決める人が最初に
 * 知りたいのは「何件のうち何件が問題なしか」で、そこへ辿り着くのに本文をスクロールさせない
 * ためにこの帯を置いている（自動マージされなかった理由を本文とは別に出しているのと同じ考え方）。
 */
export function VerificationSummaryPanel({
  verification,
  repositoryFullName,
  onCreateFixIssue,
  onAcknowledge,
  onRevokeAcknowledgement,
  showRebuildGuide = false,
}: {
  verification: ReleaseVerification;
  repositoryFullName: string;
  /**
   * 開いているリリースPRで、要確認・要修正の行に作り直しの案内を出す（#3760）。
   * リリースPRは凍結ブランチで本文は作成時に1回しか書かれないため、修正Issueをdevelopへ入れても
   * このパネルは変わらない。「修正を入れて作り直す」で作り直した時点から、修正Issueで直した行が
   * 修正済みになる（#3634）。
   */
  showRebuildGuide?: boolean;
  /**
   * 「要修正」「要確認」の行から、指摘を新規Issueの下書きにして開く（#2838）。
   * 渡さない画面ではボタンを出さない。
   */
  onCreateFixIssue?: (row: ReleaseVerificationRow) => void;
  /** 「確認済み・対応しない」の記録・取り消し（#3739）。渡さない画面ではボタンを出さない */
  onAcknowledge?: (row: ReleaseVerificationRow, reason: string) => Promise<void>;
  onRevokeAcknowledgement?: (row: ReleaseVerificationRow) => Promise<void>;
}) {
  const { rows, tally } = verification;

  return (
    // 同じ表がこの下の本文にもそのまま出るため、テストからはこの印で見分ける
    <section className="border-b" data-testid="verification-summary">
      <h2 className="flex items-center gap-2 border-b bg-muted/50 px-4 py-2 text-xs font-semibold">
        コードレビューの検証結果
        <span className="ml-auto font-normal text-[10px] text-muted-foreground">
          PR本文の記録から
        </span>
      </h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs">
        <span>
          <span className="font-semibold tabular-nums">{tally.total}</span>
          <span className="text-muted-foreground"> 件のIssue</span>
        </span>
        <VerdictText kind="ok" label="問題なし" count={tally.ok} />
        <VerdictText kind="needs-check" label="要確認" count={tally.needsCheck} />
        <VerdictText kind="changes-requested" label="要修正" count={tally.changesRequested} />
        <VerdictText kind="skipped" label="レビューなし" count={tally.skipped} />
        <VerdictText kind="unknown" label="記録なし" count={tally.unknown} />
      </div>
      {showRebuildGuide && tally.needsCheck + tally.changesRequested > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
          data-testid="verification-rebuild-guide"
        >
          <span>
            修正Issueをdevelopへマージしても、このリリースPRの表示は変わりません。作り直すと、修正Issueで直した行は「修正済み」になります。
          </span>
          <ReleaseRebuildButton repositoryFullName={repositoryFullName} />
        </div>
      )}
      <ul>
        {rows.map((row) => (
          <Row
            key={row.issueNumber}
            row={row}
            repositoryFullName={repositoryFullName}
            onCreateFixIssue={onCreateFixIssue}
            onAcknowledge={onAcknowledge}
            onRevokeAcknowledgement={onRevokeAcknowledgement}
          />
        ))}
      </ul>
    </section>
  );
}
