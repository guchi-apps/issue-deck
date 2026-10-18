"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useNow } from "@/hooks/use-now";
import { formatDateTimeFull } from "@/lib/format-date-time";

type TokenRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  repositories: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

const MAX_REPOSITORIES = 50;

/**
 * 許可repositoryの選択部品（発行と編集で共用 #4739）。選べるのはissue-deckが管理しているrepositoryだけ。
 * 選択済みなのに一覧に無いもの（アーカイブ・連携解除済み）は残したまま表示し、外せるようにする。
 */
function RepositoryPicker({ options, selected, onChange, original }: { options: string[]; selected: string[]; onChange: (next: string[]) => void; original?: string[] }) {
  const [filter, setFilter] = useState("");
  const stale = selected.filter((r) => !options.includes(r)).concat((original ?? []).filter((r) => !options.includes(r) && !selected.includes(r)));
  const rows = [...new Set([...stale, ...options])].filter((r) => r.toLowerCase().includes(filter.trim().toLowerCase()));
  const added = original ? selected.filter((r) => !original.includes(r)).length : 0;
  const removed = original ? original.filter((r) => !selected.includes(r)).length : 0;
  return (
    <div className="flex flex-col gap-2">
      <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="repositoryを絞り込み" aria-label="repositoryを絞り込み" />
      <div className="grid max-h-48 grid-cols-1 gap-x-3 gap-y-0.5 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
        {rows.length === 0 && <p className="text-xs text-muted-foreground">該当するrepositoryがありません</p>}
        {rows.map((repo) => (
          <label key={repo} className="flex min-w-0 items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={selected.includes(repo)}
              onChange={(e) => onChange(e.target.checked ? [...selected, repo] : selected.filter((r) => r !== repo))}
            />
            <span className="truncate">{repo}</span>
            {!options.includes(repo) && <span className="shrink-0 text-amber-600">連携解除/アーカイブ済み</span>}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        選択 {selected.length}件（最大{MAX_REPOSITORIES}件）
        {original ? `（追加 +${added} ／ 削除 −${removed}）` : ""}
      </p>
    </div>
  );
}

const SCOPES: Array<{ key: string; label: string }> = [
  { key: "read", label: "取得" },
  { key: "write", label: "更新・報告" },
  { key: "resume", label: "再開" },
];

/**
 * 外部エージェント向けの全体レビュー・修正API／MCP（#4588）のトークンを発行・失効する。
 * 値は発行直後の1回だけ表示し、以降は先頭数文字しか見えない。アクセスさせるrepositoryと操作範囲を必ず絞って発行する。
 * 接続手順は`docs/review-agent-api.md`。
 */
export function ReviewAgentTokensSection() {
  const now = useNow();
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [repositories, setRepositories] = useState<string[]>([]);
  const [available, setAvailable] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [days, setDays] = useState("30");
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/review-agent-tokens").catch(() => null);
    if (!res?.ok) {
      setError("トークンの一覧を取得できませんでした");
      return;
    }
    const data = (await res.json()) as { tokens: TokenRow[]; availableRepositories: string[] };
    setTokens(data.tokens);
    setAvailable(data.availableRepositories ?? []);
    setError(null);
  }, []);

  useEffect(() => {
    // 開いた時点で一度だけ一覧を取得する（外部システムとの同期）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/review-agent-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        scopes,
        repositories,
        expiresInDays: Number(days),
      }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { token?: string; message?: string } | null;
    setBusy(false);
    if (!res?.ok || !body?.token) {
      setError(body?.message ?? "発行できませんでした");
      return;
    }
    setIssued({ name, token: body.token });
    setName("");
    setRepositories([]);
    await load();
  }

  async function saveRepositories(id: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/review-agent-tokens", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, repositories: draft }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { message?: string } | null;
    setBusy(false);
    if (!res?.ok) {
      setError(body?.message ?? "許可repositoryを保存できませんでした");
      return;
    }
    setEditingId(null);
    await load();
  }

  async function revoke(id: string) {
    setBusy(true);
    await fetch(`/api/settings/review-agent-tokens?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    await load();
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {issued && (
        <div className="rounded-lg border border-amber-500/50 p-3 text-xs">
          <p className="font-medium">「{issued.name}」のトークン（この表示は1回だけです。後から確認できません）</p>
          <code className="mt-1 block break-all rounded bg-muted p-2">{issued.token}</code>
        </div>
      )}
      {tokens && tokens.length === 0 && <p className="text-xs text-muted-foreground">発行済みのトークンはありません</p>}
      {tokens && tokens.length > 0 && (
        <ul className="flex flex-col gap-2">
          {tokens.map((token) => {
            const inactive = token.revokedAt !== null || (now !== null && new Date(token.expiresAt).getTime() <= now);
            return (
              <li key={token.id} className="flex flex-col gap-1 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">
                    {token.name} <span className="text-xs text-muted-foreground">{token.tokenPrefix}…</span>
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    {inactive && <Badge variant="outline">{token.revokedAt ? "失効" : "期限切れ"}</Badge>}
                    {!inactive && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={busy}
                        aria-label={`${token.name}の許可repositoryを編集`}
                        onClick={() => {
                          setEditingId(editingId === token.id ? null : token.id);
                          setDraft(token.repositories);
                        }}
                      >
                        <Pencil className="mr-1 size-3" />
                        許可repositoryを編集
                      </Button>
                    )}
                    {!token.revokedAt && (
                      <Button variant="ghost" size="icon" className="size-7" disabled={busy} aria-label={`${token.name}を失効`} onClick={() => void revoke(token.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {token.scopes.join("・")} ／ {token.repositories.join(", ")} ／ 期限 {formatDateTimeFull(token.expiresAt)}
                  {token.lastUsedAt ? ` ／ 最終更新操作 ${formatDateTimeFull(token.lastUsedAt)}` : ""}
                </p>
                {editingId === token.id && (
                  <div className="mt-1 flex flex-col gap-2 rounded-md border border-primary/50 p-2">
                    <RepositoryPicker options={available} selected={draft} original={token.repositories} onChange={setDraft} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={busy || draft.length === 0 || draft.length > MAX_REPOSITORIES} onClick={() => void saveRepositories(token.id)}>
                        保存
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingId(null)}>
                        キャンセル
                      </Button>
                      <span className="text-xs text-muted-foreground">保存後すぐ有効。トークンの値は変わりません</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <Label className="text-xs">名前（用途）</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="例: 外部エージェントA" />
        <Label className="text-xs">アクセスさせるrepository（issue-deckが管理しているものから選択。全許可はできません）</Label>
        <RepositoryPicker options={available} selected={repositories} onChange={setRepositories} />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {SCOPES.map((scope) => (
            <label key={scope.key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={scopes.includes(scope.key)}
                onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, scope.key] : cur.filter((s) => s !== scope.key)))}
              />
              {scope.label}
            </label>
          ))}
          <label className="flex items-center gap-1">
            有効期間
            <Input className="h-7 w-16" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />日
          </label>
        </div>
        <Button size="sm" disabled={busy || !name.trim() || repositories.length === 0 || repositories.length > MAX_REPOSITORIES || scopes.length === 0} onClick={() => void issue()}>
          トークンを発行
        </Button>
      </div>
    </div>
  );
}
