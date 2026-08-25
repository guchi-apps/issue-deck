/**
 * developへのマージ後に取り残された進捗を**issue-deck側から巡回して回収する**（#2294）。
 *
 * ## なぜGitHub Actionsのscheduleから移したか
 *
 * この巡回は`reusable-issue-labels.yml`の`develop-merge-sweep`ジョブだった。
 * caller（各リポジトリの`issue-labels.yml`）の`schedule:`（15分ごとのcron）で起き、
 * `manual-step-label`とあわせて**毎回2ジョブ**を立ち上げていた。
 *
 * Actionsの課金はジョブ単位の1分未満切り上げなので、実測で20秒・5秒しか動かない2ジョブでも
 * 1回の実行で2分が課金される。publicリポジトリは全額割引で$0だが、privateリポジトリ
 * （`vps`・`subpc`・`docs`・`claude-config`）はそのまま従量課金になり、2026年8月に
 * 無料枠が枯れた時点でActionsの請求のほぼ全部がこの2ジョブになっていた
 * （[docs/github-billing.md](../../../docs/github-billing.md)）。
 *
 * 一方で、**同じ「全リポジトリを巡回する安全網」はissue-deckに既に2本ある**
 * （コンフリクト巡回#2116・デプロイ失敗巡回#2236）。サブPCのpollerが1巡ごとに叩き、
 * issue-deckが連携済みリポジトリ全部を見る形で、Actionsの実行を1回も起こさない。
 * この巡回もその3本目として置き直す。
 *
 * 移すと課金が消えるだけでなく**速くなる**。GitHubのscheduleはcronに15分と書いても
 * そのとおりには走らず、実測は24〜36分間隔だった（`conflict-sweep.ts`のヘッダー参照）。
 * pollerは30秒ごとに呼ぶので、間隔を決めるのはissue-deck側の
 * `PROGRESS_SWEEP_INTERVAL_MINUTES`（既定5分）だけになる。
 *
 * ## 何を回収するか
 *
 * `Develop PR`・`Implementation`にいるopenなIssueについて、対応ブランチ（`issue-<番号>`）から
 * developへのPRが既にマージ済みかを確かめ、マージ済みなら`Develop`へ進める。
 *
 * **`Implementation`も対象にするのは、`Develop PR`へ一度も到達しないまま取り残される
 * ケースがあるため**（#1861）。PR作成時の進捗報告が一時的な5xxで失敗するとStatusは
 * `Implementation`のまま動かず、そのまま人がPRをマージし、マージ時の報告も同じ時間帯の
 * API不調で落ちると、拾い直す経路がどこにも無かった。
 *
 * ただし`Implementation`には「developへマージしたあと追加対応でブランチへpushした」正規の
 * 状態も含まれる。マージ済みPRがあるだけで進めると実装中のIssueを勝手に動かすため、
 * **マージ済みPRの先端と現在のブランチの先端が一致するか**を必ず確かめる。
 *
 * **先端が一致しないときに黙って見送らない**（#1999）。先端不一致には「追加対応で実装中」
 * だけでなく「PRのマージとほぼ同時にpushされ、どのPRにも載らないままdevelopへ入らない
 * コミット」も含まれる。従来はどちらも見送るだけだったため、後者は15分ごとに見送られ続ける
 * だけで誰にも伝わらなかった（guchi-apps/subscription-lists#99で実測。本番の画面が404の
 * まま残った）。developへ入っていないコミットの有無を比較で確かめ、猶予時間を過ぎても
 * develop向けPRが開かれないものへ`00.check-user`＋`01.check-blocked`を付けて通知する。
 *
 * あわせて、**developへのマージ時に外しそこねた`00.check-user`も外す**（#2335）。外す役は
 * PRのマージを受け取るワークフローだけで再試行が無く、GitHubの一時的な5xxに当たると、
 * 次のmainリリース（`main-pr-merged`）かIssueのcloseまで確認待ちが残る。
 * 判定は`decideStaleCheckUser`。
 *
 * **判定はこの純粋関数に閉じる。** 「進める」「取り残しとして通知する」「見送る」の分岐は
 * 人の目を通らないまま進捗とラベルを書き換えるため、IOから切り離してテストできる形にする
 * （コンフリクト巡回の`decideConflictSweep`と同じ分け方）。IOは
 * [`progress-sweep-run.ts`](./progress-sweep-run.ts)。
 */

/** 巡回の間隔（分）の既定値。`PROGRESS_SWEEP_INTERVAL_MINUTES`で変えられる */
export const PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES = 5;

/**
 * 取り残しを通知するまでの猶予（分）。
 *
 * 先端不一致が「追加対応で実装中」なのか「取り残し」なのかは、その瞬間には区別が付かない。
 * (1)developへのPRが開いていない (2)最後のコミットから猶予時間が過ぎている の両方を
 * 満たすものだけを取り残しとして扱う。**回数ではなく時間で見るのは、巡回が実行間の状態を
 * 持たないため**（#1999。ジョブだった頃からの制約で、移した後も同じ値にしてある）。
 */
export const PROGRESS_SWEEP_STRANDED_GRACE_MINUTES = 120;

/** 巡回が投稿するコメントの発信元マーカー（`comment-source.ts`のid） */
const COMMENT_SOURCE_MARKER = "<!-- issue-deck-source:progress-sweep -->";

/** 見送った理由。ログにそのまま出す（なぜ動かなかったのかを後から追うため） */
export type ProgressSweepSkipReason =
  /** developへマージ済みのPRがまだ無い（大多数はこれ） */
  | "no_merged_pr"
  /** developとの比較を取得できなかった。次の巡回で再判定する */
  | "compare_unavailable"
  /** developへ入っていないコミットがあるが、develop向けPRが開いている（実装中） */
  | "develop_pr_open"
  /** 取り残しの疑いはあるが、最後のコミットから猶予時間が経っていない */
  | "within_grace"
  /** 同じ先端についての取り残しを既に通知済み（判定後に既存コメントを見て分かる） */
  | "already_notified"
  /** 滞留した`00.check-user`の確認で、まだ開いているPRがあった（本当にマージ待ち） */
  | "check_user_pr_open"
  /** 滞留した`00.check-user`の確認で、`issue-<番号>`のマージ済みPRが無かった */
  | "check_user_no_merged_pr"
  /** 滞留した`00.check-user`の確認で、付与がマージより後だった（事後確認・人が付けたもの） */
  | "check_user_after_merge";

/** developとの三点比較の結果。取得できなかった場合はIO側が`null`を渡す */
export type ProgressSweepCompare = {
  /** developへ入っていないコミット数 */
  aheadBy: number;
  /**
   * developへ持ち込む変更のファイル数。**応答に`files`が無ければ`null`。**
   *
   * コミット数だけでは取り残しと言えない（#2289）。コンフリクト解消のワークフローと
   * ローカルセッションが同じコンフリクトを別々に解消し、PRには片方だけが載ってマージ
   * された場合、残るのは中身の同じマージコミットだけになる（#2249で`aheadBy=2`・
   * 変更ファイル0件のIssueに`00.check-user`が付いた）。三点比較なので`files`が空＝
   * マージしても何も入らない。
   *
   * **`null`（読めなかった）は従来どおり取り残しとして扱う。** 応答の形が変わったのを
   * 「変更なし」と読み違えると、本物の取り残しを黙って見送ることになる。
   */
  changedFiles: number | null;
  /** developへ入っていない最後のコミットの時刻（ISO8601）。取れなければ`null` */
  lastCommitAt: string | null;
};

/** 1つのIssueについて、判定に必要な事実をすべて解決したもの */
export type ProgressSweepFacts = {
  /** 直近のマージ済み`issue-<番号>`→developのPR。無ければ`null` */
  mergedPullRequest: { url: string; headSha: string } | null;
  /** ブランチ`issue-<番号>`の先端。**マージ後に削除済みなら`null`**（追加のpushが無い証拠） */
  branchHead: string | null;
  /** developとの比較。`needsStrandedCheck`が`false`のときは参照しない */
  compare: ProgressSweepCompare | null;
  /** 開いているdevelop向けPRがあるか */
  hasOpenDevelopPullRequest: boolean;
};

export type ProgressSweepDecision =
  /** `Develop`へ進める */
  | { action: "advance"; pullRequestUrl: string }
  /** developへ入らないコミットが残っている。`00.check-user`＋`01.check-blocked`で人へ渡す */
  | {
      action: "notify_stranded";
      pullRequestUrl: string;
      pullRequestHeadSha: string;
      branchHead: string;
      aheadBy: number;
      ageMinutes: number;
    }
  | { action: "skip"; reason: ProgressSweepSkipReason };

/**
 * developとの比較まで見に行く必要があるか。
 *
 * **ブランチが消えている（`null`）なら追加のpushは無い**ので、先端の一致を確かめるまでもなく
 * 進めてよい。比較のREST（`GET /repos/{owner}/{repo}/compare/...`）はこれが`true`のときだけ
 * 投げる——先端が一致するのが平常なので、平常時の消費を1回ぶん増やさないため。
 */
export function needsStrandedCheck(branchHead: string | null, mergedHeadSha: string): boolean {
  return branchHead !== null && branchHead !== mergedHeadSha;
}

/** このIssueをどう扱うか。事実の取得に失敗したものはIO側が判定にかけず、次の巡回へ回す */
export function decideProgressSweep(
  facts: ProgressSweepFacts,
  context: { now: Date; graceMinutes?: number },
): ProgressSweepDecision {
  const merged = facts.mergedPullRequest;
  if (!merged) return { action: "skip", reason: "no_merged_pr" };

  if (!needsStrandedCheck(facts.branchHead, merged.headSha)) {
    return { action: "advance", pullRequestUrl: merged.url };
  }
  // needsStrandedCheckがtrueなら`branchHead`は必ず文字列
  const branchHead = facts.branchHead as string;

  const compare = facts.compare;
  if (!compare) return { action: "skip", reason: "compare_unavailable" };

  // developへ入っていないコミットが無い（または持ち込む変更が無い）なら、先端が違っても
  // 取り残しは無いのでそのまま進めてよい。人がcherry-pick等で解消した後にここで
  // 止まり続けないための経路でもある。
  if (compare.aheadBy === 0 || compare.changedFiles === 0) {
    return { action: "advance", pullRequestUrl: merged.url };
  }

  if (facts.hasOpenDevelopPullRequest) return { action: "skip", reason: "develop_pr_open" };
  if (!compare.lastCommitAt) return { action: "skip", reason: "compare_unavailable" };

  const lastCommitMs = Date.parse(compare.lastCommitAt);
  if (Number.isNaN(lastCommitMs)) return { action: "skip", reason: "compare_unavailable" };

  const ageMinutes = Math.floor((context.now.getTime() - lastCommitMs) / 60_000);
  const grace = context.graceMinutes ?? PROGRESS_SWEEP_STRANDED_GRACE_MINUTES;
  if (ageMinutes < grace) return { action: "skip", reason: "within_grace" };

  // 「同じ先端について通知済みか」はここでは見ない。**既存コメントの取得はGitHub APIを
  // 消費する**ので、書く直前（この関数が`notify_stranded`を返した後）にIOが
  // `hasStrandedNotice`で確かめる。見送るだけの巡回でコメントを引かないため。
  return {
    action: "notify_stranded",
    pullRequestUrl: merged.url,
    pullRequestHeadSha: merged.headSha,
    branchHead,
    aheadBy: compare.aheadBy,
    ageMinutes,
  };
}

/**
 * 滞留した`00.check-user`の判定に使う、`issue-<番号>`ブランチのPull Request1件ぶん。
 * 見るのは状態とマージ済みかだけで、baseがdevelopかmainかは問わない。
 */
export type StaleCheckUserPullRequest = {
  /** `open` / `closed` */
  state: string;
  /** マージされた時刻（ISO8601）。マージされていなければ`null` */
  mergedAt: string | null;
};

export type StaleCheckUserDecision =
  /** `00.check-user`と理由ラベルを外す */
  | { action: "clear"; mergedAt: string }
  | {
      action: "skip";
      reason: "check_user_pr_open" | "check_user_no_merged_pr" | "check_user_after_merge";
    };

/**
 * developへのマージ時に外しそこねた`00.check-user`を外してよいかを決める（#2335）。
 *
 * ## なぜ要るか
 *
 * `00.check-user`と理由ラベル（`01.check-*`）を**7枚まとめて1回の`gh issue edit`で**外すのが
 * `reusable-issue-labels.yml`の`develop-pr-merged`で、そこには再試行が無く、失敗しても
 * 警告を出して先へ進む（進捗の報告を最優先で守る設計。#1861）。guchi-apps/signaly#200では
 * GitHubの`502 Bad Gateway`に当たって素通りし、マージ済みのIssueに「マージの確認待ち」が
 * 残った（実行ログ 32842492174）。
 *
 * **残り続けるわけではない。** 同じ7枚は`main-pr-merged`とIssueのcloseでも外れるので、
 * 次のmainリリースまでで解消する（signaly#200の実測は18分で、リリースPR #203のマージが
 * 外した）。それでも直す理由は、その窓のあいだ**盤面の「確認待ち」に押せない札が積まれる**
 * こと——開いてもマージ済みで、できる操作が無い。リリースまで日をまたげばPush通知も飛ぶ。
 *
 * ## 外す条件
 *
 * **`01.check-merge`に限定しない。** 落ちるのは7枚まとめての1回なので、そのとき付いていた
 * 理由ラベルが何であれ同じように残る（`01.check-answered`はマージ待ちと同時に成立しうる）。
 * 見るのは`00.check-user`が付いていることだけにして、理由ラベルの除去は
 * `clearCheckUser`の既存の挙動（付いているものを外す）に任せる。
 *
 * そのうえで、次のどれかに当たるものには触らない。
 *
 * - **開いているPRが1件でもある。** それは本物のマージ待ちで、`01.check-merge`が
 *   指しているものそのもの
 * - **`issue-<番号>`のマージ済みPRが無い。** マージの記録が無いのに外すと、人が手で
 *   付けた確認待ちまで黙って消してしまう
 * - **`00.check-user`が付いたのがマージより後。** 判定が下る前にPRがマージされた場合、
 *   `reusable-claude-review-develop.yml`は文面だけを事後確認向けに変えて
 *   `00.check-user`＋`01.check-merge`を**そのまま付ける**（#1968）。取り残しの通知
 *   （`01.check-blocked`）も人が手で付けたものも同じ形になる。**マージ時の除去が
 *   落ちたものだけ**を相手にするので、付与の時刻がマージより前のものに限る
 *
 * 判定をIOから切り離してあるのは`decideProgressSweep`と同じ理由で、人の目を通らないまま
 * ラベルを書き換えるため。IOは[`progress-sweep-run.ts`](./progress-sweep-run.ts)。
 */
export function decideStaleCheckUser(facts: {
  pullRequests: readonly StaleCheckUserPullRequest[];
  /** `Issue.checkUserLabeledAt`。`00.check-user`が外れるとnullへ戻る列 */
  checkUserLabeledAt: Date | null;
}): StaleCheckUserDecision {
  if (facts.pullRequests.some((pullRequest) => pullRequest.state === "open")) {
    return { action: "skip", reason: "check_user_pr_open" };
  }

  // 最後にマージされたPRと比べる。1つのIssueに複数のPRが発生するため、比較の相手は
  // 「直近のマージ」でなければならない（古いマージと比べると、その後に付いた確認待ちを
  // 「マージより後」と判定できない）。
  let mergedAt: string | null = null;
  let mergedAtMs = Number.NEGATIVE_INFINITY;
  for (const pullRequest of facts.pullRequests) {
    if (pullRequest.mergedAt === null) continue;
    const ms = Date.parse(pullRequest.mergedAt);
    if (Number.isNaN(ms) || ms <= mergedAtMs) continue;
    mergedAt = pullRequest.mergedAt;
    mergedAtMs = ms;
  }
  if (mergedAt === null) return { action: "skip", reason: "check_user_no_merged_pr" };

  // 付与の時刻が分からないものは触らない。DBの同期が追い付いていない可能性があり、
  // 「マージより前」と決めつける根拠が無い。
  const labeledAt = facts.checkUserLabeledAt;
  if (labeledAt === null || labeledAt.getTime() >= mergedAtMs) {
    return { action: "skip", reason: "check_user_after_merge" };
  }

  return { action: "clear", mergedAt };
}

/** 巡回の間隔（分）。環境変数が読めない・数値でない場合は既定値。**0以下は「巡回しない」** */
export function progressSweepIntervalMinutes(
  raw: string | undefined = process.env.PROGRESS_SWEEP_INTERVAL_MINUTES,
): number {
  if (raw === undefined || raw.trim() === "") return PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return PROGRESS_SWEEP_DEFAULT_INTERVAL_MINUTES;
  return value;
}

/**
 * 取り残しの通知が二重に積まれないようにする印。**先端のSHAを含める**ので、
 * 別のコミットがpushされれば改めて通知される。
 */
export function strandedCommentMarker(issueNumber: number, branchHead: string): string {
  return `<!-- issue-deck-stranded:issue-${issueNumber}@${branchHead} -->`;
}

/** developへ入らないコミットが残っていることを伝えるコメント本文 */
export function buildStrandedComment(params: {
  issueNumber: number;
  branchHead: string;
  pullRequestUrl: string;
  pullRequestHeadSha: string;
  aheadBy: number;
  ageMinutes: number;
}): string {
  const branch = `issue-${params.issueNumber}`;
  return [
    `⚠️ developへ入っていないコミットが \`${branch}\` に残っています。`,
    "",
    `- ブランチ \`${branch}\` の先端: \`${params.branchHead}\``,
    `- 直近のマージ済みPR: ${params.pullRequestUrl} （head \`${params.pullRequestHeadSha}\`）`,
    `- developへ入っていないコミット: ${params.aheadBy}件（最後のコミットから約${params.ageMinutes}分）`,
    "",
    "PRのマージとほぼ同時にpushされたコミットは、そのPRに含まれずdevelopへも入りません。このままでは進捗も`Develop`へ進みません。次のどちらかで解消してください。",
    "",
    `1. コミットが必要なら、\`${branch}\` から \`develop\` への新しいPull Requestを作成してマージする`,
    `2. コミットが不要なら、ブランチ \`${branch}\` を削除する`,
    "",
    strandedCommentMarker(params.issueNumber, params.branchHead),
    COMMENT_SOURCE_MARKER,
  ].join("\n");
}

/** developへのマージが完了したことを伝えるコメント本文 */
export function buildDevelopMergedComment(pullRequestUrl: string): string {
  return [
    `✅ developへのマージが完了しました: ${pullRequestUrl}`,
    "",
    COMMENT_SOURCE_MARKER,
  ].join("\n");
}

/** マージ完了の通知が既に投稿されているか。**同じPRのURLを含むものだけ**を見る */
export function hasDevelopMergedNotice(
  commentBodies: readonly (string | null)[],
  pullRequestUrl: string,
): boolean {
  return commentBodies.some(
    (body) =>
      typeof body === "string" &&
      body.includes(pullRequestUrl) &&
      body.includes("developへのマージが完了しました"),
  );
}

/** 取り残しの通知が既に投稿されているか */
export function hasStrandedNotice(
  commentBodies: readonly (string | null)[],
  issueNumber: number,
  branchHead: string,
): boolean {
  const marker = strandedCommentMarker(issueNumber, branchHead);
  return commentBodies.some((body) => typeof body === "string" && body.includes(marker));
}

/**
 * 手作業Issueのタイトルか（`manual-step-label`ジョブのschedule分と同じ判定）。
 *
 * **`[手作業]`で始まるかどうかだけを見る。** 「手作業」を含むだけの別Issueを拾わないため、
 * 検索での絞り込みに頼らず前方一致で確かめる。
 */
export function isManualStepTitle(title: string): boolean {
  return title.startsWith("[手作業]");
}
