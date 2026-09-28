"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { GithubReferenceLink } from "@/components/dashboard/github-reference-link";
import { Button } from "@/components/ui/button";
import type { WebviewIosRepository } from "@/lib/webview-ios-repos";

/**
 * WebViewでネイティブアプリを包む形のiOSアプリ（`myroom`のkurashio等）への反映手順（#3579）。
 *
 * **Web側の変更か`ios/`側の変更かは自動判定しない**（`lib/webview-ios-repos.ts`のコメント参照）。
 * 「通常は再ビルド不要」と「Xcodeでの入れ直しが要る」の2つを並べて示し、どちらに当たるかは
 * 利用者が判断する。`aide-ios`と違い`main`へのマージ自体はこの画面のリリース進捗が正しく表す
 * （Web側は`deploy.yml`がそのまま反映するため）——ここに出すのは`ios/`側だけの追加手順。
 */
export function WebviewIosInstructions({ repo }: { repo: WebviewIosRepository }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(repo.command);
    } catch {
      // クリップボードが使えない環境ではコピーできていないので成功表示を出さない
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-3 rounded-md border border-dashed border-purple-400 bg-purple-50/60 px-3 py-3 text-xs dark:bg-purple-950/30">
      <p className="font-semibold">{repo.appLabel}（iOSアプリ）への反映</p>

      <div className="flex flex-col gap-0.5">
        <p className="font-medium">Webだけ更新（frontend・backendの変更）</p>
        <p className="text-muted-foreground">
          上のリリース進捗どおり本番デプロイまで進めば反映されます。アプリ本体の再ビルド・入れ直しは通常不要です。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="font-medium">アプリ本体の入れ直し（ios/・アプリアイコンの変更）</p>
        <ol className="list-decimal space-y-2 pl-4">
          <li>
            iPhoneをMac miniへUSB接続するか、ペアリング済みのネットワークで接続します。接続できていない間は実機へインストールできません。
          </li>
          <li>
            Mac miniへSSHで入り、下のコマンドを実行します。{repo.xcodeProjectPath}がXcodeで開きます。
            <code className="ml-1 rounded bg-background/70 px-1 font-mono">git status --short</code>
            に未コミット変更がある場合は、pull前に差分を確認してください。
          </li>
          <li>Xcodeで接続したiPhoneを実行先に選び、⌘Rで実機にインストール・起動します。</li>
          <li>実機でアプリの動作を確認します。</li>
        </ol>
        <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center">
          <code className="block min-w-0 whitespace-pre-wrap break-all rounded bg-background/70 px-2 py-1 font-mono select-all">
            {repo.command}
          </code>
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={handleCopy}>
            {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
            {copied ? "コピーしました" : "コピー"}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground">
        ログイン等の初回設定は
        {repo.setupReferences.map((ref, i) => (
          <span key={ref.url}>
            {i > 0 && "・"}
            <GithubReferenceLink href={ref.url} className="underline underline-offset-2 hover:text-foreground">
              {ref.label}
            </GithubReferenceLink>
          </span>
        ))}
        を参照してください。IssueDeckはXcodeでのビルド・端末接続・実機確認の結果を自動取得しません。上の手順で確認してください。
      </p>
    </div>
  );
}
