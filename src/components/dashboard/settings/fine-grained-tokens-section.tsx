"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFineGrainedTokenMutations } from "@/hooks/use-fine-grained-token-mutations";
import { useNow } from "@/hooks/use-now";
import { formatDateOnly } from "@/lib/format-date-time";
import {
  FINE_GRAINED_TOKEN_NAME_MAX_LENGTH,
  getFineGrainedTokenRemainingDays,
  getFineGrainedTokenStatus,
} from "@/lib/fine-grained-tokens";
import type { FineGrainedToken } from "@/types/fine-grained-token";

type FineGrainedTokensSectionProps = {
  data: FineGrainedToken[] | null;
  isLoading: boolean;
  error: string | null;
  onChanged: () => void;
};

/**
 * Fine-grained PATの有効期限を手で登録する（元は`FineGrainedTokensDialog`）。
 * 設定ダイアログの中でダイアログを開く入れ子をやめ、「フリート運用」区分に展開した（#1539）。
 */
export function FineGrainedTokensSection({
  data,
  isLoading,
  error,
  onChanged,
}: FineGrainedTokensSectionProps) {
  const now = useNow();
  const {
    createFineGrainedToken,
    deleteFineGrainedToken,
    isSubmitting,
    error: mutationError,
  } = useFineGrainedTokenMutations();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  async function handleAdd() {
    const ok = await createFineGrainedToken({ name: name.trim(), expiresAt });
    if (!ok) return;
    setName("");
    setExpiresAt("");
    onChanged();
  }

  async function handleDelete(id: string) {
    const ok = await deleteFineGrainedToken(id);
    if (!ok) return;
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Fine-grained PATの有効期限</span>

      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">登録されているトークンはありません</p>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.map((token) => {
            const status = now !== null ? getFineGrainedTokenStatus(token.expiresAt, now) : null;
            const remainingDays =
              now !== null ? getFineGrainedTokenRemainingDays(token.expiresAt, now) : null;
            return (
              <li
                key={token.id}
                className="flex items-center justify-between gap-2 rounded-lg border p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  <p className="text-xs text-muted-foreground">
                    期限: {formatDateOnly(token.expiresAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {status && (
                    <Badge
                      variant={
                        status === "expired"
                          ? "destructive"
                          : status === "expiring-soon"
                            ? "outline"
                            : "secondary"
                      }
                    >
                      {status === "expired" ? "期限切れ" : `あと${remainingDays}日`}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={isSubmitting}
                    onClick={() => handleDelete(token.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="fine-grained-token-name" className="text-xs">
            トークン名
          </Label>
          <Input
            id="fine-grained-token-name"
            placeholder="例: WORKFLOW_PAT"
            maxLength={FINE_GRAINED_TOKEN_NAME_MAX_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fine-grained-token-expires-at" className="text-xs">
            有効期限
          </Label>
          <Input
            id="fine-grained-token-expires-at"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <Button onClick={handleAdd} disabled={isSubmitting || !name.trim() || !expiresAt}>
          {isSubmitting ? "登録中..." : "登録"}
        </Button>
      </div>

      {mutationError && <p className="text-sm text-destructive">{mutationError}</p>}

      <p className="text-xs text-muted-foreground">
        GitHubのFine-grained PAT（例: WORKFLOW_PAT）は有効期限をアプリから自動取得できないため、
        GitHub側のPAT設定画面で確認した有効期限をここに登録してください。全リポジトリ共通の設定です。
      </p>
    </div>
  );
}
