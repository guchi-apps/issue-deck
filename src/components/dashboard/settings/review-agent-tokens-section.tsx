"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

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
  const [repositories, setRepositories] = useState("");
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
    setTokens(((await res.json()) as { tokens: TokenRow[] }).tokens);
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
        repositories: repositories.split(/[\s,]+/).filter(Boolean),
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
    setRepositories("");
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
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <Label className="text-xs">名前（用途）</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="例: 外部エージェントA" />
        <Label className="text-xs">アクセスさせるrepository（owner/name。空白かカンマ区切り。全許可はできません）</Label>
        <Input value={repositories} onChange={(e) => setRepositories(e.target.value)} placeholder="guchi-apps/issue-deck" />
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
        <Button size="sm" disabled={busy || !name.trim() || !repositories.trim() || scopes.length === 0} onClick={() => void issue()}>
          トークンを発行
        </Button>
      </div>
    </div>
  );
}
