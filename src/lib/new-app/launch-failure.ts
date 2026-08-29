/**
 * 新規アプリの立ち上げ（`POST /api/new-app`）が途中で投げた例外の振り分け（#2442）。
 *
 * **`withUserGithubToken`は401を受けるとトークンを延長して`fn`を先頭から呼び直す。**
 * `POST /api/issues`のように書き込みが1回なら安全だが、立ち上げはリポジトリ作成 → 雛形の
 * コミット → `develop` → ラベル複製 → 親Issue → ポート帯のPull Request → 手作業Issue…と
 * 十数回の書き込みを直列に行うため、**非冪等**で呼び直せない。呼び直すと先頭の
 * `repositoryExists`が自分でさっき作ったリポジトリを見つけ、原因と食い違う
 * `repository_taken`（「リポジトリ名は既に使われています」）で終わり、残りのIssueが
 * 作られないまま立ち上げが中断する。
 *
 * そこで**まだ何も作っていないときだけ401を投げ直す**。1つでも作った後は投げ直さず、
 * `launch_failed`として`created`と一緒に画面へ返し、続きは作られたIssueから人が進める。
 */

import { GithubApiError } from "@/lib/github/github-api-error";
import type { NewAppArtifactKind, NewAppCreatedRef } from "@/lib/new-app/plan";

export type NewAppFailureReason =
  | "repository_taken"
  | "hostname_taken"
  | "port_band_unavailable"
  | "launch_failed";

export type NewAppLaunchFailure = {
  step: NewAppArtifactKind;
  reason: NewAppFailureReason;
  message?: string;
};

/** 作りかけを残したまま認証が切れたときに画面へ出す文言。押し直しても直らないことを伝える */
export const LAUNCH_UNAUTHORIZED_MESSAGE =
  "作成の途中でGitHubの認証が切れました（401）。ここまでに作られたものはそのまま残っています。" +
  "同じ内容で押し直してもリポジトリ名の重複で弾かれるため、続きは作成済みのIssueから進めてください。";

export type LaunchErrorDecision =
  /** `withUserGithubToken`へ投げ直し、トークンを延長して最初からやり直させる */
  | { rethrow: true }
  /** 投げ直さず、`created`と一緒に失敗として返す */
  | { rethrow: false; failure: NewAppLaunchFailure };

/**
 * 立ち上げが投げた例外を「投げ直す」か「失敗として返す」かに振り分ける。
 *
 * 投げ直すのは**401で、かつまだ何も作っていない**ときだけ。それ以外は`launch_failed`にする。
 */
export function decideLaunchError(
  error: unknown,
  created: NewAppCreatedRef[],
): LaunchErrorDecision {
  const unauthorized = error instanceof GithubApiError && error.status === 401;
  if (unauthorized && created.length === 0) {
    return { rethrow: true };
  }

  return {
    rethrow: false,
    failure: {
      step: created.length > 0 ? created[created.length - 1].kind : "repository",
      reason: "launch_failed",
      message: unauthorized
        ? LAUNCH_UNAUTHORIZED_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error),
    },
  };
}
