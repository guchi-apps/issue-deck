import { NextResponse, type NextRequest } from "next/server";

import {
  normalizeCodexPairingExpiry,
  parseCodexPairingCode,
} from "@/lib/dispatch/codex-pairing";
import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import { parseDispatchHostName, parseDispatchReportStatus } from "@/lib/dispatch/dispatch-job";
import { reportDispatchJob } from "@/lib/dispatch/jobs";
import { MANUAL_STEP_OUTPUT_MAX_LENGTH } from "@/lib/manual-step-command";
import { advanceManualStepRun } from "@/lib/manual-step-run";
import {
  advanceManualStepVerificationCheck,
  recordManualStepVerificationPass,
} from "@/lib/manual-step-verification-patrol";

/** メッセージは画面にそのまま出る。長文が流れ込まないよう頭で切る */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * pollerからのジョブ状態の報告（#1179）。`running` / `succeeded` / `failed` / `skipped` の4つ。
 *
 * `skipped`は「起動する必要が無かった」（#1229）。既にそのIssueのtmuxセッションが動いていた
 * ためpollerが起動を見送った場合で、**失敗ではない**。古いpollerは送ってこないため、
 * 受け口だけが先に新しくなっても従来どおり動く。
 *
 * **`succeeded`は「tmuxセッションが立ち上がった」まで**を意味し、実装の完了ではない。
 * 実装の進捗は`POST /api/progress`（Project Status）が唯一の正として持つ
 * （docs/progress-status-architecture.md）。ここで実装完了まで追うと情報が二重になる。
 *
 * `timeout`・`canceled`はissue-deck側だけが付ける状態なので、ここでは受け付けない。
 */
export async function POST(request: NextRequest) {
  const auth = authorizeDispatch(request.headers.get("authorization"));
  if (auth === "not_configured") {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (auth === "unauthorized") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const jobId = typeof payload?.jobId === "string" && payload.jobId !== "" ? payload.jobId : null;
  const hostName = parseDispatchHostName(payload?.host);
  const status = parseDispatchReportStatus(payload?.status);
  if (!jobId || !hostName || !status) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const message =
    typeof payload?.message === "string" ? payload.message.slice(0, MAX_MESSAGE_LENGTH) : null;
  const tmuxSessionName =
    typeof payload?.tmuxSessionName === "string" && payload.tmuxSessionName !== ""
      ? payload.tmuxSessionName.slice(0, 191)
      : null;

  // 手作業の代行実行（#1828）の結果。**出力は末尾を残して切る**（エラーは最後に出るため）。
  // ここに来た出力はDBに残り、ログイン必須の画面にだけ出る（GitHubにも通知にも出さない）
  const exitCode =
    typeof payload?.exitCode === "number" && Number.isInteger(payload.exitCode)
      ? payload.exitCode
      : null;
  const output =
    typeof payload?.output === "string" && payload.output !== ""
      ? payload.output.slice(-MANUAL_STEP_OUTPUT_MAX_LENGTH)
      : null;

  // Codexのペアリングコード（#2524）。**形（`XXXX-XXXX`）と期限の範囲をここで通す。**
  // Codexの出力をそのまま保存すると、CLIの版が変わって別のものが返ったときに、それが何であれ
  // 画面へ出る。**期限が読めない巡は10分後を当てる**（`normalizeCodexPairingExpiry`）——
  // 期限の分からないコードを残すと、消す条件（`expireStaleDispatchJobs`）から外れる。
  // **`null`が返るのは届いた期限が過去だったときだけ**で、そのときはコードごと捨てる
  const codexPairingCode = parseCodexPairingCode(payload?.pairingCode);
  const codexPairingExpiresAt = codexPairingCode
    ? normalizeCodexPairingExpiry(payload?.pairingExpiresAt)
    : null;

  const result = await reportDispatchJob({
    jobId,
    hostName,
    status,
    message,
    tmuxSessionName,
    exitCode,
    output,
    codexPairingCode: codexPairingExpiresAt ? codexPairingCode : null,
    codexPairingExpiresAt,
  });

  if (!result.ok) {
    // `already_finished`（タイムアウト済みのジョブへ遅れて報告が届いた）はpoller側の異常では
    // ないため、200で「反映しなかった」とだけ伝える。/api/progressと同じ扱い方
    if (result.reason === "already_finished") {
      return NextResponse.json(
        { ok: true, applied: false, reason: result.reason },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const status = result.reason === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.reason }, { status });
  }

  // 自動実行（#1882）を1歩進める。**成功なら次の1件を積み、失敗ならそこで止まる。**
  // 画面が開いているかどうかに関係なく進むのはここで、ブラウザを閉じても実行が続く理由。
  // 手順ごとに「承認して実行」を押す使い方（#1828）では、進める実行そのものが無いので何もしない
  if (result.job.kind === "MANUAL_STEP" && status !== "running") {
    try {
      await advanceManualStepRun({
        repositoryFullName: result.job.repositoryFullName,
        issueNumber: result.job.issueNumber,
      });
      // 完了確認の定期巡回（#2008）も同じ報告で1歩進める。**人が始めた自動実行と巡回は
      // 同時には走らない**（巡回は自動実行が動いているIssueを選ばない）ので、どちらか一方だけが
      // 動く。片方ずつ呼び分ける条件をここに書くと、判定が2か所に増える
      await advanceManualStepVerificationCheck({
        repositoryFullName: result.job.repositoryFullName,
        issueNumber: result.job.issueNumber,
      });
      // 人が流した確認コマンドの結果も残す（#2256）。**巡回の外で全部通ったときに、
      // 画面へ何も残らないのを塞ぐ**——実行の口ごとに書き分けず、報告が届くこの1か所で数え直す
      // （手順ごとに承認して流す使い方でも、自動実行でも、通る経路はここに集まる）
      await recordManualStepVerificationPass({
        repositoryFullName: result.job.repositoryFullName,
        issueNumber: result.job.issueNumber,
      });
    } catch (error) {
      // **報告そのものは受け付ける。** 次を積めなくても、届いた結果を捨てる方が損が大きい
      // （画面から続きを流し直せる）
      console.error(`[POST /api/dispatch/report] 自動実行を進められませんでした ${jobId}:`, error);
    }
  }

  return NextResponse.json(
    { ok: true, applied: true, job: result.job },
    { headers: { "Cache-Control": "no-store" } },
  );
}
