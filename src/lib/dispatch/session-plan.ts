import {
  addCheckUserWithReason,
  removeCheckUserWithReason,
} from "@/lib/dispatch/check-user-labels";
import { formatDispatchHostName } from "@/lib/dispatch/host-label";
import { resolveInstallationToken } from "@/lib/dispatch/installation-token";
import { enqueuePlanReviewJob } from "@/lib/dispatch/jobs";
import { SESSION_ARTIFACT_HTML_LIMIT } from "@/lib/dispatch/session-artifact";
import { PLAN_REQUIRED_LABEL } from "@/lib/github/approval-labels";
import { createComment } from "@/lib/github/issues-api";
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
 *
 * #1417で、計画以外の入力待ち（質問・プレビューやスクリーンショットの承認依頼）でも同じ経路で
 * `00.check-user`を付け外しするようになったため、このファイルは「ローカルセッションからの
 * `00.check-user`操作」全般を扱う。付く・外れるタイミングの一覧は
 * [docs/multi-agent/labels.md](../../../docs/multi-agent/labels.md)
 * 「`00.check-user`が付く・外れるタイミング」を参照。
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
 * 受け取ってよい計画本文の上限。
 *
 * **アーティファクトを埋め込んだ計画ファイルがそのまま届くことがある**（#2200。フェンスが
 * 閉じていないなど、切り出し（`plan-artifact.ts`）に外れた場合）。埋め込むHTMLの上限は2MBで、
 * 従来の20万字では**その回の計画がどこにも残らない**。投稿する本文は`PLAN_BODY_LIMIT`で、
 * 画面へ渡す本文は`truncatePlanForPanel`で別に切るので、ここは受け取りの線だけを見る。
 */
const PLAN_TEXT_LIMIT = SESSION_ARTIFACT_HTML_LIMIT;

/**
 * 受け取ってよい計画本文の形。**空文字は受け取らない**（中身の無いコメントを投稿しても
 * ノイズにしかならない）。長さの上限は本文の切り詰め（`PLAN_BODY_LIMIT`）とは別に、
 * 明らかに壊れた入力でGitHubへの往復を起こさないための線として置く。
 */
export function parseSessionPlanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PLAN_TEXT_LIMIT) return null;
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
  /** 計画に埋め込まれたアーティファクトを取り込んだか（#2200）。取り込んだ回だけ案内を足す */
  artifactUpdated?: boolean;
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
  lines.push(`🗒️ **計画を提示しました。** ${where}が承認を待っています。`, "");
  // **見出しの直後に置く**（#2200）。見た目が変わったことは計画本文を読み切る前に分かる必要が
  // あり、本文の途中に残る跡（`PLAN_ARTIFACT_PLACEHOLDER`）だけでは埋もれる
  if (params.artifactUpdated) {
    lines.push(
      "🎨 **アーティファクトも更新しました。** Issue詳細の「アーティファクト」カードで今の見た目を確認できます。",
      "",
    );
  }
  lines.push(body, "", "---", "");
  // **リンクは計画本文とは別の段落に置く**（Issueの要件）。計画が長いほど、末尾に出口が
  // 無いと「読んだ後どうすればよいか」が画面から消える
  lines.push(
    "`11.local`が付いている間、このコメント欄へ書いても走っているセッションには届きません。**承認・修正はissue-deckのIssue詳細に出る「計画の承認を待っています」から送れます**（#2061）。待ち時間が切れた後はRemote Controlから伝えてください。",
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
 * 計画をIssueへ投稿し、`00.check-user`と理由ラベル`01.check-plan`を付ける（#1490）。
 * 投稿できたら、続けて計画の関門（G1）のセッションを積む（#1855）。
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
  /** 計画に埋め込まれたアーティファクトを取り込んだか（#2200） */
  artifactUpdated?: boolean;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await createComment(parsed.owner, parsed.repo, params.issueNumber, token, {
      body: buildSessionPlanCommentBody({
        plan: params.plan,
        remoteControlUrl: params.remoteControlUrl,
        planBaseSha: params.planBaseSha,
        hostName: params.hostName,
        artifactUpdated: params.artifactUpdated,
      }),
    });

    // ラベルは**追加**する。`updateIssue`の`labels`は全置換で、既に付いている
    // `21.plan-required`・`11.local`を巻き込んで落としてしまう
    const labels = await addCheckUserWithReason(
      parsed.owner,
      parsed.repo,
      params.issueNumber,
      token,
      "plan",
    );

    // 計画の関門（G1・#1855）。**計画が実際に投稿された回だけ起こす**（無人側で守っている
    // のと同じ条件。`.github/workflows/reusable-issue-dispatch.yml`の`plan_posted`）。
    // 投稿より後に置くのは、ここで何が起きても計画そのものは残るようにするため。
    await requestPlanReview({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: params.hostName,
      labels,
    });
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
 * 計画の関門（G1・#1218）のセッションを積む（#1855）。
 *
 * **これが無い間、G1が自動で走るのは無人実行（Actions）で計画を出した経路だけだった。**
 * `11.local`が付いている間、無人実行は`mode=skip`になる（`reusable-issue-dispatch.yml`）ため、
 * ローカルセッションの計画には人が`scripts/start-reviewer.sh --plan`を叩いたときしか
 * レビューが入らず、実際に多いローカル経路が素通りしていた
 * （[docs/multi-agent/gates.md](../../../docs/multi-agent/gates.md)）。
 *
 * 積む条件は2つ。
 *
 * - **`21.plan-required`が付いていること。** G1が守っているのは「計画を出してから実装へ入る」
 *   Issueで、そこは無人実行のG1（`mode=plan`）と同じ範囲。ad hocにPlan modeへ入っただけの
 *   計画まで拾うと、レビュー1本ぶん（$0.7〜1.5）が予定外に増える
 * - **どのホストのセッションかが分かること。** 起こす先はそのセッションが動いているホストで、
 *   ジョブの払い出しはホスト単位のため、分からなければ積み先が決まらない
 *
 * **積めなくても計画の投稿は成功として扱う。** 呼び出し元はフックの報告を受けているだけで、
 * ここで失敗を返しても計画が消えるわけではない（人は画面の「計画をレビュー」から起こし直せる）。
 */
async function requestPlanReview(params: {
  repositoryFullName: string;
  issueNumber: number;
  hostName: string | null;
  /** `addCheckUserWithReason`が返した付与後のラベル名。取れなければ`null` */
  labels: string[] | null;
}): Promise<void> {
  if (!params.hostName) return;
  if (!params.labels?.includes(PLAN_REQUIRED_LABEL)) return;

  try {
    const result = await enqueuePlanReviewJob({
      repositoryFullName: params.repositoryFullName,
      issueNumber: params.issueNumber,
      hostName: params.hostName,
      // 人が押したわけではないので積んだユーザーは残らない（無人実行の起動と同じ扱い）
      requestedByUserId: null,
    });
    if (!result.ok) {
      // **断られること自体は異常ではない**（pollerが未対応・同じ計画のレビューが既にある）。
      // 画面のジョブ一覧にも出ないため、ここだけが手掛かりになる
      console.info(
        `[dispatch] 計画レビューを積みませんでした（${params.repositoryFullName}#${params.issueNumber}）: ${result.rejection}`,
      );
    }
  } catch (error) {
    console.error(
      `[dispatch] 計画レビューを積めませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
  }
}

/**
 * ローカルの実装セッションが入力待ちに入ったことを受けて`00.check-user`と理由ラベル
 * `01.check-input`を付ける（#1417・#1490）。
 *
 * 呼ぶのは`Notification / permission_prompt`フックの報告
 * （`POST /api/dispatch/sessions/activity`）。**コメントは投稿しない** — 承認プロンプトや
 * 質問はturnの途中で何度も起きるもので、そのたびにIssueへ書くとノイズにしかならない。
 * 何を聞かれているかはRemote Controlで見る（画面には`LocalSessionApprovalNotice`が導線を出す）。
 *
 * 計画の提示（`postSessionPlan`）と違い本文が無いぶん、**ラベルだけが「人を待っている」ことの
 * 唯一の記録**になる。付けたことはホスト側にも印として残り（`scripts/lib/session-state.sh`の
 * `.check-user`）、人が答えた時点で`resolveSessionPlanCheckUser`が外す。
 *
 * **`01.check-plan`は上書きしない**（#1905）。計画を出すと、その承認プロンプトで必ずこの
 * フックも飛ぶ（#1893では9秒後）。理由を`input`へ落とすと、画面の見出しが
 * 「計画の承認が必要です」から「質問への回答が必要です」へ変わり、**待たれているのが
 * 計画の承認だと読めなくなる。** 計画への回答で`00.check-user`ごと外れるため、
 * 保ったまま取り残されることは無い。
 */
export async function requestSessionCheckUser(params: {
  repositoryFullName: string;
  issueNumber: number;
}): Promise<boolean> {
  const parsed = parseRepositoryFullName(params.repositoryFullName);
  if (!parsed) return false;

  try {
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await addCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token, "input", {
      keepExistingReasons: ["plan"],
    });
    return true;
  } catch (error) {
    console.error(
      `[dispatch] セッションの確認待ちを記録できませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}

/**
 * 自分で付けた`00.check-user`を、理由ラベルごと外す（#1342・#1417・#1490）。
 *
 * 呼ぶのは2経路ある。
 *
 * - `PostToolUse`（人が答えて作業へ戻った）・`Stop`（保険）フックの報告
 *   （`POST /api/dispatch/sessions/activity`）。**自分が付けたと分かっているときだけ**
 *   （ホスト側の印。`scripts/lib/session-state.sh`の`.check-user`）。`Stop`はturnごとに飛ぶため、
 *   無条件に外すと人が別の理由で付けた`00.check-user`まで落とす
 * - 画面から計画に答えた・質問に回答したとき（#2341。`POST /api/dispatch/plan-decision`・
 *   `POST /api/dispatch/question-answer`）。**画面から答えると承認プロンプト・選択フォームが
 *   出ない**ため上のフックの合図が飛ばず、`Stop`（＝実装が全部終わるまで）まで確認待ちが
 *   残っていた。押した時点で外れないと、人には「まだ何か操作が要る」ようにしか見えない
 *
 * どちらの経路でも外すのは`00.check-user`と理由ラベルだけで、`21.plan-required`は残す。
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
    const token = await resolveInstallationToken(params.repositoryFullName);
    if (!token) return false;

    await removeCheckUserWithReason(parsed.owner, parsed.repo, params.issueNumber, token);
    return true;
  } catch (error) {
    console.error(
      `[dispatch] 計画の承認待ちを解けませんでした（${params.repositoryFullName}#${params.issueNumber}）`,
      error,
    );
    return false;
  }
}
