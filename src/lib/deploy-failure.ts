/**
 * 本番デプロイ（`deploy.yml`）が失敗したまま止まっているリポジトリを**issue-deck側から巡回して
 * 見つけ**、追跡用のIssueを自動で起票する（#2236）。
 *
 * ## なぜ要るのか
 *
 * mainへマージした後の本番デプロイが落ちたとき、いま起きるのは3つだけ。
 *
 * - Signalyへの通知1件（`deploy.yml`の`notify`ジョブ）
 * - 「ブランチとPRの流れ」画面の赤いバッジ（#1579）
 * - `deploy-retry.yml`による**1回だけ**の自動再実行（#2134）
 *
 * 自動再実行で直らない失敗は、そこから先へ進まない。通知は流れて消え、バッジは
 * その画面を開いた人にしか見えないため、**人が気づいて「本番へ再デプロイ」を押しに行くまで
 * 本番は古い版のまま残る。** 失敗を盤面に載るIssueとして残せば、他の作業と同じ場所に並び、
 * 「やり残し」として消えない。
 *
 * ## なぜGitHub Actions側でIssueを立てないのか
 *
 * **立てるべきかどうかを、落ちた実行それ自身は判断できない。** `deploy-retry.yml`の再実行は
 * 同じrunのattemptを増やすので、1回目の失敗の時点でIssueを立てると、直った場合に開いたままの
 * Issueが残る。「失敗のまま一定時間が過ぎた」ことを言うには失敗の**後**を見る必要があり、
 * それを見られるのは外から巡回する側だけになる。
 *
 * 加えて、`deploy.yml`は14リポジトリに配られている。起票の作法（ラベル・本文・重複の防止）を
 * 各リポジトリのワークフローへ配り直すより、issue-deckに1か所置く方が揃えやすい。
 *
 * ## 判定はここ、IOは`deploy-failure-sweep-run.ts`
 *
 * コンフリクト巡回（#2116。`conflict-sweep.ts` / `conflict-sweep-run.ts`）と同じ分け方。
 */

/** Issueのタイトルの頭に付ける印。画面がデプロイ失敗Issueを見分けるのにも使う */
export const DEPLOY_FAILURE_TITLE_PREFIX = "[デプロイ失敗]";

/**
 * Issue本文へ埋める不可視マーカーの開始。**画面はこのマーカーだけを見て、パネルを出すかを決める**
 * （ラベルではなくマーカーにしたのは、新しいラベルを14リポジトリへ配り終えるまで
 * 機能が半端に効く状態を作らないため）。
 */
const META_MARKER_PREFIX = "<!-- deploy-failure:";

/** 巡回の既定間隔（分） */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 5;

/**
 * 失敗を見てから起票するまでに置く既定の猶予（分）。
 *
 * **`deploy-retry.yml`の自動再実行（#2134）と二重に動かないための間。** 失敗した直後に
 * 立てると、そのあと自動再実行が成功して「もう直っているIssue」が残る。再実行は失敗を
 * 検知してから数分で始まり、始まればrunは`in_progress`へ戻るので、この猶予を過ぎても
 * `completed`かつ`failure`のままなら「やり直しても駄目だった」と言い切れる。
 */
const DEFAULT_GRACE_MINUTES = 10;

/** 巡回が見るデプロイ実行1件ぶん。`fetchLatestDeployWorkflowRun`の戻り値をそのまま詰める */
export type DeployFailureSweepRun = {
  id: number;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | cancelled | timed_out | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  /** 最後に動いた時刻（ISO8601）。失敗からの経過時間はここから測る */
  updatedAt: string;
  /** 何回目の試行か（初回は1）。2以上なら1度やり直したうえでの失敗 */
  runAttempt: number;
};

/** そのリポジトリでいま追跡しているIssue（DBの`DeployFailureIssue`の行） */
export type DeployFailureTrackedIssue = {
  issueNumber: number;
  /** そのIssueが指している失敗のrun id */
  runId: number;
};

/** 起票を見送った理由。ログにそのまま出す（なぜ動かなかったのかを後から追うため） */
export type DeployFailureSkipReason =
  /** `deploy.yml`の実行を1件も取れない（workflowが無い・権限不足） */
  | "no_run"
  /** 実行中。失敗が確定していない（自動再実行の最中もここ） */
  | "not_completed"
  /** 失敗していない。追跡中のIssueも無い */
  | "not_failed"
  /** 失敗したばかり。自動再実行を待つ */
  | "within_grace"
  /** 同じ失敗で既に起票済み */
  | "already_tracked";

export type DeployFailureDecision =
  /** 新しくIssueを立てる */
  | { kind: "create" }
  /** 追跡中のIssueがあるが、別のrunが落ちた。Issueを立て直さず、そちらへ書き足す */
  | { kind: "update"; issueNumber: number }
  /** デプロイが成功した。追跡中のIssueを閉じる */
  | { kind: "close"; issueNumber: number }
  | { kind: "skip"; reason: DeployFailureSkipReason };

/** 失敗として扱う`conclusion`。キャンセルは含めない（人が止めたものを失敗と呼ばない） */
function isFailureConclusion(conclusion: string | null): boolean {
  return conclusion === "failure" || conclusion === "timed_out";
}

/**
 * リポジトリ1件について、Issueを立てる／書き足す／閉じる／何もしないを決める。
 *
 * **判定できないほうへ倒れたときは常に「何もしない」側になる。** 実行を取れない・状態が
 * 分からないときに起票すると、直っているのにIssueだけが残る。次の巡回で拾い直せるので、
 * 迷ったら見送る方が安い。
 */
export function decideDeployFailure({
  run,
  tracked,
  now,
  graceMinutes = deployFailureGraceMinutes(),
}: {
  run: DeployFailureSweepRun | null;
  /** そのリポジトリで開いている追跡Issue。無ければnull */
  tracked: DeployFailureTrackedIssue | null;
  now: Date;
  graceMinutes?: number;
}): DeployFailureDecision {
  // 実行が取れないときは何も言えない。**追跡中のIssueがあっても閉じない**——「成功した」ことを
  // 確かめられていないため。
  if (run === null) return { kind: "skip", reason: "no_run" };

  if (run.status !== "completed") return { kind: "skip", reason: "not_completed" };

  if (!isFailureConclusion(run.conclusion)) {
    // **閉じるのは成功したときだけ。** キャンセル・skippedは「直った」ことを意味しない。
    if (tracked !== null && run.conclusion === "success") {
      return { kind: "close", issueNumber: tracked.issueNumber };
    }
    return { kind: "skip", reason: "not_failed" };
  }

  // 同じ失敗を追いかけているIssueが既にある。
  if (tracked !== null && tracked.runId === run.id) {
    return { kind: "skip", reason: "already_tracked" };
  }

  const elapsedMs = now.getTime() - new Date(run.updatedAt).getTime();
  // 時刻を読めなければ猶予を判定できない。次の巡回に回す。
  if (!Number.isFinite(elapsedMs)) return { kind: "skip", reason: "within_grace" };
  if (elapsedMs < graceMinutes * 60_000) return { kind: "skip", reason: "within_grace" };

  // 追跡中のIssueがあるのに別のrunが落ちている＝前の失敗が直らないまま次のリリースが来た。
  // **Issueを立て直さず、開いている1件へ書き足す。** リポジトリごとに同時に開くのは1件に
  // 保ちつつ、Issueが古いrunを指したままになるのを防ぐ。
  if (tracked !== null) return { kind: "update", issueNumber: tracked.issueNumber };

  return { kind: "create" };
}

/** 巡回の間隔（分）。環境変数が読めない・数値でない場合は既定値。0以下は「巡回しない」 */
export function deployFailureSweepIntervalMinutes(
  raw: string | undefined = process.env.DEPLOY_FAILURE_SWEEP_INTERVAL_MINUTES,
): number {
  return positiveMinutes(raw, DEFAULT_SWEEP_INTERVAL_MINUTES);
}

/** 失敗を見てから起票するまでの猶予（分）。0にすると失敗を見た次の巡回で立てる */
export function deployFailureGraceMinutes(
  raw: string | undefined = process.env.DEPLOY_FAILURE_ISSUE_GRACE_MINUTES,
): number {
  return positiveMinutes(raw, DEFAULT_GRACE_MINUTES);
}

function positiveMinutes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Issueの本文・画面のパネルが共有する、失敗1件ぶんの材料 */
export type DeployFailureMeta = {
  repositoryFullName: string;
  /** 失敗した`deploy.yml`のrun id */
  runId: number;
  runUrl: string;
  /** 失敗した版（`1.4.2`）。特定できなければnull */
  version: string | null;
  /** いま本番に出ている（はずの）版。特定できなければnull */
  previousVersion: string | null;
  /** 失敗したジョブ名。取れなければ空配列 */
  failedJobs: string[];
  /** 何回目の試行で失敗したか */
  attempt: number;
  /** 失敗を検知した時刻（ISO8601） */
  detectedAt: string;
};

/** Issueのタイトル。**版が分からないときは版を書かない**（嘘の版を書くより短い方がよい） */
export function buildDeployFailureIssueTitle(meta: DeployFailureMeta): string {
  const version = meta.version ? `v${meta.version}の` : "";
  return `${DEPLOY_FAILURE_TITLE_PREFIX} ${meta.repositoryFullName}: ${version}本番デプロイが失敗しました`;
}

/**
 * Issueの本文。**先頭に不可視のマーカーを置く**——画面のパネルはこれを読んで、
 * 失敗した版・実行・ジョブを出す（Issue本文はissue-deckのDBへ同期済みなので、
 * パネルを出すのに追加のAPI呼び出しが要らない）。
 */
export function buildDeployFailureIssueBody(meta: DeployFailureMeta): string {
  const version = meta.version ? `v${meta.version}` : "最新のmain";
  const previous = meta.previousVersion ? `v${meta.previousVersion}` : "1つ前の版";
  const retried = meta.attempt > 1 ? "（自動で1回やり直しても失敗）" : "";
  const jobs =
    meta.failedJobs.length > 0 ? `\n- 失敗したジョブ: \`${meta.failedJobs.join("`, `")}\`` : "";

  return `${encodeDeployFailureMeta(meta)}
## 何が起きているか

${meta.repositoryFullName}の本番デプロイ（\`deploy.yml\`）が失敗しました${retried}。
**${version}はmainに入っていますが、本番には出ていません。本番は${previous}のままです。**

- 失敗した実行: ${meta.runUrl}${jobs}
- 検知: ${meta.detectedAt}

## どうすれば直るか

- SSH断・ネットワーク・アプリの起動待ちのような一時的な失敗なら、**もう一度流し直すだけで直ります。**
  issue-deckのこのIssueの画面、「ブランチとPRの流れ」画面、対象PRの詳細画面のいずれかにある
  「本番へ再デプロイ」を押してください
- 押し直しても同じところで落ちる場合は、コードか設定の修正が要ります。このIssueからそのまま実装を開始できます

## 補足

- このIssueはissue-deckが自動で起票しています。**次のデプロイが成功した時点で自動でクローズされます。**
- 同じリポジトリで同時に開くのは1件だけです。直らないまま次のリリースが来た場合は、新しく立てずにこのIssueへ書き足します
`;
}

/** 別のrunが落ちたときに、開いているIssueへ書き足すコメント */
export function buildDeployFailureUpdateComment(meta: DeployFailureMeta): string {
  const version = meta.version ? `v${meta.version}` : "最新のmain";
  const jobs =
    meta.failedJobs.length > 0 ? `\n- 失敗したジョブ: \`${meta.failedJobs.join("`, `")}\`` : "";
  return `⚠️ **${version}の本番デプロイも失敗しました。**

- 失敗した実行: ${meta.runUrl}${jobs}
- 検知: ${meta.detectedAt}

このIssueが指している失敗を、いちばん新しいものへ更新しました。
`;
}

/** デプロイが成功したときに、閉じる直前へ書き足すコメント */
export function buildDeployFailureResolvedComment(runUrl: string, version: string | null): string {
  const label = version ? `v${version}` : "最新のmain";
  return `✅ **${label}の本番デプロイが成功しました。** 自動でクローズします。

- 成功した実行: ${runUrl}
`;
}

/** マーカー1行にする。改行を含められないので1行のJSONにする */
function encodeDeployFailureMeta(meta: DeployFailureMeta): string {
  return `${META_MARKER_PREFIX} ${JSON.stringify(meta)} -->\n\n`;
}

/**
 * Issue本文からマーカーを読み出す。**デプロイ失敗Issueでなければnull。**
 *
 * 画面（`deploy-failure-panel.tsx`）がパネルを出すかどうかの判定そのもの。壊れたJSON・
 * 形の合わない値は「マーカー無し」として扱う——人が本文を編集して壊すことがあり、
 * そのときにパネルが例外で落ちるより、出ない方がよい。
 */
export function parseDeployFailureMeta(body: string | null | undefined): DeployFailureMeta | null {
  if (!body) return null;
  const start = body.indexOf(META_MARKER_PREFIX);
  if (start === -1) return null;
  const end = body.indexOf("-->", start);
  if (end === -1) return null;

  const json = body.slice(start + META_MARKER_PREFIX.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const meta = parsed as Record<string, unknown>;
  if (typeof meta.repositoryFullName !== "string" || typeof meta.runUrl !== "string") return null;

  return {
    repositoryFullName: meta.repositoryFullName,
    runId: typeof meta.runId === "number" ? meta.runId : 0,
    runUrl: meta.runUrl,
    version: typeof meta.version === "string" ? meta.version : null,
    previousVersion: typeof meta.previousVersion === "string" ? meta.previousVersion : null,
    failedJobs: Array.isArray(meta.failedJobs)
      ? meta.failedJobs.filter((job): job is string => typeof job === "string")
      : [],
    attempt: typeof meta.attempt === "number" ? meta.attempt : 1,
    detectedAt: typeof meta.detectedAt === "string" ? meta.detectedAt : "",
  };
}
