"use client";

import { useState } from "react";

import { toJstParts } from "@/lib/format-date-time";
import {
  REVIEW_NOTE_BODY_MAX,
  REVIEW_NOTE_FOLLOW_UP_MAX,
  notesForTarget,
  validateReviewNoteInput,
  type ReleaseReviewNotes,
  type ReviewNoteTarget,
} from "@/lib/release-review-note";
import { cn } from "@/lib/utils";

/**
 * 全体レビューの未確認項目・候補全体への判断メモ（#5252）。`release-review-sections.tsx`から使う。
 * **記録と表示だけで、AIの判定・ゲートの合否・公開承認は変えない。** 公開承認とは独立に、承認の前にも書ける。
 */

type Target = { baseSha: string; headSha: string };

function when(iso: string): string {
  const p = toJstParts(iso);
  return p ? `${p.month}/${p.day} ${p.hour}:${String(p.minute).padStart(2, "0")}` : iso;
}

export function ReviewNoteControl({
  repositoryFullName,
  pullRequestNumber,
  target,
  noteTarget,
  notes,
  label,
  onSaved,
}: {
  repositoryFullName: string;
  pullRequestNumber: number;
  target: Target;
  noteTarget: ReviewNoteTarget;
  notes: ReleaseReviewNotes | null | undefined;
  /** 入力欄の見出し（例: 「承認基準の確認」「候補全体」） */
  label: string;
  onSaved?: () => void;
}) {
  const records = notesForTarget(notes, noteTarget);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const input = { body, followUp: followUp.trim() || null };
    const invalid = validateReviewNoteInput(input);
    if (invalid) {
      setMessage(invalid.message);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const [owner, repo] = repositoryFullName.split("/");
      const res = await fetch("/api/repositories/release/review-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner,
          repo,
          pullRequestNumber,
          baseSha: target.baseSha,
          headSha: target.headSha,
          target: noteTarget,
          body: input.body,
          followUp: input.followUp,
        }),
      });
      const result: { message?: string } = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) setMessage("メモを保存する権限がありません。ログインし直してください。");
      else if (res.status === 409) setMessage(`${result.message ?? "対象が更新されました。"}「更新」で最新の状態を読み込んでください。`);
      else if (!res.ok) setMessage(result.message ?? `メモを保存できませんでした (${res.status})。`);
      else {
        setBody("");
        setFollowUp("");
        setOpen(false);
        onSaved?.();
      }
    } catch {
      setMessage("メモを保存できませんでした。通信を確認してください。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-0.5 flex flex-col gap-1 text-[11.5px]" data-testid="review-note">
      {records.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {records.map((r) => (
            <li key={r.id} className="rounded border border-violet-300 bg-violet-50/60 px-2 py-1 dark:border-violet-800 dark:bg-violet-950/20">
              <p className="whitespace-pre-wrap break-words">{r.body}</p>
              {r.followUp && <p className="break-all text-muted-foreground">後続の対応先: {r.followUp}</p>}
              <p className="text-[10.5px] text-muted-foreground">
                判断メモ · {r.author} · {when(r.createdAt)}
                {r.headSha !== target.headSha && ` · 以前の候補（${r.headSha.slice(0, 7)}）で記録`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="flex flex-col gap-1 rounded border px-2 py-1.5">
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}: 承知した理由</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={REVIEW_NOTE_BODY_MAX}
              rows={3}
              className="w-full rounded border bg-background px-1.5 py-1"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">後続の対応先（任意。例: guchi-apps/morrow#683）</span>
            <input
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              maxLength={REVIEW_NOTE_FOLLOW_UP_MAX}
              className="w-full rounded border bg-background px-1.5 py-1"
            />
          </label>
          <p className="text-[10.5px] text-muted-foreground">
            メモは記録だけです。AIの判定・ゲートの合否は変わらず、公開承認の代わりにもなりません。
          </p>
          {message && <p className="text-destructive">{message}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={save} className={cn("rounded border px-2 py-0.5", busy && "opacity-50")}>
              {busy ? "保存中…" : "メモを保存"}
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)} className="rounded border px-2 py-0.5 text-muted-foreground">
              閉じる
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="self-start text-sky-700 underline dark:text-sky-400">
          判断メモを書く
        </button>
      )}
    </div>
  );
}
