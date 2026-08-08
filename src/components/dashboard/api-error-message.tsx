"use client";

import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { GITHUB_REAUTH_REQUIRED_MESSAGE } from "@/lib/github/reauth-message";
import { startGithubOAuth } from "@/lib/supabase/github-oauth";

type ApiErrorMessageProps = {
  message: string | null;
};

/**
 * useIssueMutations/useIssueCommentMutations等のAPIエラーを表示する。
 * GitHubトークン失効時のメッセージの場合のみ、その場で再ログインできるボタンを添える。
 */
export function ApiErrorMessage({ message }: ApiErrorMessageProps) {
  const pathname = usePathname();

  if (!message) return null;

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-sm text-destructive">{message}</p>
      {message === GITHUB_REAUTH_REQUIRED_MESSAGE && (
        <Button variant="outline" size="xs" onClick={() => startGithubOAuth(pathname)}>
          GitHubに再ログイン
        </Button>
      )}
    </div>
  );
}
