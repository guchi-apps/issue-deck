"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { repairKindLabel } from "@/lib/chat/status-card";
import { formatTimeOfDay } from "@/lib/format-date-time";
import type {
  ChatCard,
  ChatConfirmState,
  ChatTone,
} from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<ChatTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
  mut: "bg-muted text-muted-foreground",
};

function Pill({ tone, children }: { tone: ChatTone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-px text-xs font-semibold", TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

/**
 * チャットの回答に出るカード。**判定は既存ロジックの結果を写すだけ**で、ここには持たない。
 * 「PRを開く」は既存のPR詳細（`?pr=`）へ、Issueは既存のIssue詳細へ移る導線（Chatと詳細の併存）。
 */
export function ChatCardView({
  card,
  confirmState,
  busy,
  onSend,
  onConfirm,
  onOpenPullRequest,
}: {
  card: ChatCard;
  confirmState: ChatConfirmState | null;
  busy: boolean;
  onSend: (text: string) => void;
  onConfirm: (action: "execute" | "cancel", overrides?: { title?: string; body?: string }) => void;
  onOpenPullRequest: (repo: string, number: number) => void;
}) {
  switch (card.type) {
    case "status": {
      const [owner, repo] = card.repo.split("/");
      return (
        <div className="overflow-hidden rounded-lg border bg-card text-sm">
          <div className="flex flex-wrap items-baseline gap-2 border-b px-3 py-2 font-semibold">
            <span>{card.title}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {owner}/{repo}#{card.number}
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
            {card.rows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd><Pill tone={row.tone}>{row.value}</Pill></dd>
              </div>
            ))}
            {card.relatedIssue !== null && (
              <div className="contents">
                <dt className="text-muted-foreground">関連Issue</dt>
                <dd>#{card.relatedIssue}</dd>
              </div>
            )}
            {card.session && (
              <div className="contents">
                <dt className="text-muted-foreground">セッション</dt>
                <dd className="font-mono text-xs">{card.session.label}（{card.session.state}）</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-2 border-t px-3 py-2.5">
            {card.htmlUrl && (
              <Button variant="outline" size="sm" asChild>
                <a href={card.htmlUrl} target="_blank" rel="noreferrer">GitHubで開く<ExternalLink /></a>
              </Button>
            )}
            {card.kind === "pr" && (
              <Button variant="outline" size="sm" onClick={() => onOpenPullRequest(card.repo, card.number)}>
                PR詳細を開く
              </Button>
            )}
            {card.kind === "pr" && card.repairKinds.length > 0 && (
              <Button size="sm" disabled={busy} onClick={() => onSend(`${card.repo}#${card.number}を直して`)}>
                PRを自動修正
              </Button>
            )}
          </div>
        </div>
      );
    }
    case "choice":
      return (
        <div className="flex flex-wrap gap-2">
          {card.options.map((option) => (
            <Button key={option.send} variant="outline" size="sm" disabled={busy} onClick={() => onSend(option.send)}>
              {option.label}
            </Button>
          ))}
        </div>
      );
    case "confirm_repair":
      return (
        <ConfirmFrame title={`確認：PR #${card.number} を自動修正します`} state={confirmState}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">対象</dt>
            <dd>{card.repo}#{card.number}</dd>
            <dt className="text-muted-foreground">直すもの</dt>
            <dd>{card.kinds.map(repairKindLabel).join(" → ")}（先頭から順に、1回に1種類ずつ起動します）</dd>
            <dt className="text-muted-foreground">実行</dt>
            <dd>PR一覧・詳細の「PRを自動修正」と同じ処理</dd>
          </dl>
          <ConfirmActions state={confirmState} busy={busy} executeLabel="実行する" onConfirm={onConfirm} />
        </ConfirmFrame>
      );
    case "confirm_fix_request":
      return (
        <ConfirmFrame title={`確認：PR #${card.number} の修正を依頼します`} state={confirmState}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">対象</dt>
            <dd>{card.repo}#{card.number} {card.title}</dd>
            <dt className="text-muted-foreground">前提のHEAD</dt>
            <dd className="font-mono text-xs">{card.headSha.slice(0, 7)}（進んでいたら中断します）</dd>
            <dt className="text-muted-foreground">渡し先</dt>
            <dd>Issue #{card.issueNumber} への依頼コメント（実行先・エージェントは既存の設定に従います）</dd>
            <dt className="text-muted-foreground">依頼内容</dt>
            <dd className="whitespace-pre-wrap">{card.instruction}</dd>
            <dt className="text-muted-foreground">許可範囲</dt>
            <dd>このPRのブランチ内の修正のみ。マージ・本番反映・認証方式や環境変数の変更はしません</dd>
          </dl>
          <ConfirmActions state={confirmState} busy={busy} executeLabel="依頼する" onConfirm={onConfirm} />
        </ConfirmFrame>
      );
    case "investigation":
      return (
        <div className="overflow-hidden rounded-lg border bg-card text-sm">
          <div className="border-b px-3 py-2 font-semibold">調査の根拠</div>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            {card.facts.length > 0 && <EvidenceList title="確認できたこと" items={card.facts} />}
            {card.inferences.length > 0 && <EvidenceList title="推測" items={card.inferences} />}
            {card.unconfirmed.length > 0 && <EvidenceList title="未確認" items={card.unconfirmed} tone="warn" />}
            {card.evidence.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-muted-foreground">参照</p>
                <ul className="flex flex-col gap-1">
                  {card.evidence.map((item) => (
                    <li key={`${item.label}|${item.url ?? ""}|${item.ref ?? ""}`} className="text-xs">
                      {item.url ? (
                        <a className="underline" href={item.url} target="_blank" rel="noreferrer">{item.label}</a>
                      ) : (
                        item.label
                      )}
                      <span className="text-muted-foreground">
                        {item.ref ? `　${item.ref}` : ""}　取得 {formatTimeOfDay(item.fetchedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {card.stopReason && <p className="text-xs text-amber-700 dark:text-amber-300">調査を止めた理由: {card.stopReason}</p>}
          </div>
        </div>
      );
    case "fix_progress":
      return (
        <div className="overflow-hidden rounded-lg border bg-card text-sm">
          <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 font-semibold">
            <span>修正依頼 {card.repo}#{card.number}</span>
            <Pill tone={card.phase === "verified" ? "ok" : card.phase === "failed" ? "bad" : "warn"}>{card.phaseLabel}</Pill>
          </div>
          <ol className="flex flex-col gap-1 px-3 py-2.5">
            {card.steps.map((step) => (
              <li key={step.label} className="flex gap-2">
                <span>{step.done ? "✅" : "⏳"}</span>
                <span>{step.label}{step.note ? <span className="text-muted-foreground">（{step.note}）</span> : null}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => onSend(`${card.repo}#${card.number}の修正依頼の進み具合を確認して`)}>
              状況を更新
            </Button>
            <span className="text-xs text-muted-foreground">取得 {formatTimeOfDay(card.fetchedAt)}</span>
          </div>
        </div>
      );
    case "confirm_issue":
      return <IssueDraft card={card} state={confirmState} busy={busy} onConfirm={onConfirm} />;
    case "result":
      return (
        <div className={cn("rounded-lg border px-3 py-2 text-sm", card.ok ? "" : "border-destructive/40")}>
          <p className="font-semibold">{card.title}</p>
          {card.detail && <p className="mt-0.5 text-muted-foreground">{card.detail}</p>}
          {card.htmlUrl && (
            <Button variant="outline" size="sm" className="mt-2" asChild>
              <a href={card.htmlUrl} target="_blank" rel="noreferrer">開く<ExternalLink /></a>
            </Button>
          )}
        </div>
      );
  }
}

function EvidenceList({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  return (
    <div>
      <p className={cn("mb-1 text-xs font-semibold", tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
        {title}
      </p>
      <ul className="list-disc pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ConfirmFrame({
  title,
  state,
  children,
}: {
  title: string;
  state: ChatConfirmState | null;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-amber-500/60 bg-card text-sm">
      <div className="flex items-center justify-between gap-2 bg-amber-500/15 px-3 py-2 font-semibold text-amber-800 dark:text-amber-200">
        <span>{title}</span>
        {state === "done" && <span className="text-xs font-normal">実行済み</span>}
        {state === "cancelled" && <span className="text-xs font-normal">やめました</span>}
      </div>
      {children}
    </div>
  );
}

function ConfirmActions({
  state,
  busy,
  executeLabel,
  onConfirm,
}: {
  state: ChatConfirmState | null;
  busy: boolean;
  executeLabel: string;
  onConfirm: (action: "execute" | "cancel") => void;
}) {
  if (state !== "pending") return null;
  return (
    <div className="flex flex-wrap gap-2 border-t px-3 py-2.5">
      <Button size="sm" disabled={busy} onClick={() => onConfirm("execute")}>{executeLabel}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => onConfirm("cancel")}>やめる</Button>
    </div>
  );
}

function IssueDraft({
  card,
  state,
  busy,
  onConfirm,
}: {
  card: Extract<ChatCard, { type: "confirm_issue" }>;
  state: ChatConfirmState | null;
  busy: boolean;
  onConfirm: (action: "execute" | "cancel", overrides?: { title?: string; body?: string }) => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const editable = state === "pending";
  return (
    <ConfirmFrame title="Issue案（確認してから作成します）" state={state}>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">{card.repo}</p>
        {card.duplicates && card.duplicates.length > 0 && (
          <div className="rounded-lg border border-amber-500/60 px-2.5 py-2 text-xs">
            <p className="font-semibold">似た既存のIssue（重複でないか確認してください）</p>
            <ul className="mt-1 list-disc pl-5">
              {card.duplicates.map((item) => (
                <li key={item.number}>
                  <a className="underline" href={item.htmlUrl} target="_blank" rel="noreferrer">#{item.number} {item.title}</a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="chat-issue-title">
          タイトル
          <input
            id="chat-issue-title"
            value={title}
            readOnly={!editable}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-lg border bg-transparent px-2.5 py-1.5 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="chat-issue-body">
          本文
          <Textarea id="chat-issue-body" value={body} readOnly={!editable} onChange={(event) => setBody(event.target.value)} />
        </label>
      </div>
      {editable && (
        <div className="flex flex-wrap gap-2 border-t px-3 py-2.5">
          <Button size="sm" disabled={busy || !title.trim()} onClick={() => onConfirm("execute", { title, body })}>
            Issueを作成
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onConfirm("cancel")}>やめる</Button>
        </div>
      )}
    </ConfirmFrame>
  );
}
