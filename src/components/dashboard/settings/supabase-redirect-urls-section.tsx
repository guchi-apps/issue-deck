"use client";

import { useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useSupabaseRedirectUrlMutations,
  useSupabaseRedirectUrls,
} from "@/hooks/use-supabase-redirect-urls";
import { REDIRECT_URL_MAX_LENGTH } from "@/lib/supabase/management-api";

/**
 * Supabase Auth の Redirect URLs（`uri_allow_list`）を、Management API経由で一覧・登録・編集・
 * 削除する（#3568）。`LazyFleetPanel`の中で使う前提で、`open`は常に`true`で渡す——マウントの
 * タイミング自体をLazyFleetPanel側が「初めて開くまで遅らせる」ため（`SecretsSyncSection`と同じ形）。
 *
 * 削除・置換はSupabaseの認証全体に影響するため、確認ダイアログを挟む。
 */
export function SupabaseRedirectUrlsSection({ open }: { open: boolean }) {
  const { data, isLoading, error, notConfigured, refetch } = useSupabaseRedirectUrls(open);
  const {
    addRedirectUrl,
    replaceRedirectUrl,
    removeRedirectUrl,
    isSubmitting,
    error: mutationError,
    setError,
  } = useSupabaseRedirectUrlMutations();

  const [newUrl, setNewUrl] = useState("");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  async function handleAdd() {
    const ok = await addRedirectUrl(newUrl.trim());
    if (!ok) return;
    setNewUrl("");
    refetch();
  }

  function startEdit(url: string) {
    setError(null);
    setEditingUrl(url);
    setEditValue(url);
  }

  function cancelEdit() {
    setEditingUrl(null);
    setEditValue("");
  }

  async function confirmEdit() {
    if (!editingUrl) return;
    const ok = await replaceRedirectUrl(editingUrl, editValue.trim());
    if (!ok) return;
    cancelEdit();
    refetch();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    const ok = await removeRedirectUrl(target);
    if (!ok) return;
    refetch();
  }

  if (notConfigured) {
    return (
      <p className="text-xs text-muted-foreground">
        設定されていません。`SUPABASE_MANAGEMENT_API_TOKEN`をサーバーの環境変数へ登録すると使えます。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {isLoading && <p className="text-xs text-muted-foreground">読み込み中...</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {data && data.length === 0 && (
        <p className="text-xs text-muted-foreground">登録されているURLはありません</p>
      )}
      {data && data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.map((url) => (
            <li key={url} className="flex items-center justify-between gap-2 rounded-lg border p-2">
              {editingUrl === url ? (
                <>
                  <Input
                    value={editValue}
                    maxLength={REDIRECT_URL_MAX_LENGTH}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="h-8 flex-1 font-mono text-xs"
                  />
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={isSubmitting || !editValue.trim()}
                      onClick={confirmEdit}
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={isSubmitting}
                      onClick={cancelEdit}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="min-w-0 truncate font-mono text-xs">{url}</p>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={isSubmitting}
                      onClick={() => startEdit(url)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      disabled={isSubmitting}
                      onClick={() => setDeleteTarget(url)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="supabase-redirect-url-new" className="text-xs">
            追加するURL
          </Label>
          <Input
            id="supabase-redirect-url-new"
            placeholder="https://example.gucchii.com/auth/callback"
            maxLength={REDIRECT_URL_MAX_LENGTH}
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <Button onClick={handleAdd} disabled={isSubmitting || !newUrl.trim()}>
          {isSubmitting ? "処理中..." : "追加"}
        </Button>
      </div>

      {mutationError && <p className="text-sm text-destructive">{mutationError}</p>}

      <p className="text-xs text-muted-foreground">
        共有Supabaseプロジェクトの認証全体に影響します。削除・変更は他アプリのログインが壊れないか確認してから行ってください。
      </p>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>このURLを削除しますか？</AlertDialogTitle>
            <AlertDialogDescription className="break-all font-mono text-xs">
              {deleteTarget}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>削除する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
