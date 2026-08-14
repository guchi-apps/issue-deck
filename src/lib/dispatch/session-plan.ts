import { db } from "@/lib/db";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { CHECK_USER_LABEL } from "@/lib/github/approval-labels";
import { addIssueLabels, createComment, removeIssueLabel } from "@/lib/github/issues-api";
import { parseRepositoryFullName } from "@/lib/local-session";

/**
 * ローカルの実装セッションが提示した計画をIssueへ残す（#1342）。
 *
 * **これまで、ローカルセッションの計画はセッションの中にしか無かった。** `21.plan-required`の
 * Issueをサブか手元で起こすと計画はPlan modeで止まり、画面に出るのは「入力を待っています」という
 * バッジだけで（#1264）、中身はRemote Controlを開くまで見えない。プロンプト
 * （`scripts/prompts/implementation-agent.md`）は計画をIssueへ投稿するよう指示しているが、
 * **エージェントが従うかどうかに依存していて担保が無い。**
 *
 * そこで`ExitPlanMode`の`PreToolUse`フック（`scripts/session-notify.sh`）が計画本文を送ってきて、
 * ここがGitHub App名義でIssueへ書く。経路は`session-escalation.ts`（異常終了の引き上げ）と同じで、
 * サブPCにGitHubの認証を持たせないための一本化
 * （[docs/progress-status-architecture.md](../../../docs/progress-status-architecture.md)）に倣う。
 */

/** 自動投稿された計画コメントであることを示すマーカー */
export const SESSION_PLAN_MARKER = "<!-- issue-deck:session-plan -->";

/**
 * GitHubのIssueコメント本文の上限は65536字。計画がそれを超えることは実際にはまず無いが、
 * **超えた場合に投稿ごと失敗する（＝計画がどこにも残らない）方が損失が大きい**ので、
 * 余白を取って切る。切ったことは本文に残し、全文はRemote Controlで見てもらう。
 */
const PLAN_BODY_LIMIT = 60000;

/**
 * 受け取ってよい計画本文の形。**空文字は受け取らない**（中身の無いコメントを投稿しても
 * ノイズにしかならない）。長さの上限は本文の切り詰め（`PLAN_BODY_LIMIT`）とは別に、
 * 明らかに壊れた入力でGitHubへの往復を起こさないための線として置く。
 */
export function parseSessionPlanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200000) return null;
  return trimmed;
}

/** 計画が前提にしたコミットのSHA。**16進の文字列だけを通す**（本文へそのまま埋めるため） */
export function parsePlanBaseSha(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

/** 通知に載せるのと同じホスト名。本文へそのまま埋めるので、識別子として妥当な形だけを通す */
export function parseSessionHostName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value) ? value : null;
}

export function buildSessionPlanCommentBody(params: {
  plan: string;
  /** `claude --remote-control`のURL。取れないこともある（Claude Codeの内部ファイル依存） */
  remoteControlUrl: string | null;
  /** 計画が前提にした`origin/develop`のSHA。取れないこともある */
  planBaseSha: string | null;
  hostName: string | null;
}): string {
  const plan = params.plan.trim();
  const truncated = plan.length > PLAN_BODY_LIMIT;
  const body = truncated
    ? `${plan.slice(0, PLAN_BODY_LIMIT)}\n\n（長すぎるため以降を省略しました。全文はRemote Controlで確認してください）`
    : plan;

  const where = params.hostName
    ? `${formatDispatchHostName(params.hostName)}のセッション`
    : "ローカルのセッション";

  const lines: string[] = [];
  // 手で投稿していたときと同じ位置・同じ形で残す。並行して走る他セッションのマージで計画の
  // 前提が無効になることが実際に起きているため、後から`git log <SHA>..origin/develop`で
  // 何が変わったかを辿れるようにする（docs/multi-agent/gates.md）
  if (params.planBaseSha) lines.push(`<!-- plan-base: ${params.planBaseSha} -->`, "");
  lines.push(`🗒️ **計画を提示しました。** ${where}が承認を待っています。`, "", body, "", "---", "");
  // **リンクは計画本文とは別の段落に置く**（Issueの要件）。計画が長いほど、末尾に出口が
  // 無いと「読んだ後どうすればよいか」が画面から消える
  lines.push(
    "`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません。承認・修正の指示はRemote Controlから伝えてください。",
    "",
  );
  if (params.remoteControlUrl) {
    lines.push(`[Remote Controlで開く](${params.remoteControlUrl})`, "");
  } else {
    // URLが取れないのは異常ではない（`--remote-control`無しで起動した場合など）。
    // 計画そのものは載せる価値があるので、リンクだけを落とす
    lines.push(
      "（Remote ControlのURLを取得できませんでした。セッションの起動直後の出力か `tmux attach` から確認してください）",
      "",
    );
  }
  lines.push(SESSION_PLAN_MARKER);
  return lines.join("\n");
}

/**
 * 対象リポジトリのインストールトークンを取る。issue-deckが接続していないリポジトリでは
 * こちらから書く手段が無いのでnullを返す（`session-escalation.ts`と同じ扱い）。
 */
async function resolveToken(repositoryFullName: string): Promise<string | null> {
  const repository = await db.repository.findFirst({
    where: { fullName: repositoryFullName },
    include: { installation: true },
  });
  if (!repository) return null;
  // **`app-auth`は動的importにする（#550と同じ理由）。** あちらはモジュール読み込みの時点で
  // `GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY_BASE64`を要求するため、静的importにすると
  // 本文の組み立てだけを見たいテストや、GitHub App認証を持たない環境で読み込み自体が失敗する。
  const { getInstallationToken } = await import("@/lib/github/app-auth");
  return getInstallationToken(repository.installation.installationId);
}

/**
 * 計画をIssueへ投稿し、`00.check-user`を付ける。
 *
 * **失敗しても例外を投げない。** 呼び出し元はフックからの報告を受けているだけで、失敗しても
 * セッション側にできることは何も無い（`session-notify.sh`は何が起きても`exit 0`で返す）。
 */
export async function postSessionPlan(params: {
  repositoryFullName: string;
  issueNumber: number;
  plan: string;
  remoteControlUrl: string | null;
  planBaseSha: string | null;
  hostName: string | null;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionPlanCommentBody({
        plan: params.plan,
        remoteControlUrl: params.remoteControlUrl,
        planBaseSha: params.planBaseSha,
        hostName: params.hostName,
      }),
    });

    // ラベルは**追加**する。`updateIssue`の`labels`は全置換で、既に付いている
    // `21.plan-required`・`11.local`を巻き込んで落としてしまう
    await addIssueLabels(parsed.owner, parsed.repo, params.issueNumber, token, [CHECK_USER_LABEL]);
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの計画をIssueへ投稿できませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}

/**
 * 計画の承認待ちを解く（`00.check-user`を外す）。
 *
 * 呼ぶのは`Stop`フックの報告（`POST /api/dispatch/sessions/activity`）で、**自分が付けたと
 * 分かっているときだけ**（ホスト側の印。`scripts/lib/session-state.sh`の`.plan`）。
 * `Stop`はturnごとに飛ぶため、無条件に外すと人が別の理由で付けた`00.check-user`まで落とす。
 *
 * 人が画面の承認ボタンで先に外していることもあるが、`removeIssueLabel`が404を成功として
 * 扱うのでそのまま通る。
 */
export async function resolveSessionPlanCheckUser(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveToken(params.repositoryFullName);
    if (!token) return false;

    await removeIssueLabel(
      parsed.owner,
      parsed.repo,
      params.issueNumber,
      token,
      CHECK_USER_LABEL,
    );
    return true;
  } catch (error) {
    console.error(
      `[dispatch] 計画の承認待ちを解けませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
