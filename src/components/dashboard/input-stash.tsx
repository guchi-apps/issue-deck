"use client";

import { useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { INPUT_STASH_RETENTION_DAYS, type InputStashView } from "@/lib/dispatch/input-stash";
import { formatDateTime } from "@/lib/format-date-time";

/**
 * 未送信入力の退避（#4383）の確認ダイアログと、退避した内容の確認・コピー・削除。
 * 退避本文は機密を含み得るため、ログイン必須の受け口（`/api/dispatch/input-stash`）から
 * 読んだものをこの画面にだけ出し、GitHubのコメント・通知には載せない。
 */

/** 「未送信の入力を退避して、再開指示を送信」の確認。キャンセルでは何も変更しない */
export function StashConfirmDialog({
  open,
  onOpenChange,
  target,
  instruction,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: { repositoryFullName: string; issueNumber: number; host: string; tmuxSessionName?: string | null };
  instruction: string;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="stash-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>未送信の入力を退避して、指示を送信しますか？</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-left">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">対象</dt>
                <dd className="break-all">
                  {target.repositoryFullName}#{target.issueNumber}
                </dd>
                <dt className="text-muted-foreground">ホスト</dt>
                <dd>{target.host}</dd>
                {target.tmuxSessionName && (
                  <>
                    <dt className="text-muted-foreground">セッション</dt>
                    <dd className="break-all">{target.tmuxSessionName}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">送る指示</dt>
                <dd className="break-words">「{instruction}」</dd>
              </dl>
              <p>
                入力欄に残っている未送信の文字を、IssueDeckへ{INPUT_STASH_RETENTION_DAYS}
                日間退避してから入力欄を空にし、上の指示だけを送ります。元の入力は自動では再送せず、指示とも連結しません。
              </p>
              <p>
                完全に取得できない入力（複数行・折り返し・特殊な文字など）・作業中・承認待ちのときは、何も消さず送りません。
                キャンセルすると入力・セッション・ジョブは変更しません。
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>キャンセル</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void onConfirm().finally(() => onOpenChange(false));
            }}
          >
            退避して送信
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** このIssueの退避の一覧。内容の確認・コピー・削除ができる（元の入力は再送しない） */
export function InputStashList({
  repositoryFullName,
  issueNumber,
  reloadKey,
}: {
  repositoryFullName: string;
  issueNumber: number;
  /** 退避が増えうる操作の後に変えると取り直す */
  reloadKey?: string | number | null;
}) {
  const [stashes, setStashes] = useState<InputStashView[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ repository: repositoryFullName, issue: String(issueNumber) });
    void fetch(`/api/dispatch/input-stash?${params}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { stashes?: InputStashView[] } | null) => {
        if (!cancelled && json) setStashes(json.stashes ?? []);
      })
      // 退避の一覧が読めなくても、他の操作は妨げない
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repositoryFullName, issueNumber, reloadKey, version]);

  if (stashes.length === 0) return null;

  return (
    <div data-testid="input-stash-list" className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <p className="font-medium">退避した未送信入力（{INPUT_STASH_RETENTION_DAYS}日で自動削除）</p>
      {stashes.map((stash) => (
        <div key={stash.id} className="flex flex-col gap-1 rounded border bg-muted/40 p-2">
          <p className="text-muted-foreground">
            {formatDateTime(stash.createdAt)} に退避（{stash.charCount}文字・{stash.host}）
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">{stash.content}</pre>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(stash.content)
                  .then(() => setNote("コピーしました。入力欄へ貼り付けて復元できます（自動では再送しません）。"))
                  .catch(() => setNote("コピーできませんでした。内容を選択してコピーしてください。"));
              }}
            >
              <Copy className="size-3.5" />
              コピー
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void fetch(`/api/dispatch/input-stash?id=${encodeURIComponent(stash.id)}`, { method: "DELETE" })
                  .then(() => setVersion((v) => v + 1))
                  .catch(() => undefined);
              }}
            >
              <Trash2 className="size-3.5" />
              削除
            </Button>
          </div>
        </div>
      ))}
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}
