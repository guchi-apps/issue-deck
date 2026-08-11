"use client";

import { Loader2, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIssueMutations } from "@/hooks/use-issue-mutations";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { buildLocalSessionUrl, canStartLocalSession } from "@/lib/local-session";
import { hasSeenLocalSessionSetup, markLocalSessionSetupSeen } from "@/lib/local-session-setup";
import type { Issue } from "@/types/issue";

type StartLocalSessionButtonProps = {
  issue: Issue;
  onIssueUpdated: (issue: Issue) => void;
  /** 初回起動時にセットアップ手順を見せるためのコールバック（#1088） */
  onFirstLaunch: () => void;
  /**
   * 対象リポジトリがローカル起動プロトコルに適合しているか（#1073）。
   * リポジトリ情報が見つからない場合は`undefined`。そのときは隠さない。
   */
  hasLocalStartScript?: boolean;
};

/**
 * ローカル（WSL）のClaude Codeセッションをワンクリックで起動するボタン（#1049）。
 *
 * 画面からWSLのプロセスを直接起動する手段は無いため、Windows側に登録した`issuedeck://`
 * プロトコル経由で`scripts/start-local-session.sh`へ渡す。初回のみプロトコル登録が必要で、
 * 手順は[docs/multi-agent/local-quick-start.md](../../../docs/multi-agent/local-quick-start.md)。
 *
 * 起動前に`11.local`を付与するのは、無人実行（claude-issue-dispatch.yml）との二重起動を
 * 防ぐため。ラベル付与に失敗しても起動自体は妨げない（起動できないより、ラベルが遅れる方が軽い）。
 *
 * ローカル起動プロトコルに適合していないリポジトリでは出さない（#1073）。押しても受け口の
 * 段階で停止するだけで、押せること自体が誤解を招くため。
 */
export function StartLocalSessionButton({
  issue,
  onIssueUpdated,
  onFirstLaunch,
  hasLocalStartScript,
}: StartLocalSessionButtonProps) {
  const { updateIssue, isSubmitting, error } = useIssueMutations();

  const url = buildLocalSessionUrl(issue.repositoryFullName, issue.number);
  if (url === null || issue.state !== "open") return null;
  if (!canStartLocalSession(hasLocalStartScript)) return null;
  // 関数宣言は巻き上げられるため、上のnarrowingがhandleStart内へ伝わらない。改めて束ね直す。
  const sessionUrl: string = url;

  async function handleStart() {
    const labelNames = issue.labels.map((label) => label.name);
    if (!labelNames.includes(LOCAL_LABEL_NAME)) {
      const updated = await updateIssue({
        repositoryFullName: issue.repositoryFullName,
        number: issue.number,
        labels: [...labelNames, LOCAL_LABEL_NAME],
      });
      if (updated) onIssueUpdated(updated);
    }
    // プロトコル未登録の環境ではブラウザ側で無視されるだけで、ページ遷移は起きない。
    // その場合のフォールバックは「…」メニューの「ローカル起動コマンドをコピー」。
    window.location.href = sessionUrl;

    // 未登録かどうかは検知できない（#1088）ため、初回だけこちらからセットアップ手順を見せる。
    // 登録済みの環境では余計だが、一度きりなので押し付けにはならない。
    if (!hasSeenLocalSessionSetup()) {
      markLocalSessionSetupSeen();
      onFirstLaunch();
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={handleStart}
        disabled={isSubmitting}
        title="WSL上にworktreeと開発サーバーを用意し、Claude Codeセッションを起動します（初回のみプロトコル登録が必要）"
      >
        {isSubmitting ? <Loader2 className="animate-spin" /> : <Terminal />}
        ローカルで開始
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </>
  );
}
