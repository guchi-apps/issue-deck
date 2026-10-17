"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMonthDayTime } from "@/lib/format-date-time";
import { PRODUCTION_ATTESTATION_NOTE_MIN } from "@/lib/release-production-verification";
import type { RcProductionView } from "@/lib/release-production-verification-run";

/**
 * mainへ出した候補の稼働版の確認（#4713）。公開準備パネルの中に出す。
 *
 * - repoの種類（deploy.ymlの照合の有無・ソース配布）と、完了にした方式・待っている理由を出す
 * - deploy.ymlが稼働SHAを照合しないrepoでは、稼働版を返す公開URLの登録と、人の確認の記録を受け付ける。
 *   **人の確認は記録で、それだけでは完了にしない**（公開URLが別の版を返していれば完了にならない）
 * - ソース配布のrepo（pi0w）はソース公開までを完了とし、実機配備は別管理であることを明記する
 */

const ERROR_LABEL: Record<string, string> = {
  forbidden: "このリポジトリのadmin/maintain権限が必要です",
  invalid_url: "https:// で始まる公開URLを入力してください（IPアドレス・ポート指定・内部ホスト名は使えません）",
  invalid_request: `確かめた内容を${PRODUCTION_ATTESTATION_NOTE_MIN}文字以上で書いてください`,
  not_attestable: "対象コミットのdeployが成功していないため、まだ確定できません",
  stale_target: "画面が古いため受け付けませんでした。再読み込みしてからやり直してください",
  already_attested: "すでに確認が記録されています",
  not_found: "候補が見つかりません",
};

export function ProductionVerificationBox({
  production,
  phase,
  repositoryFullName,
  candidateId,
  onChanged,
}: {
  production: RcProductionView;
  phase: string;
  repositoryFullName: string;
  candidateId: string;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState(production.endpointUrl ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const completed = phase === "completed";
  const sourceOnly = production.targetKind === "source_publish_only";
  const canProbe = production.targetKind === "deploy_without_version_check" || production.targetKind === "deploy_version_check";

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    const [owner, repo] = repositoryFullName.split("/");
    try {
      const res = await fetch("/api/repositories/release/production-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, repo, candidateId, ...body }),
      });
      const result: { ok?: boolean; error?: string; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) {
        setMessage(result.message ?? ERROR_LABEL[result.error ?? ""] ?? `受け付けられませんでした (${res.status})`);
        return;
      }
      setNote("");
      onChanged();
    } catch {
      setMessage("通信に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border" data-testid="release-rc-production">
      <h4 className="border-b px-3 py-2 text-[12.5px] font-semibold">稼働版の確認</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-[12px]">
        <dt className="text-muted-foreground">方式</dt>
        <dd className="break-words">{production.targetLabel}</dd>
        <dt className="text-muted-foreground">対象</dt>
        <dd className="font-mono">{production.mergeSha.slice(0, 7)}</dd>
        {!sourceOnly && production.targetKind !== "unknown" && (
          <>
            <dt className="text-muted-foreground">deploy</dt>
            <dd>
              {production.deploySucceeded ? "成功" : "未成功"}
              {production.deployRunUrl && (
                <>
                  {" "}
                  <a className="underline" href={production.deployRunUrl} target="_blank" rel="noreferrer">
                    run
                  </a>
                </>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">結果</dt>
        <dd className="break-words">
          {production.methodLabel
            ? `${production.methodLabel}で確認済み${production.verifiedAt ? `（${formatMonthDayTime(production.verifiedAt)}）` : ""}`
            : (production.waitingLabel ?? "確認中")}
        </dd>
        {sourceOnly && (
          <>
            <dt className="text-muted-foreground">実機配備</dt>
            <dd className="text-muted-foreground">ソース公開とは別に管理します。ここでの完了は実機での稼働を意味しません</dd>
          </>
        )}
        {production.probe && (
          <>
            <dt className="text-muted-foreground">外部照合</dt>
            <dd className="break-words">
              {production.probe.detail}（{formatMonthDayTime(production.probe.at)}）
            </dd>
          </>
        )}
        {production.attestation && (
          <>
            <dt className="text-muted-foreground">人の確認</dt>
            <dd className="whitespace-pre-wrap break-words">
              {production.attestation.note}（{formatMonthDayTime(production.attestation.at)}）
            </dd>
          </>
        )}
      </dl>

      {!completed && canProbe && (
        <div className="flex flex-col gap-1.5 border-t px-3 py-2">
          <label className="text-[12px] font-semibold" htmlFor="production-endpoint-url">
            稼働版を返す公開URL
          </label>
          <p className="text-[11.5px] text-muted-foreground">
            {'`{"sha":"<コミット>"}`か`{"version":"<版>"}`を返すURLを登録すると、issue-deckが外から照合します。旧版が応答している間は完了にしません。'}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              id="production-endpoint-url"
              type="url"
              inputMode="url"
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-[12px]"
              placeholder="https://example.com/api/app-version"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <Button size="sm" variant="outline" onClick={() => post({ action: "set_endpoint", url: url.trim() })} disabled={busy}>
              {url.trim() === "" && production.endpointUrl ? "登録を外す" : "登録して照合する"}
            </Button>
          </div>
        </div>
      )}

      {!completed && production.canAttest && (
        <div className="flex flex-col gap-1.5 border-t px-3 py-2">
          <label className="text-[12px] font-semibold" htmlFor="production-attestation-note">
            確かめた内容を書いて確定する
          </label>
          <p className="text-[11.5px] text-muted-foreground">
            本番で{production.mergeSha.slice(0, 7)}が稼働していることを何で確かめたか（画面の版表示・サーバー上のファイル・ログなど）を書いてください。記録として残り、公開URLが別の版を返している間は完了になりません。
          </p>
          <textarea
            id="production-attestation-note"
            className="min-h-[72px] rounded-md border bg-background px-2 py-1.5 text-[12px]"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy}
          />
          <div>
            <Button
              size="sm"
              onClick={() => post({ action: "attest", expectedMergeSha: production.mergeSha, note: note.trim() })}
              disabled={busy || note.trim().length < PRODUCTION_ATTESTATION_NOTE_MIN}
            >
              {busy ? "記録しています…" : "確認を記録する"}
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className="border-t px-3 py-2 text-[11.5px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
