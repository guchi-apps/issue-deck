import { db } from "@/lib/db";
import { buildDispatchActiveKey } from "@/lib/dispatch/dispatch-job";
import { getPendingDispatchAt } from "@/lib/dispatch/pending-dispatch";
import { getManualStepVerifiedAt } from "@/lib/manual-step-verification-patrol";
import { handleIssueClosedForDispatch } from "@/lib/dispatch/session-close";
import { getInstallationToken } from "@/lib/github/app-auth";
import { CHECK_USER_LABEL } from "@/lib/github/approval-labels";
import { isAskClaudeQuestionComment, isQaAnswerComment } from "@/lib/github/ask-claude";
import { isFallbackNoticeComment } from "@/lib/github/fallback-notice";
import { isLabelClearedOnClose } from "@/lib/github/issue-close";
import { clearLabelsOnIssueClose } from "@/lib/github/issue-close-cleanup";
import { dbIssueToDisplayIssue } from "@/lib/github/issue-mapper";
import type { GithubApiIssue } from "@/lib/github/issues-api";
import { fetchIssuesForRepo } from "@/lib/github/issues-api";
import { runExclusive } from "@/lib/keyed-mutex";
import { isUniqueConstraintError } from "@/lib/prisma-error";
import type { Issue } from "@/types/issue";
import type { IssueState, IssueStateReason } from "@prisma/client";

type RepoForSync = {
  id: string;
  ownerLogin: string;
  name: string;
  installation: { installationId: number };
};

function mapLabelName(label: { name: string; color: string } | string): string {
  return typeof label === "string" ? label : label.name;
}

function mapLabelColor(label: { name: string; color: string } | string): string {
  return typeof label === "string" ? "64748b" : label.color;
}

function mapLabelId(label: { id: number } | string): bigint | null {
  return typeof label === "string" ? null : BigInt(label.id);
}

function mapLabelDescription(label: { description: string | null } | string): string | null {
  return typeof label === "string" ? null : label.description;
}

function toIssueState(state: "open" | "closed"): IssueState {
  return state === "open" ? "OPEN" : "CLOSED";
}

function toIssueStateReason(
  stateReason: GithubApiIssue["state_reason"],
): IssueStateReason | null {
  switch (stateReason) {
    case "completed":
      return "COMPLETED";
    case "not_planned":
      return "NOT_PLANNED";
    case "reopened":
      return "REOPENED";
    default:
      return null;
  }
}

/**
 * GitHubのIssue1件をDBへ反映する。画面のPATCH・Webhook・定期同期の3経路が通る。
 *
 * **同じIssueの「読んでから書く」を同時に2本走らせない**（#2365）。この関数はDBを読んでから
 * 書くまでに隙間があり、同時に走ると両方が同じ「読んだ値」を見て書きに行く。実測（開発DBで
 * 同時2本×3回）では**6回中5回**が落ち、内訳はユニーク制約違反（P2002）とデッドロック
 * （P2034）だった。落ちるとラベルの同期だけでなく、下のOPEN→CLOSED検知にも到達しない。
 *
 * **ロックの中はDBの読み書きだけにする。** closeの後片付け（GitHubへのラベル除去・
 * ローカルセッションの停止）は秒単位かかるので、中へ入れると同じIssueへ続けて届いた
 * Webhookがその間ずっと待たされる。
 */
async function upsertIssueRow(
  repositoryId: string,
  raw: GithubApiIssue,
  commentCreatedAt?: Date,
) {
  const written = await runExclusive(`issue:${raw.id}`, () =>
    writeIssueRow(repositoryId, raw, commentCreatedAt),
  );

  // closeされたら、そのIssueで走っているローカルセッションを畳み（#1518）、残ると害になる
  // ラベルを外す（#2178）。
  //
  // **OPEN→CLOSEDの遷移だけで発火させる。** 「今CLOSEDである」で判定すると、定期同期が回るたび
  // （closedなIssueへ人が手で起こしたセッションも含めて）畳みに行ってしまう。更新前の状態を
  // 持っているのは`writeIssueRow`だけで、画面のPATCH・webhook・定期同期の3経路がそこを通る。
  //
  // 配信順序が前後した古いペイロードは`writeIssueRow`の`githubUpdatedAt`のガードで先に返るため、
  // 「closeされた後に届いたopenの通知」で二重に発火することはない。
  if (written.closedNow) {
    // `repositoryFullName`はこの関数が持っていないので、遷移を検知したときだけ引く
    // （呼び出し3経路のシグネチャを変えないため）。ラベルの除去はGitHubへ書きに行くので、
    // インストールIDもここで一緒に取る。
    const repository = await db.repository.findUnique({
      where: { id: repositoryId },
      select: {
        fullName: true,
        ownerLogin: true,
        name: true,
        installation: { select: { installationId: true } },
      },
    });
    if (repository) {
      await handleIssueClosedForDispatch({
        repositoryFullName: repository.fullName,
        issueNumber: written.issue.number,
      });
      await clearLabelsOnClose(
        repository,
        written.issue.id,
        written.issue.number,
        written.labelNames,
      );
    }
  }

  return written.issue;
}

/** `upsertIssueRow`のうち、同じIssueで重ねてはいけないDBの読み書き。 */
async function writeIssueRow(
  repositoryId: string,
  raw: GithubApiIssue,
  commentCreatedAt?: Date,
) {
  const githubUpdatedAt = new Date(raw.updated_at);

  const existing = await db.issue.findUnique({
    where: { githubIssueId: BigInt(raw.id) },
    include: { labels: true },
  });
  if (existing && existing.githubUpdatedAt > githubUpdatedAt) {
    // Webhookの配信順序はGitHub側で保証されないため、既に反映済みより古いペイロードは無視する
    // （新しいラベル状態が古い状態で上書きされるのを防ぐ）。
    return { issue: existing, closedNow: false, labelNames: [] as string[] };
  }

  // 「確認待ちフィルターを実際のコメント投稿日時順に並べる」ための基準時刻。
  // issue_comment Webhook（action=created）から渡された投稿日時を、既存の記録値より
  // 新しい場合のみ採用する（配信順序が前後しても新しい方を優先するガード）
  const lastCommentAt =
    commentCreatedAt && (!existing?.lastCommentAt || commentCreatedAt > existing.lastCommentAt)
      ? commentCreatedAt
      : existing?.lastCommentAt ?? null;

  // 「確認待ちフィルターを確認が古い順に並べる」ための基準時刻。00.check-userが新たに
  // 付与された瞬間をcheckUserLabeledAtとして記録し、外れたらnullに戻す。既存Issueで
  // 付与状態が変わらない場合は記録済みの日時を維持する
  const hasCheckUserLabel = raw.labels.some((label) => mapLabelName(label) === CHECK_USER_LABEL);
  const hadCheckUserLabel =
    existing?.labels.some((label) => label.name === CHECK_USER_LABEL) ?? false;
  const checkUserLabeledAt = !hasCheckUserLabel
    ? null
    : hadCheckUserLabel
      ? existing?.checkUserLabeledAt ?? new Date()
      : new Date();

  // Push通知（#838）の送信済み記録は、**`00.check-user`が付き直したら落とす**。
  // 落とす口はここだけで、送る側（`notifications/check-user-push.ts`）は
  // 「nullで、付与から待ち時間が過ぎたもの」だけを拾う。
  // **この関数からは送らない。** 付いた瞬間はまだ理由ラベル（`01.check-*`）が揃っておらず、
  // 早すぎる`00.check-user`（#1709）が自動マージで取り消される場合もあるため。
  //
  // **落とさないときは、この列を書かない**（#2300）。読んだ値をそのまま書き戻すと、
  // `existing`を読んでからupsertするまでの隙間に送信側が立てた記録を消してしまい
  // （Webhookの取り込みと通知の巡回は同時に走る）、次の巡回が同じ通知をもう一度送る。
  const keepCheckUserPushSentAt =
    checkUserLabeledAt !== null &&
    existing?.checkUserLabeledAt?.getTime() === checkUserLabeledAt.getTime();

  const data = {
    repositoryId,
    number: raw.number,
    title: raw.title,
    body: raw.body,
    state: toIssueState(raw.state),
    stateReason: toIssueStateReason(raw.state_reason),
    htmlUrl: raw.html_url,
    authorLogin: raw.user?.login ?? "unknown",
    assigneeLogin: raw.assignee?.login ?? null,
    commentCount: raw.comments,
    milestoneTitle: raw.milestone?.title ?? null,
    milestoneOpen: raw.milestone?.open_issues ?? null,
    milestoneClosed: raw.milestone?.closed_issues ?? null,
    githubCreatedAt: new Date(raw.created_at),
    githubUpdatedAt,
    githubClosedAt: raw.closed_at ? new Date(raw.closed_at) : null,
    syncedAt: new Date(),
    checkUserLabeledAt,
    lastCommentAt,
  };

  const update = keepCheckUserPushSentAt ? data : { ...data, checkUserPushSentAt: null };
  const issueWhere = { githubIssueId: BigInt(raw.id) };
  let issue;
  try {
    issue = await db.issue.upsert({
      where: issueWhere,
      create: { githubIssueId: BigInt(raw.id), ...data },
      update,
    });
  } catch (error) {
    // 直列化（`upsertIssueRow`）を抜けてもなお同時に走った場合の保険（#2365）。まだDBに
    // 無いIssueで両方がINSERTへ進むと後発が`Issue_githubIssueId_key`で落ちるので、
    // **落ちた側をUPDATEへ回して吸収する**（先発のINSERTは済んでいるので必ず引ける）。
    // プロセスを増やしたときに、ここが黙って壊れないようにしておく。
    if (!isUniqueConstraintError(error)) throw error;
    issue = await db.issue.update({ where: issueWhere, data: update });
  }

  const labelNames = raw.labels.map(mapLabelName);
  await syncIssueLabels(issue.id, raw.labels);

  return {
    issue,
    closedNow: existing?.state === "OPEN" && data.state === "CLOSED",
    labelNames,
  };
}

/**
 * IssueのラベルをGitHub側の状態へ合わせる（付いたものを足し、外れたものを消す）。
 *
 * **1件ずつの`upsert`にしない**（#2365）。複合ユニークキー（`issueId_name`）に対する
 * Prismaの`upsert`はMySQLでは1文にならず「SELECTしてからINSERT／UPDATE」に分かれるため、
 * 同時に走った2本が揃って「まだ無い」を見てINSERTへ進み、後発が
 * `IssueLabel_issueId_name_key`のユニーク制約（P2002）で落ちる。本番で出ていたのはこれ。
 *
 * 同時実行そのものは`upsertIssueRow`の直列化で止めているので、**ここは同じプロセスの外から
 * 重なったときの保険**。`createMany({ skipDuplicates: true })`はMySQLでは`INSERT IGNORE`の
 * 1文になり、競合しても落ちない。色・説明・GitHubのラベルIDの追随はユニークキーを動かさない
 * `updateMany`で行う（既に他方が入れていれば上書き、まだ無ければ0件でそのまま）。
 * どちらもP2002を起こしえない。
 *
 * **ただし`skipDuplicates`だけでは足りない**（実測）。この`$transaction`はINSERTのギャップロックと
 * `DELETE ... name NOT IN (...)`の範囲ロックを1つのトランザクションで取るため、同時に走ると
 * 今度はデッドロック（P2034）になる。落とさないための本体は直列化のほう。
 */
async function syncIssueLabels(
  issueId: string,
  labels: GithubApiIssue["labels"],
): Promise<void> {
  const rows = labels.map((label) => ({
    name: mapLabelName(label),
    color: mapLabelColor(label),
    description: mapLabelDescription(label),
    githubLabelId: mapLabelId(label),
  }));

  await db.$transaction([
    // ラベルが1枚も無いIssueで空配列のINSERTを投げない
    ...(rows.length > 0
      ? [
          db.issueLabel.createMany({
            data: rows.map((row) => ({ issueId, ...row })),
            skipDuplicates: true,
          }),
        ]
      : []),
    ...rows.map((row) =>
      db.issueLabel.updateMany({
        where: { issueId, name: row.name },
        data: {
          color: row.color,
          description: row.description,
          githubLabelId: row.githubLabelId,
        },
      }),
    ),
    db.issueLabel.deleteMany({
      where: { issueId, name: { notIn: rows.map((row) => row.name) } },
    }),
  ]);
}

export async function syncRepositoryIssues(repository: RepoForSync): Promise<void> {
  const token = await getInstallationToken(repository.installation.installationId);
  const rawIssues = await fetchIssuesForRepo(repository.ownerLogin, repository.name, token);

  for (const raw of rawIssues) {
    await upsertIssueRow(repository.id, raw);
  }

  await db.issue.deleteMany({
    where: {
      repositoryId: repository.id,
      githubIssueId: { notIn: rawIssues.map((raw) => BigInt(raw.id)) },
    },
  });
}

/**
 * closeされたIssueから、残ると害になるラベル（`00.check-user`・理由ラベル・`11.local`）を
 * 外す（#2178。対象と理由は`lib/github/issue-close.ts`）。
 *
 * **GitHubへ出て行くのは、実際に対象ラベルが付いているときだけ。** 大半のcloseは1枚も
 * 付いておらず、その場合はトークンの取得すら行わない。
 *
 * **DBの行も同時に落とす。** ここを通る経路のうち画面のPATCH（`upsertIssueAndGetDisplay`）は
 * この直後にDBを読み直して1件を返すため、DBを直さないと「クローズした瞬間だけラベルが
 * 残って見え、Webhookが届いてから消える」というちらつきになる。
 *
 * **投げない。** 後片付けの失敗でcloseそのものやDB同期を巻き添えにしない（#1856の
 * `closeStrandedProgress`と同じ約束）。
 */
async function clearLabelsOnClose(
  repository: {
    fullName: string;
    ownerLogin: string;
    name: string;
    installation: { installationId: number };
  },
  issueId: string,
  issueNumber: number,
  labelNames: readonly string[],
): Promise<void> {
  if (!labelNames.some(isLabelClearedOnClose)) return;

  try {
    const token = await getInstallationToken(repository.installation.installationId);
    const removed = await clearLabelsOnIssueClose({
      owner: repository.ownerLogin,
      repo: repository.name,
      issueNumber,
      token,
      currentLabelNames: labelNames,
    });
    if (removed.length === 0) return;

    await db.issueLabel.deleteMany({ where: { issueId, name: { in: removed } } });

    // `00.check-user`を外したときの後始末は、上の`upsertIssueRow`が付け外しを見て
    // 書いているものと同じにする（確認待ちの並び順の基準時刻とPush通知の送信済み記録）。
    if (removed.includes(CHECK_USER_LABEL)) {
      await db.issue.update({
        where: { id: issueId },
        data: { checkUserLabeledAt: null, checkUserPushSentAt: null },
      });
    }
  } catch (error) {
    console.error(
      `[sync-issues] クローズ時のラベル除去に失敗しました（${repository.fullName}#${issueNumber}）`,
      error,
    );
  }
}

export async function upsertIssueFromWebhookPayload(
  repositoryId: string,
  issuePayload: GithubApiIssue,
  commentCreatedAt?: Date,
): Promise<void> {
  await upsertIssueRow(repositoryId, issuePayload, commentCreatedAt);
}

export async function deleteIssueByGithubId(githubIssueId: number): Promise<void> {
  await db.issue.deleteMany({ where: { githubIssueId: BigInt(githubIssueId) } });
}

/**
 * Issueを別リポジトリへ移動したあと、移動元に残る行を消す（#2406）。
 *
 * 移動でIssueのGitHub IDは変わるため、移動先のIssueを`upsert`しても（キーは`githubIssueId`）
 * 移動元の行は別の行として残り、**GitHub上に存在しないIssue**として一覧に出続ける。
 * `issues.transferred` Webhookでも同じ後始末をしているが、そちらの到着を待たずに消す
 * （Webhookが未設定・遅延する環境でも移動直後の画面が正しくなる）。
 *
 * **`newGithubIssueId`と一致する行は消さない。** 将来GitHubが移動でIDを維持するようになった
 * 場合に、移動先へ書き換えたばかりの行を消してしまわないため。
 */
export async function deleteTransferredSourceIssue(
  repositoryId: string,
  number: number,
  newGithubIssueId: number,
): Promise<void> {
  await db.issue.deleteMany({
    where: {
      repositoryId,
      number,
      githubIssueId: { not: BigInt(newGithubIssueId) },
    },
  });
}

/**
 * issue_comment（created）Webhookで届いた新規コメント本文から、質問への回答待ち状態
 * （qaAnswerPendingAt）を更新する。質問コメント（isAskClaudeQuestionComment）なら現在時刻を
 * セットし、回答コメント（isQaAnswerComment）ならnullに戻す。それ以外の通常コメントでは
 * 何もしない（既存の状態を維持する）。
 *
 * **回答できなかったことの通知（フォールバック通知）でもnullに戻す**（#1766）。回答コメントだけを
 * 終わりの合図にすると、行き詰まりで回答に到達できなかった質問が一覧・詳細でいつまでも
 * 「Claudeの回答待ち」のままになる。判定の理由は`isQaAnswerPending`（`ask-claude.ts`）と同じ。
 */
export async function updateQaAnswerPendingState(
  githubIssueId: number,
  commentBody: string,
): Promise<void> {
  if (isAskClaudeQuestionComment({ body: commentBody })) {
    await db.issue.updateMany({
      where: { githubIssueId: BigInt(githubIssueId) },
      data: { qaAnswerPendingAt: new Date() },
    });
    return;
  }
  if (isQaAnswerComment({ body: commentBody }) || isFallbackNoticeComment({ body: commentBody })) {
    await db.issue.updateMany({
      where: { githubIssueId: BigInt(githubIssueId) },
      data: { qaAnswerPendingAt: null },
    });
  }
}

export async function upsertIssueAndGetDisplay(
  repository: { id: string; fullName: string; private: boolean; archived: boolean },
  raw: GithubApiIssue,
): Promise<Issue> {
  const issue = await upsertIssueRow(repository.id, raw);
  const row = await db.issue.findUniqueOrThrow({
    where: { id: issue.id },
    include: { labels: true },
  });
  // 単票を返す経路（作成・編集・転送）でも順番待ちを落とさない（#1347）。落とすと、
  // 画面がこの1件で一覧を差し替えた瞬間だけ「実行中」から消えて次のポーリングで戻る
  const pendingAt = await getPendingDispatchAt(
    buildDispatchActiveKey(repository.fullName, row.number),
  );
  // 完了確認の巡回の印（#2008）も同じ理由で落とさない。落とすと、この1件で一覧を差し替えた
  // 瞬間だけ「完了済みの可能性」が消えて次のポーリングで戻る
  const verifiedAt = await getManualStepVerifiedAt(repository.fullName, row.number);
  return {
    ...dbIssueToDisplayIssue(repository, row),
    dispatchPendingAt: pendingAt?.toISOString() ?? null,
    manualStepVerifiedAt: verifiedAt?.toISOString() ?? null,
  };
}
