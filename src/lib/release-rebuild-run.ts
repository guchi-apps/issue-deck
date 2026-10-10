import { closePullRequest } from "@/lib/github/actions-api";
import { createComment } from "@/lib/github/issues-api";
import {
  deleteBranch,
  dispatchReleaseWorkflow,
  type GithubApiPullRequest,
} from "@/lib/github/release-api";
import { releaseRebuildCloseComment, type ReleaseRebuildCandidate } from "@/lib/release-rebuild";
import type { BumpKind } from "@/lib/semver-bump";

/**
 * リリース候補の作り直しの実行（#3014・#4317）。画面の「修正を入れて作り直す」と、修正系列の
 * 自動作り直しが**同じ経路**を通る。凍結ブランチは書き換えず、閉じて消し、リリースworkflowを
 * 起動し直す（後継候補は現行の採番ルールでworkflowが作る）。
 *
 * **閉じてから起動する。** 先に起動すると、workflowの状態判定が「リリースPRが開いている」と見てスキップする。
 * 閉じたあとに起動だけが落ちた場合は、`onClosed`が先に呼ばれているので呼び出し側がそれと分かる。
 */
export async function rebuildReleaseCandidate(input: {
  owner: string;
  repo: string;
  token: string;
  releasePr: GithubApiPullRequest;
  candidate: ReleaseRebuildCandidate | null;
  bumpKind?: BumpKind;
  /** 追記するコメント（修正系列からの作り直しの経緯） */
  extraComment?: string;
  onClosed?: () => void;
}): Promise<true> {
  const { owner, repo, token, releasePr } = input;
  const base = releaseRebuildCloseComment(input.candidate);
  await createComment(owner, repo, releasePr.number, token, {
    body: input.extraComment ? `${base}\n\n${input.extraComment}` : base,
  });
  await closePullRequest(owner, repo, releasePr.number, token);
  input.onClosed?.();
  await deleteBranch(owner, repo, releasePr.head.ref, token);
  await dispatchReleaseWorkflow(owner, repo, token, input.bumpKind);
  return true;
}
