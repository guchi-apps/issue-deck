"use client";

import { useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSharedTokenMutations } from "@/hooks/use-shared-tokens";
import { formatDateTimeFull } from "@/lib/format-date-time";
import {
  isUnexpectedConsumer,
  parseExpectedConsumers,
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
  const {
    createSharedToken,
    revealSharedToken,
    updateExpectedConsumers,
    deleteSharedToken,
    isSubmitting,
    error: mutationError,
  } = useSharedTokenMutations();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [valueVisible, setValueVisible] = useState(false);
  // 自動生成した値は作成直後の1回だけ表示する（#4121）。
  const [created, setCreated] = useState<{ name: string; value: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SharedToken | null>(null);
  // 想定される利用元の編集中の入力（#4998）
  const [editingConsumers, setEditingConsumers] = useState<{ id: string; text: string } | null>(null);
  const [consumersError, setConsumersError] = useState<string | null>(null);

  async function handleAdd() {
    const trimmedName = name.trim();
    // 値が空欄ならissue-deckがランダム値を生成する
    const result = await createSharedToken({
      name: trimmedName,
      value: value || null,
      description: description.trim() || null,
      sourceReference: sourceReference.trim() || null,
    });
    if (!result) return;
    setCreated(result.generatedValue ? { name: trimmedName, value: result.generatedValue } : null);
    setName("");
    setValue("");
    setDescription("");
    setSourceReference("");
    setValueVisible(false);
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

  async function handleSaveExpectedConsumers() {
    if (!editingConsumers) return;
    const expectedConsumers = parseExpectedConsumers(editingConsumers.text);
    if (!expectedConsumers) {
      setConsumersError("利用元の数か名前の長さが上限を超えています");
      return;
    }
    const ok = await updateExpectedConsumers(editingConsumers.id, expectedConsumers);
    if (!ok) return;
    setConsumersError(null);
    setEditingConsumers(null);
    onChanged();
  }

  async function handleDelete(id: string) {
    const ok = await deleteSharedToken(id);
    if (!ok) return;
    setRevealed((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDeleteTarget(null);
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
                    onClick={() => setDeleteTarget(token)}
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
                {token.consumers.map((consumer) =>
                  isUnexpectedConsumer(token.expectedConsumers, consumer) ? (
                    <Badge key={consumer} variant="destructive" title="想定される利用元に含まれていません">
                      想定外: {consumer}
                    </Badge>
                  ) : (
                    <Badge key={consumer} variant="outline">{consumer}</Badge>
                  ),
                )}
              </div>
              {editingConsumers?.id === token.id ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`shared-token-expected-${token.id}`} className="text-xs">
                    想定される利用元（カンマ区切り。空欄で未設定に戻す）
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={`shared-token-expected-${token.id}`}
                      placeholder="例: aide, myroom"
                      value={editingConsumers.text}
                      onChange={(event) => setEditingConsumers({ id: token.id, text: event.target.value })}
                    />
                    <Button type="button" size="sm" className="shrink-0" disabled={isSubmitting} onClick={() => void handleSaveExpectedConsumers()}>
                      保存
                    </Button>
                    <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={isSubmitting} onClick={() => { setEditingConsumers(null); setConsumersError(null); }}>
                      取消
                    </Button>
                  </div>
                  {consumersError && <p className="text-xs text-destructive">{consumersError}</p>}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>想定される利用元:</span>
                  {token.expectedConsumers.length > 0 ? (
                    token.expectedConsumers.map((consumer) => (
                      <Badge key={consumer} variant="secondary">{consumer}</Badge>
                    ))
                  ) : (
                    <span>未設定（想定外の取得を通知しません）</span>
                  )}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    aria-label={`${token.name}の想定される利用元を編集`}
                    onClick={() => {
                      setConsumersError(null);
                      setEditingConsumers({ id: token.id, text: token.expectedConsumers.join(", ") });
                    }}
                  >
                    {token.expectedConsumers.length > 0 ? "編集" : "設定"}
                  </Button>
                </div>
              )}
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
          <Label htmlFor="shared-token-value" className="text-xs">トークン値（既存の値を移すときだけ）</Label>
          <div className="flex gap-2">
            <Input id="shared-token-value" type={valueVisible ? "text" : "password"} autoComplete="off" placeholder="空欄ならランダムな値を自動生成" value={value} onChange={(event) => setValue(event.target.value)} />
            <Button type="button" variant="outline" className="shrink-0" onClick={() => setValueVisible((visible) => !visible)}>
              {valueVisible ? "隠す" : "表示"}
            </Button>
          </div>
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
      <Button className="self-start" onClick={() => void handleAdd()} disabled={isSubmitting || !name.trim()}>
        {isSubmitting ? "登録中..." : value ? "移行して登録" : "登録（値を自動生成）"}
      </Button>
      {mutationError && !deleteTarget && <p className="text-sm text-destructive">{mutationError}</p>}
      {created && (
        <div className="flex flex-col gap-1.5 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            「{created.name}」の値を自動生成しました。この値が画面に出るのは今回だけです。利用側はAPIから取得するので、控えは不要です。
          </p>
          <Input value={created.value} readOnly aria-label="自動生成した値" />
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setCreated(null)}>閉じる</Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        値は空欄のまま登録すると自動生成します。1Passwordなど外部で決まった値を移すときだけ入力してください。値は暗号化して保存され、一覧・利用履歴・エラーには表示されません。想定される利用元を設定したトークンは、それ以外の利用元が取得するとDiscordへ通知します（同じ組は24時間に1回）。利用元は自己申告のため、取得を止める仕組みではありません。
      </p>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && !isSubmitting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>トークンを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」を削除します。このトークンを使っているアプリは、次の取得から認証に失敗します。元に戻せません。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutationError && <p className="text-sm text-destructive">{mutationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={isSubmitting}
              onClick={(event) => {
                event.preventDefault();
                if (deleteTarget) void handleDelete(deleteTarget.id);
              }}
            >
              {isSubmitting ? "削除中…" : "削除する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
