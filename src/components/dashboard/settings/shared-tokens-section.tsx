"use client";

import { useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSharedTokenMutations } from "@/hooks/use-shared-tokens";
import { formatDateTimeFull } from "@/lib/format-date-time";
import {
  SHARED_TOKEN_DESCRIPTION_MAX_LENGTH,
  SHARED_TOKEN_NAME_MAX_LENGTH,
  SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH,
} from "@/lib/shared-tokens";
import type { SharedToken } from "@/types/shared-token";

type SharedTokensSectionProps = {
  data: SharedToken[] | null;
  isLoading: boolean;
  error: string | null;
  onChanged: () => void;
};

export function SharedTokensSection({
  data,
  isLoading,
  error,
  onChanged,
}: SharedTokensSectionProps) {
  const { createSharedToken, revealSharedToken, deleteSharedToken, isSubmitting, error: mutationError } =
    useSharedTokenMutations();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function handleAdd() {
    const ok = await createSharedToken({
      name: name.trim(),
      value,
      description: description.trim() || null,
      sourceReference: sourceReference.trim() || null,
    });
    if (!ok) return;
    setName("");
    setValue("");
    setDescription("");
    setSourceReference("");
    onChanged();
  }

  async function handleReveal(id: string) {
    if (revealed[id] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    const tokenValue = await revealSharedToken(id);
    if (tokenValue !== null) setRevealed((current) => ({ ...current, [id]: tokenValue }));
  }

  async function handleDelete(id: string) {
    const ok = await deleteSharedToken(id);
    if (!ok) return;
    setRevealed((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    onChanged();
  }

  return (
    <div className="flex flex-col gap-3">
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">移行済みの共有トークンはありません</p>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.map((token) => (
            <li key={token.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{token.name}</p>
                  {token.description && <p className="text-xs text-muted-foreground">{token.description}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={revealed[token.id] !== undefined ? "トークンを隠す" : "トークンを表示"}
                    onClick={() => void handleReveal(token.id)}
                  >
                    {revealed[token.id] !== undefined ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={isSubmitting}
                    aria-label={`${token.name}を削除`}
                    onClick={() => void handleDelete(token.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              {revealed[token.id] !== undefined && (
                <Input value={revealed[token.id]} readOnly aria-label={`${token.name}の値`} />
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge variant={token.lastUsedAt ? "secondary" : "outline"}>
                  {token.lastUsedAt ? `最終利用: ${formatDateTimeFull(token.lastUsedAt)}` : "未使用"}
                </Badge>
                {token.consumers.map((consumer) => (
                  <Badge key={consumer} variant="outline">{consumer}</Badge>
                ))}
              </div>
              {token.sourceReference && (
                <p className="break-all text-xs text-muted-foreground">移行元: {token.sourceReference}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shared-token-name" className="text-xs">トークン名</Label>
          <Input id="shared-token-name" placeholder="例: EXTERNAL_API_TOKEN" maxLength={SHARED_TOKEN_NAME_MAX_LENGTH} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shared-token-value" className="text-xs">トークン値</Label>
          <Input id="shared-token-value" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shared-token-description" className="text-xs">説明（任意）</Label>
          <Input id="shared-token-description" maxLength={SHARED_TOKEN_DESCRIPTION_MAX_LENGTH} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="shared-token-source" className="text-xs">1Password参照先（任意）</Label>
          <Input id="shared-token-source" placeholder="op://apps/..." maxLength={SHARED_TOKEN_SOURCE_REFERENCE_MAX_LENGTH} value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} />
        </div>
      </div>
      <Button className="self-start" onClick={() => void handleAdd()} disabled={isSubmitting || !name.trim() || !value}>
        {isSubmitting ? "登録中..." : "移行して登録"}
      </Button>
      {mutationError && <p className="text-sm text-destructive">{mutationError}</p>}
      <p className="text-xs text-muted-foreground">
        1Passwordの値をここへ一度だけ入力して移行します。値は暗号化して保存され、一覧・利用履歴・エラーには表示されません。
      </p>
    </div>
  );
}
