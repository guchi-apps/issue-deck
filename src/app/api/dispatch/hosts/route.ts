import { NextResponse, type NextRequest } from "next/server";

import { authorizeDispatch } from "@/lib/dispatch/dispatch-auth";
import {
  normalizeDispatchHostRepositories,
  parseDispatchHostName,
} from "@/lib/dispatch/dispatch-job";
import { parseDispatchHostCheckout } from "@/lib/dispatch/host-checkout";
import { parseDispatchHostReboot } from "@/lib/dispatch/host-reboot";
import { parseDispatchHostPreview } from "@/lib/dispatch/preview-server";
import {
  parseDispatchHostLaunchHold,
  parseDispatchHostMetrics,
} from "@/lib/dispatch/host-metrics";
import { announceDispatchHost } from "@/lib/dispatch/jobs";

function parsePositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 生きているセッションの本数（#1394）。**0を弾かない**ので`parsePositiveInt`とは分ける。
 * 「1本も無い」は正常な申告で、`null`（申告していない古いpoller）とは意味が違う。
 */
function parseNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * ホストからの申告（#1179）。「自分が実行できるリポジトリの一覧」と生存報告を兼ねる。
 *
 * **ここに実行可能リポジトリを持つのは、ジョブの割り当て可否を決める情報だから**（#1176の
 * コメント）。
 *
 * **ops-dashboardとの境界は#1567で引き直した。** 従来は「ホストの死活・CPU・メモリ・tmux
 * セッション一覧はops-dashboard#34の担当で、issue-deckには持ち込まない」としていたが、
 * 「もう1本セッションを起こしてよいか」を判断するたびに別のアプリを開くことになっていた。
 * 新しい線は**「この仕組みが起こすセッションの起動可否に効くか」**で、issue-deckが持つのは
 * 次の3つに限る。
 *
 * - この仕組みが起こしたtmuxセッションそのもの（`DispatchSession`。#1217から持っている）
 * - 起動可否の判断材料になる使用率（CPU・メモリ・SWAP・`/`のディスク。`metrics`）
 * - その使用率を見てpollerが起動を見送っていること（`launchHold`。#2095）
 *
 * サービス・プロセス・温度・ネットワーク・履歴といったホスト全体の監視は引き続き
 * ops-dashboardの担当で、こちらには持ち込まない。**数値が食い違ったときの正もあちら**
 * （取り方は`ops-dashboard`の`scripts/host-stats/agent.sh`に合わせてあるが、こちらは
 * 申告の巡ごとの単発値で履歴を持たない）。
 *
 * 申告する側（`scripts/subpc-dispatch-poller.sh`）は`local-repos.conf`を走査し、
 * `scripts/start-local-session.sh`と同じ4つの検証を通ったものだけを載せる（検証は
 * `scripts/lib/local-repo-resolve.sh`で共有）。**issue-deck側は検証をやり直さない。**
 * チェックアウトの有無はサブPCにしか分からず、こちらで判定を持つとずれるだけになる。
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
  const hostName = parseDispatchHostName(payload?.host);
  if (!hostName || !Array.isArray(payload?.repositories)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const host = await announceDispatchHost({
    hostName,
    repositories: payload.repositories,
    contractVersion: parsePositiveInt(payload?.contractVersion),
    maxConcurrency: parsePositiveInt(payload?.maxConcurrency),
    agentVersion:
      typeof payload?.agentVersion === "string" ? payload.agentVersion.slice(0, 191) : null,
    // **申告していない（古いpoller）と「撮れない」を区別する**（#1268）。boolean以外はnull
    screenshotCapable:
      typeof payload?.screenshotCapable === "boolean" ? payload.screenshotCapable : null,
    // セッションの操作（#1332）に対応したpollerだけが送ってくる。**未申告はnull＝非対応扱い**で、
    // 制御ジョブを配らない（古いpollerは`kind`を読まず、起動ジョブとして解釈してしまう）
    sessionControlCapable:
      typeof payload?.sessionControl === "boolean" ? payload.sessionControl : null,
    // 追加指示の3段階プロトコル（#1012）に対応したpollerだけが送ってくる。**未申告はnull＝
    // 非対応扱い**。`sessionControl`と分けるのは、あちらが固定の`C-c`だけを送るのに対し、
    // こちらは内容のある文字列を送るため、対応していないpollerへ渡したときの事故の質が違うため
    instructionCapable:
      typeof payload?.instruction === "boolean" ? payload.instruction : null,
    // 横断質問セッション（#1454）を起こせるpollerだけが送ってくる。**未申告はnull＝非対応扱い**で、
    // 横断質問ジョブを配らない（`sessionControl`・`instruction`と同じ向き）
    crossRepoQuestionCapable:
      typeof payload?.crossRepoQuestion === "boolean" ? payload.crossRepoQuestion : null,
    // 手作業の代行実行（#1828）を実行できるpollerだけが送ってくる。**未申告はnull＝非対応扱い**。
    // `instruction`と分けるのは、あちらが走っているセッションの入力欄へ1行流すだけなのに対し、
    // こちらは**シェルでコマンドを実行する**ため、届いた先で起きることが違うから
    manualStepCapable:
      typeof payload?.manualStep === "boolean" ? payload.manualStep : null,
    // 走っている代行実行を止められるpollerだけが送ってくる（#1882）。**未申告はnull＝非対応扱い**。
    // `manualStep`と分けるのは、代行実行を実行できるpollerでも止める側の実装が入っているとは
    // 限らないため。非対応と分かっていれば、画面は押す前に「打ち切りまで待つ」ことを案内できる
    manualStepAbortCapable:
      typeof payload?.manualStepAbort === "boolean" ? payload.manualStepAbort : null,
    // 埋めた値を差し込んで代行実行できるpollerだけが送ってくる（#2403）。**未申告はnull＝非対応扱い**。
    // `manualStep`と分けるのは、古いpollerが`placeholderValues`を黙って無視して、
    // 穴が空いたままの`command`をそのまま実行してしまうため（#2051が防いだ状態そのもの）。
    // 「配ってから`failed`で返る」で済まない種類の非対応なので、申告が無ければ配らない
    manualStepValuesCapable:
      typeof payload?.manualStepValues === "boolean" ? payload.manualStepValues : null,
    // 計画レビュー（G1・#1855）を起こせるpollerだけが送ってくる。**未申告はnull＝非対応扱い**。
    // このジョブは計画コメントの投稿を契機に**自動で積まれる**ため、非対応のpollerへ配ると
    // 計画のたびに`failed`のジョブが並ぶ（他の種別より、申告を見てから配る意味が大きい）
    planReviewCapable: typeof payload?.planReview === "boolean" ? payload.planReview : null,
    // リポジトリ全体のコードレビュー（#698）を起こせるpollerだけが送ってくる。**未申告はnull＝
    // 非対応扱い**。`planReview`と分けるのは、こちらは人が画面から押して起こすもので、非対応の
    // ホストへ配ると「押したのに`failed`だけが返る」ことになるため（選択肢の側で理由を出す）
    codeReviewCapable: typeof payload?.codeReview === "boolean" ? payload.codeReview : null,
    // Codex CLIでセッションを起こせるpollerだけが送ってくる（#2505）。**未申告はnull＝非対応扱い**。
    // 古いpollerはジョブの`agent`を読まないため、配るとCodexを選んだのにClaude Codeが黙って立つ
    // （`manualStepValues`と同じ、「配ってから`failed`で返る」では済まない種類の非対応）
    codexCapable: typeof payload?.codex === "boolean" ? payload.codex : null,
    // Codexのペアリングコードを発行できるpollerだけが送ってくる（#2524）。**未申告はnull＝
    // 非対応扱い**。`codex`とは別に持つのは、`remote-control`が動くのは公式インストーラの
    // standalone installで入れたCodexだけで、npmで入れたものはサブコマンドが存在しても
    // 共有のapp-serverデーモンを起こせないため（#2521）
    codexRemoteControlCapable:
      typeof payload?.codexRemoteControl === "boolean" ? payload.codexRemoteControl : null,
    selfUpdateCapable:
      typeof payload?.selfUpdate === "boolean" ? payload.selfUpdate : null,
    // セッション本数の上限と、申告した時点の本数（#1394）。**上限に達している間、pollerは
    // 起動ジョブを取りに行かない**（#1361）ので、これが無いと画面は「順番待ちのまま進まない」
    // 理由を出せない。判定は引き続きpoller側が持ち、ここは写しを受け取るだけ
    maxSessions: parsePositiveInt(payload?.maxSessions),
    liveSessions: parseNonNegativeInt(payload?.liveSessions),
    // リソース使用率（#1567）。**1つでも壊れていれば全体を`null`にする**
    // （`parseDispatchHostMetrics`）。部分的に採用すると、取れなかった項目が0＝空きに見える
    metrics: parseDispatchHostMetrics(payload?.metrics),
    // メモリ・SWAPの逼迫で起動ジョブを見送っているか（#2095）。**判定はpoller側**で、ここは
    // 結果を受け取るだけ（閾値はサブPCの`dispatch.env`が正。2か所に持つと必ずずれる）。
    // 見送っていない巡・申告しない古いpollerでは`null`＝「見送りの説明を出さない」
    launchHold: parseDispatchHostLaunchHold(payload?.launchHold),
    // pollerが動かしているチェックアウトの版（#1612）。**`agentVersion`とは別物**で、
    // あちらは手で上げるプロトコル版数、こちらは実際に走っているスクリプトの事実。
    // `develop`へマージしても届かないことに気付ける唯一の手掛かりになる
    checkout: parseDispatchHostCheckout(payload?.checkout),
    // 確認環境（#2444）を起こせるpollerだけが送ってくる。**未申告はnull＝非対応扱い**
    // （`selfUpdate`と同じ向き。配ると未知の種別として`failed`になる）
    previewCapable: typeof payload?.preview === "boolean" ? payload.preview : null,
    // 確認環境を起こせるリポジトリ（#2444）。**未申告（古いpoller）は`null`＝「絞り込めない」**で、
    // そのとき画面は`repositories`をそのまま並べる。空配列へ倒すと一覧が丸ごと消える
    previewRepositories: Array.isArray(payload?.previewRepositories)
      ? normalizeDispatchHostRepositories(payload.previewRepositories)
      : null,
    // いま動いている確認環境（#2444）。**`repository`と`port`が揃わなければ全体を`null`**にし、
    // 「動いていない」として扱う（`parseDispatchHostPreview`）。止まっているものが画面で
    // 動いているように見えるのが、この写しでいちばん困る壊れ方
    preview: parseDispatchHostPreview(payload?.previewState),
    // ホストごと再起動できるpollerだけが送ってくる（#2496）。**未申告はnull＝非対応扱い**
    // （`selfUpdate`と同じ向き）。pollerは`sudo -n -l /usr/sbin/reboot`が通るときだけ真を送る
    rebootCapable: typeof payload?.reboot === "boolean" ? payload.reboot : null,
    // 再起動が要るか・いつから起動しているか（#2496）。**画面へ出すための写しで、判定には
    // 使わない**（押せる条件に効くのはセッション本数だけ）。`required`が読めなければ全体をnull
    reboot: parseDispatchHostReboot(payload?.rebootState),
  });

  return NextResponse.json({ ok: true, host }, { headers: { "Cache-Control": "no-store" } });
}
