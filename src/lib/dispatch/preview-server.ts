import type { DispatchHostView, DispatchJobView, PreviewAction } from "@/lib/dispatch/dispatch-job";
import { formatRelativeDate } from "@/lib/format-relative-date";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * 確認環境（#2444）。**developの最新をサブPCで動かし、mainへ出す前の状態を実物の画面で
 * 確かめるための開発サーバー**の、画面へ出す側の組み立て。
 *
 * 実体はサブPCの`scripts/start-preview-dev.sh`で、issue-deckが持つのは
 *
 *   1. どのリポジトリを起こせるか（ホストが申告したリポジトリ一覧から決まる）
 *   2. いま何が動いているか（pollerが30秒ごとに申告する`previewState`の写し）
 *   3. 押せるかどうかと、押せない理由
 *
 * の3つだけ。**判定はpoller側に置かない**（1と3は画面で押す前に理由を出すためのもの）が、
 * **状態の組み立て直しもしない**（2はスクリプトが返した値をそのまま運ぶ）。
 *
 * ## 同時に動かせるのは1つ
 *
 * サブPCの実効RAMは13Giしかなく、#1523ではIssueごとの開発サーバーの孤児9本でOOM Killerが
 * 発動している。リポジトリ数ぶんの確認環境を常駐させる前提は置けないため、別のリポジトリを
 * 選んだら前のものを止めてから起こす（実際に止めるのはスクリプト側）。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる
 * （`host-checkout.ts`・`host-metrics.ts`と同じ形）。
 */

/**
 * いま動いている確認環境1件ぶんの申告。
 *
 * **`repository`と`port`だけが必須。** 「どのリポジトリがどのポートで動いているか」は
 * 状態ファイルとプロセスさえ読めれば必ず分かる一方、残りは取れないことがある
 * （`tailscale serve`が使えないホストにURLは無く、`--no-update`で起こせばブランチが分からない）。
 * 取れなかった項目のために全体を落とすと、いちばん確実な事実まで見えなくなる
 * （`parseDispatchHostCheckout`と同じ向き）。
 */
export type DispatchHostPreview = {
  /** `owner/repo` */
  repository: string;
  /** 待ち受けているポート（帯のベース値 + 0） */
  port: number;
  /** 映しているブランチ（develop / main）。判定できなければ`null` */
  branch: string | null;
  /**
   * tailnetのURL（`http://<MagicDNS名>:<ポート>`）。**`tailscale serve`が使えないホストでは
   * `null`**で、そのときスマホからは開けない（`http://localhost:<ポート>`はサブPCの中だけ）。
   */
  url: string | null;
  /** 映しているコミットの短縮SHA */
  commit: string | null;
  /** そのコミットの1行目 */
  subject: string | null;
  /** 起こした時刻（ISO8601） */
  startedAt: string | null;
  /**
   * 何分アクセスが無ければ自動で停止するか（`PREVIEW_IDLE_MINUTES`）。
   * **`null`は「申告していない」**で、止まらないという意味ではない。
   */
  idleMinutes: number | null;
};

/** gitのブランチ名として通る範囲へ絞る（申告は外から届くため、そのまま画面へ出さない） */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,191}$/;
/** 短縮SHAから完全なSHAまで受ける。gitの出力なので小文字の16進のみ */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
/** コミットの1行目。長い件名は画面側で省略するので、ここでは丸ごと弾かず切る */
const SUBJECT_MAX_LENGTH = 200;

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parsePositiveInt(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value <= 0 || value > max) return null;
  return value;
}

/**
 * pollerが送ってきた`previewState`を検証する。
 *
 * **動いていない申告（`{"running": false}`）は`null`。** 直前まで動いていた記録を残すと、
 * 止まっているものが画面では動いているように見える。
 *
 * **URLは`http://`のホスト名だけを受ける。** ここはpollerからの申告をそのまま`<a href>`に
 * 載せる経路なので、`javascript:`のようなスキームを弾いておく（申告は認証済みだが、
 * 画面へ出す値の検証を申告側の正しさに委ねない）。
 */
export function parseDispatchHostPreview(value: unknown): DispatchHostPreview | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input.running !== true) return null;

  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  if (parseRepositoryFullName(repository) === null) return null;

  const port = parsePositiveInt(input.port, 65535);
  if (port === null) return null;

  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const commit = typeof input.commit === "string" ? input.commit.trim().toLowerCase() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";

  return {
    repository,
    port,
    branch: BRANCH_PATTERN.test(branch) ? branch : null,
    url: parsePreviewUrl(input.url),
    commit: COMMIT_PATTERN.test(commit) ? commit : null,
    subject: subject ? subject.slice(0, SUBJECT_MAX_LENGTH) : null,
    startedAt: parseIsoDate(input.startedAt),
    idleMinutes: parsePositiveInt(input.idleMinutes, 24 * 60),
  };
}

/**
 * tailnetのURLとして受け付ける形。**`http:`か`https:`のみ**で、他のスキームは弾く。
 *
 * 判定を`URL`に任せるのは、`http://`で始まるかどうかの文字列比較だと
 * `http://evil@example.com`のような形を素通しするため。
 */
export function parsePreviewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * 確認環境を操作できない理由。**画面にそのまま出す前提**で、判定は画面とAPIで同じ関数を使う
 * （`DispatchEnqueueRejection`・`ManualStepExecutionRejection`と同じ立場）。
 */
export type PreviewRejection =
  | "host_unknown"
  | "host_offline"
  | "preview_unsupported"
  | "repository_unavailable"
  | "no_dev_server"
  | "already_queued"
  | "not_running";

export function describePreviewRejection(reason: PreviewRejection): string {
  switch (reason) {
    case "host_unknown":
      return "サブPCの申告がまだ届いていません。";
    case "host_offline":
      return "サブPCが応答していません（pollerが動いているか確認してください）。";
    case "preview_unsupported":
      return "サブPCのpollerが確認環境に対応していません。「更新して再起動」で最新にしてください。";
    case "repository_unavailable":
      return "このリポジトリはサブPCから起動できません（チェックアウトが登録されていません）。";
    case "no_dev_server":
      return "開発サーバーがありません";
    case "already_queued":
      return "確認環境への操作が既に順番待ちです。終わるまでお待ちください。";
    case "not_running":
      return "確認環境は動いていません。";
  }
}

/**
 * 確認環境への操作を積めるかを判定する（画面とAPIで共有する）。
 *
 * **`stop`・`refresh`は動いているときだけ。** 動いていないのに押せると、押した先で
 * スクリプトが「起動していません」と返すだけのジョブが積まれる。
 */
export function resolvePreviewRejection(params: {
  host: DispatchHostView | null;
  repositoryFullName: string;
  action: PreviewAction;
  hasQueuedJob: boolean;
}): PreviewRejection | null {
  const { host, repositoryFullName, action, hasQueuedJob } = params;
  if (!host) return "host_unknown";
  if (!host.online) return "host_offline";
  // **`null`（未申告＝古いpoller）は「できない」として扱う**（他のCapableと同じ向き）。
  // 配ると未知の種別として`failed`になり、押しても何も起きなかったようにしか見えない。
  if (host.previewCapable !== true) return "preview_unsupported";
  if (hasQueuedJob) return "already_queued";
  if (action === "start") {
    if (!host.repositories.includes(repositoryFullName)) return "repository_unavailable";
    // **開発サーバーを持たないリポジトリを分けて出す**（vps・subpc・docs・claude-config・ideas）。
    // ローカルセッションのためにポート帯だけ確保してあるが`package.json`が無く、確認環境として
    // は起こせない。申告していない古いpollerでは絞り込めないので、そのときは通す
    // （押した先でスクリプトが理由を返す）。
    if (host.previewRepositories !== null && !host.previewRepositories.includes(repositoryFullName)) {
      return "no_dev_server";
    }
    return null;
  }
  // 動いているものと違うリポジトリの停止・更新は押せない（画面には出さないが、APIの二重の壁）。
  if (host.preview?.repository !== repositoryFullName) return "not_running";
  return null;
}

/** 画面の1行ぶん。リポジトリの一覧はこの形で並べる */
export type PreviewRepositoryRow = {
  repositoryFullName: string;
  /** `owner/`を落とした表示名 */
  name: string;
  /** このリポジトリの確認環境が動いているか */
  running: boolean;
  /** 開発サーバーを持たないため起こせないリポジトリ（vps・docs等）。行は出すが押せない */
  noDevServer: boolean;
  /** 押せない理由（`null`なら押せる） */
  rejection: PreviewRejection | null;
};

/**
 * リポジトリの一覧を組み立てる。
 *
 * **並びは「動いているものが先頭 → あとは名前順」。** 押す前にいま何が動いているかを見せる
 * ためで、一覧の中で目当ての行を探し直さずに済む。
 *
 * 母集団は**ホストが実行できると申告したリポジトリ**（`repositories`）で、開発サーバーを
 * 持たないもの（`previewRepositories`に無いもの）は**行としては出しつつ押せなくする**。
 * 一覧から消してしまうと「vpsはなぜ無いのか」が分からず、確認環境で見られないことと
 * サブPCに無いことの区別も付かない。
 */
export function buildPreviewRepositoryRows(params: {
  host: DispatchHostView | null;
  hasQueuedJob: boolean;
}): PreviewRepositoryRow[] {
  const { host, hasQueuedJob } = params;
  if (!host) return [];
  const runningRepository = host.preview?.repository ?? null;
  return [...host.repositories]
    .sort((a, b) => {
      if (a === runningRepository) return -1;
      if (b === runningRepository) return 1;
      return a.localeCompare(b);
    })
    .map((repositoryFullName) => {
      const rejection = resolvePreviewRejection({
        host,
        repositoryFullName,
        action: "start",
        hasQueuedJob,
      });
      return {
        repositoryFullName,
        name: repositoryFullName.split("/")[1] ?? repositoryFullName,
        running: repositoryFullName === runningRepository,
        noDevServer: rejection === "no_dev_server",
        rejection,
      };
    });
}

/** 動いている確認環境の見出しに出す一行（`issue-deck ・ develop ・ 12分前から`） */
export function describePreviewSummary(preview: DispatchHostPreview, now: Date): string {
  const parts = [preview.repository.split("/")[1] ?? preview.repository];
  if (preview.branch) parts.push(preview.branch);
  if (preview.startedAt) parts.push(`${formatRelativeDate(preview.startedAt, now.getTime())}から`);
  return parts.join(" ・ ");
}

/** 自動停止までの案内。申告が無ければ何も出さない（止まらないとは言い切れないため） */
export function describePreviewIdleStop(preview: DispatchHostPreview): string | null {
  if (preview.idleMinutes === null) return null;
  return `${preview.idleMinutes}分アクセスが無いと自動で停止します。`;
}

/**
 * 押した確認環境の操作の結果を出す（#1927の`describeDispatchHostSelfUpdate`と同じ立場）。
 *
 * **`PREVIEW`は起動ジョブでも制御ジョブでもないため、実行キューの一覧に出ない。** 押した結果を
 * 出す場所がこの画面しか無いので、直近の1件をここから拾う。
 */
export const PREVIEW_JOB_RESULT_WINDOW_MS = 10 * 60 * 1000;

export function selectPreviewJob(
  jobs: readonly DispatchJobView[],
  hostName: string,
): DispatchJobView | null {
  const candidates = jobs
    .filter((job) => job.kind === "PREVIEW" && job.targetHost === hostName)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return candidates[0] ?? null;
}

export type PreviewJobRow = {
  tone: "running" | "done" | "error";
  text: string;
};

export function describePreviewJob(
  job: DispatchJobView | null,
  now: Date,
): PreviewJobRow | null {
  if (!job) return null;
  if (job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "RUNNING") {
    return { tone: "running", text: job.message?.trim() || "確認環境を操作しています..." };
  }
  const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  // 終わった結果をいつまでも出さない（押したことを忘れた頃に出ていると、いまの状態に見える）。
  if (finishedAt === null || now.getTime() - finishedAt > PREVIEW_JOB_RESULT_WINDOW_MS) return null;
  if (job.status === "SUCCEEDED") {
    return { tone: "done", text: job.message?.trim() || "完了しました。" };
  }
  return { tone: "error", text: job.message?.trim() || "失敗しました。" };
}
