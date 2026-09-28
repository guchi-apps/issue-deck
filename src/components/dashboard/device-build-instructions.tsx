"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DEVELOP_BRANCH, MAIN_BRANCH } from "@/lib/branch-flow";
import type { DeviceBuildRepository } from "@/lib/device-build-repos";

/** コミットOIDを画面に出す短い形（`git log --oneline`と同じ7桁） */
export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/**
 * Xcodeで実機へ反映するリポジトリ（`aide-ios`。#3468）の、Macで打つ手順とコマンド。
 *
 * **ブランチ画面とリリース画面の両方から使う**（#3579）。文言が2箇所で食い違わないよう、
 * ここへ寄せてある。リリース画面は`main`の先頭（`installed`）を持たないため、
 * `buildTargetOid`は省略可能——渡さなければ「今回ビルドする〜の先頭は…」の一文だけ出さない。
 *
 * **画面からはマージさせない。** 画面でマージすると、ビルドしていない版が実機に入ったように
 * mainへ記録される。スクリプトはビルドしたコミットでだけマージする
 * （`gh pr merge --match-head-commit`）ので、ここに出すのはコマンドとビルド対象の版まで。
 */
export function DeviceBuildInstructions({
  deviceBuild,
  buildTargetOid = null,
}: {
  deviceBuild: Pick<DeviceBuildRepository, "command">;
  /** 今回ビルドする`develop`の先頭OID。取得できない場所（リリース画面）では省略する */
  buildTargetOid?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(deviceBuild.command);
    } catch {
      // クリップボードが使えない環境ではコピーできていないので成功表示を出さない
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-2 rounded-md border border-dashed border-purple-400 bg-purple-50/60 px-3 py-3 text-xs dark:bg-purple-950/30">
      <p className="font-semibold">AIDE-iosを実機へ反映する手順</p>
      <ol className="list-decimal space-y-2 pl-4">
        <li>
          バージョンをまだ上げていなければ、
          <code className="rounded bg-background/70 px-1 font-mono">
            gh workflow run release-develop-to-main.yml --repo guchi-apps/aide-ios
          </code>
          でバンプPRを作り、{DEVELOP_BRANCH}へマージします。バンプ済みなら再実行は不要です。
        </li>
        <li>
          iPhoneをMac miniへUSB接続するか、ペアリング済みのネットワークで接続します。
          Macで<code className="rounded bg-background/70 px-1 font-mono">xcrun devicectl list devices</code>
          を実行し、対象iPhoneが<code className="rounded bg-background/70 px-1 font-mono">connected</code>
          と表示されることを確かめてください。持ち出したiPhoneがMacから見えない間は、直接インストールできません。
        </li>
        <li>
          Mac miniへSSHで入り、下のコマンドを実行します。
          {buildTargetOid && (
            <>
              {" "}今回ビルドする{DEVELOP_BRANCH}の先頭は
              <code className="rounded bg-background/70 px-1 font-mono">
                {shortOid(buildTargetOid)}
              </code>
              です。
            </>
          )}
        </li>
        <li>
          インストール・起動後、iPhoneで動作を確認します。SSHの入力待ちへ戻り、
          <code className="rounded bg-background/70 px-1 font-mono">release</code>
          と入力します。接続・署名・インストールで止まった場合、{MAIN_BRANCH}は変わりません。
        </li>
        <li>
          リリースPRのCIとマージ、タグ作成が終わり、ターミナルに
          <code className="rounded bg-background/70 px-1 font-mono">完了: main @ ...</code>
          と表示されたら反映完了です。
        </li>
      </ol>
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center">
        <code className="block min-w-0 whitespace-pre-wrap break-all rounded bg-background/70 px-2 py-1 font-mono select-all">
          {deviceBuild.command}
        </code>
        <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={handleCopy}>
          {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          {copied ? "コピーしました" : "コピー"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        IssueDeckはMacのビルド・端末接続・実機確認の結果を自動取得しません。上の手順で確認してください。
      </p>
    </div>
  );
}
