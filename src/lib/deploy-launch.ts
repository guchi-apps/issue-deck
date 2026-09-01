import type { DeployWorkflowRunRef } from "@/lib/github/release-api";

/**
 * mainへマージした後、本番デプロイ（`deploy.yml`）が本当に起動したかを見張って、
 * 起動していなければ起動し直すための判定（#2703）。
 *
 * ## なぜ要るのか
 *
 * **GitHubはmainへのマージに対してワークフローを1件も作らないことがある。**
 * `guchi-apps/myroom`のv4.8.0では、リリースPR #312をissue-deckがマージしたのに
 * `deploy.yml`が1件も起動せず、本番が約20分間v4.7.0のまま残った（myroom#315）。
 * マージコミットのcheck-suiteは**0件**で、`push`だけでなく`pull_request(closed)`も
 * 同時に起動していない。つまり落ちていたのはワークフローの定義ではなく**イベントの配送**で、
 * 発生頻度は実測でmainへのマージ55件中1件（約2%）。
 *
 * **アプリ側のトリガー設定では直せない。** `on:`で決められるのは「届いたイベントに
 * どう反応するか」だけで、イベント自体が届いていないときに効くものが無い。
 *
 * **`deploy-retry.yml`（`reusable-deploy-retry.yml`）でも直らない。** あれは
 * *起動したデプロイが失敗したとき*の再実行で、*そもそも起動しなかったとき*には何もしない。
 *
 * ## なぜissue-deckが直す場所なのか
 *
 * マージした主体だけが**マージコミットのSHAを知っている**。イベントの配送に依存せず、
 * ポーリングで「このコミットに対する実行が作られたか」を確かめられるのはここだけで、
 * だから唯一「即時に」直せる。
 *
 * 対象リポジトリ側の見張り（myroomの`deploy-watchdog.yml`）は即時性を持てない。
 * `schedule`は当てにならず（myroomの15分ごとのscheduleは実測で1日5〜8回＝期待96回の約6%しか起動していない）、
 * `workflow_run`へ相乗りさせても、そのリポジトリに活動が無い時間帯は検知が遅れる。
 *
 * ## 起動し直すときは必ず`main`から
 *
 * リリースブランチのrefから起動すると、`deploy.yml`の`tag`ジョブが`v<version>`を
 * **main上に無いコミットへ付けてしまい**、以後mainから起動したデプロイがタグ検証で必ず失敗する
 * （myroom#315で実際に起きた）。起動は`dispatchDeployWorkflow`（`ref: "main"`固定）で行う。
 *
 * ここはIOを持たない判定だけの層で、GitHubを叩く側は
 * [`github/deploy-launch-sweep-run.ts`](./github/deploy-launch-sweep-run.ts)。
 */

/** 猶予の既定値（秒）。この時間内に実行が現れなければ起動し直す */
const DEFAULT_GRACE_SECONDS = 90;

/**
 * 見張りを諦めるまでの既定時間（分）。
 *
 * 起動し直しに失敗し続けるケース（権限・GitHubの障害）で、行が`pending`のまま残り続けるのを防ぐ。
 * 諦めても本番が古いままなのは`deploy-failure`の巡回（#2236）とブランチ画面が別に拾う。
 */
const DEFAULT_GIVE_UP_MINUTES = 30;

/** 起動し直しを試す回数の上限。使い切ったら`failed`にする */
export const DEPLOY_LAUNCH_MAX_ATTEMPTS = 3;

/** 決着した記録を残しておく日数。過ぎた行は巡回が消す */
export const DEPLOY_LAUNCH_RETENTION_DAYS = 7;

/**
 * 猶予（秒）。**0にすると見張りごと無効**（他の巡回の`0`と同じ扱い）。
 *
 * 既定が90秒なのは、正常時のcheck-suiteがマージの2〜5秒後には作られるため
 * （v4.7.0の`62ea22e`は2件）。60秒でも足りるが、GitHubが混んでいるときの遅れと
 * pollerの1巡（30秒）ぶんの誤差を見て余裕を取ってある。
 */
export function deployLaunchGraceSeconds(
  raw: string | undefined = process.env.DEPLOY_LAUNCH_GRACE_SECONDS,
): number {
  return nonNegativeNumber(raw, DEFAULT_GRACE_SECONDS);
}

/** 見張りを諦めるまでの時間（分）。0にすると諦めない */
export function deployLaunchGiveUpMinutes(
  raw: string | undefined = process.env.DEPLOY_LAUNCH_GIVE_UP_MINUTES,
): number {
  return nonNegativeNumber(raw, DEFAULT_GIVE_UP_MINUTES);
}

function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** 見張っているマージ1件ぶん（DBの行のうち判定に要るところだけ） */
export type DeployLaunchWatchInput = {
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  mergeCommitSha: string;
  mergedAt: Date;
  attempts: number;
};

export type DeployLaunchDecision =
  /** 実行を確認できた。見張りを畳む */
  | { kind: "covered"; runUrl: string | null }
  /** まだ猶予の中。次の巡回で見直す */
  | { kind: "wait" }
  /** 猶予を過ぎても実行が無い。`deploy.yml`を`main`から起動し直す */
  | { kind: "dispatch" }
  /** 猶予をはるかに過ぎた・試行回数を使い切った。諦める */
  | { kind: "give_up"; reason: "attempts" | "timeout" };

/**
 * その実行が、このマージの中身を本番へ出すものかどうか。
 *
 * 3つのうちどれかを満たせば「出している」と見なす。
 *
 * 1. **`head_sha`がマージコミットと一致する** — mainへのpushで起動した本来の実行
 * 2. **`head_commit.tree_id`がマージコミットのtreeと一致する** — 手動デプロイが別のrefから
 *    起動されていた場合。SHAは一致しないが中身は同じで、出し直す意味が無い
 * 3. **mainブランチで、マージより後に作られた実行** — 後続のマージ・手動デプロイが
 *    main先端を出しており、そこにはこのマージも含まれている（mainは巻き戻さない運用）
 *
 * 3が要るのは、マージが立て続けに起きたときに「自分のSHAの実行だけが無い」状態が
 * 正常にも起きうるため。ここを見ないと、既に新しい版が出ているのに出し直してしまう
 * （`deploy.yml`は`cancel-in-progress: true`なので、走っている本物を巻き込んで止める）。
 */
export function isRunCoveringMerge(
  run: DeployWorkflowRunRef,
  watch: { mergeCommitSha: string; mergedAt: Date },
  mergeTreeSha: string | null = null,
): boolean {
  if (run.headSha !== "" && run.headSha === watch.mergeCommitSha) return true;
  if (mergeTreeSha !== null && run.headTreeSha !== null && run.headTreeSha === mergeTreeSha) {
    return true;
  }
  if (run.headBranch === "main" && run.createdAt !== "") {
    const createdAt = new Date(run.createdAt);
    if (!Number.isNaN(createdAt.getTime()) && createdAt.getTime() >= watch.mergedAt.getTime()) {
      return true;
    }
  }
  return false;
}

/**
 * 見張り1件をどうするかを決める。
 *
 * `mergeTreeSha`は**起動し直す直前にだけ**渡す（取得に1回APIを使うので、猶予の中では引かない）。
 * 渡さない場合はtreeでの照合を行わず、SHAと時刻だけで判定する。
 */
export function decideDeployLaunch({
  watch,
  runs,
  now,
  graceSeconds = deployLaunchGraceSeconds(),
  giveUpMinutes = deployLaunchGiveUpMinutes(),
  mergeTreeSha = null,
}: {
  watch: DeployLaunchWatchInput;
  runs: DeployWorkflowRunRef[];
  now: Date;
  graceSeconds?: number;
  giveUpMinutes?: number;
  mergeTreeSha?: string | null;
}): DeployLaunchDecision {
  const covering = runs.find((run) => isRunCoveringMerge(run, watch, mergeTreeSha));
  if (covering) return { kind: "covered", runUrl: covering.htmlUrl || null };

  const elapsedMs = now.getTime() - watch.mergedAt.getTime();
  if (elapsedMs < graceSeconds * 1000) return { kind: "wait" };

  if (watch.attempts >= DEPLOY_LAUNCH_MAX_ATTEMPTS) {
    return { kind: "give_up", reason: "attempts" };
  }
  if (giveUpMinutes > 0 && elapsedMs >= giveUpMinutes * 60_000) {
    return { kind: "give_up", reason: "timeout" };
  }
  return { kind: "dispatch" };
}

/**
 * 起動し直したことをマージ済みPRへ残すコメント。
 *
 * **「issue-deckが勝手にデプロイを走らせた」に見えないよう、何が起きていたのかまで書く。**
 * 開くのはリリースを回した本人で、通知だけ見て「なぜ2回目が走ったのか」を調べ直すことになる。
 */
export function buildDeployLaunchDispatchComment(params: {
  mergeCommitSha: string;
  graceSeconds: number;
}): string {
  const shortSha = params.mergeCommitSha.slice(0, 7);
  return [
    "🚀 **本番デプロイ（`deploy.yml`）を起動し直しました。**",
    "",
    `このPRをmainへマージした後、マージコミット \`${shortSha}\` に対する \`deploy.yml\` の実行が` +
      `${params.graceSeconds}秒待っても1件も作られなかったため、issue-deckが \`main\` から起動し直しました。`,
    "",
    "GitHubがマージのイベントを配送し損ねると、ワークフローの定義が正しくても実行が1件も" +
      "作られないことがあります（実測でmainへのマージ55件中1件）。`deploy-retry.yml` は" +
      "*起動したデプロイが失敗したとき*の再実行なので、この状態では動きません。",
    "",
    "Actionsの「Deploy to Production」に `workflow_dispatch` の実行が出ているはずです。" +
      "**失敗している場合は本番が古い版のままなので、実行ログを確認してください。**",
    "",
    "<!-- issue-deck:deploy-launch-dispatched -->",
  ].join("\n");
}

/** 起動し直しにも失敗したときのコメント。**人が押しに行くしかないので、押す場所まで書く** */
export function buildDeployLaunchFailedComment(params: {
  mergeCommitSha: string;
  repositoryFullName: string;
  reason: string;
}): string {
  const shortSha = params.mergeCommitSha.slice(0, 7);
  return [
    "⚠️ **本番デプロイ（`deploy.yml`）が起動しておらず、起動し直しにも失敗しました。**",
    "",
    `マージコミット \`${shortSha}\` に対する \`deploy.yml\` の実行が作られておらず、` +
      "issue-deckからの起動も失敗しました。**本番は古い版のままです。**",
    "",
    `- 失敗の内容: \`${params.reason}\``,
    `- 手で起動する場合: \`gh workflow run deploy.yml --repo ${params.repositoryFullName} --ref main\``,
    "",
    "**`--ref main` 以外から起動しないでください。** リリースブランチのrefから起動すると" +
      "`tag`ジョブが `v<version>` をmain上に無いコミットへ付けてしまい、以後mainから起動した" +
      "デプロイがタグ検証で必ず失敗します（guchi-apps/myroom#315）。",
    "",
    "<!-- issue-deck:deploy-launch-failed -->",
  ].join("\n");
}
