import type { DispatchHostView, DispatchJobView } from "@/lib/dispatch/dispatch-job";

/**
 * CodexのRemote Control相当（#2524）。実行キューのホストのカードから押して、スマホの
 * ChatGPTアプリからサブPCのCodexへ繋ぐための**ペアリングコードを発行する**。
 *
 * **Claude CodeのRemote Control（#1219）とは出てくるものが違う。** あちらは
 * `claude --remote-control`が`~/.claude/sessions/<pid>.json`へ置くbridgeSessionIdから
 * `https://claude.ai/code/<id>`というURLが組み立てられ、`scripts/session-notify.sh`が
 * セッションの報告に載せてくる（`DispatchSession.remoteControlUrl`）。**Codexは
 * URLを出さない。** 出るのは`codex remote-control pair --json`が返す`XXXX-XXXX`形式の
 * 手動ペアリングコードだけで、**有効期限は10分**（#2521で実機確認）。
 *
 * その違いから、置き場所も寿命も変えてある。
 *
 * - **セッションではなくホストに紐づく。** `serverName`はホスト名（`subpc`）で、Issueごとには
 *   分かれない。1つのコードで繋いだ先には、そのホストで走っているCodexのセッションが
 *   **全部**載っている（`codex agents`に出るもの。tmuxで起こしたTUIも載る）。
 *   Issueごとのリンクとして出すと、押したIssueだけに繋がると誤解させる
 * - **押したときに発行する。** 10分で切れるものを、セッションの報告に載せて配り続けることは
 *   できない。押す→pollerが`codex remote-control start`と`pair`を打つ→コードが画面に出る、
 *   という往復にしてあるのはそのため
 * - **コードは資格情報。** ログイン必須の画面にだけ出し、Issueコメント・PR本文・Push通知・
 *   pollerのログには出さない。期限が切れたらDBの列ごと空にする
 *   （`expireStaleDispatchJobs`。`placeholderValues`と同じ扱い）
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる
 * （`host-reboot.ts`・`host-checkout.ts`と同じ形）。
 */

/**
 * ペアリングのジョブが使う`DispatchJob.repositoryFullName` / `issueNumber`の埋め草。
 *
 * `SELF_UPDATE`・`REBOOT`と同じ理由で、**このジョブはIssueに紐づかない**（対象はホスト）のに
 * `DispatchJob`は両方を必須で持つ。0は「Issueではない」印。
 */
export const CODEX_PAIRING_REPOSITORY = "guchi-apps/issue-deck";
export const CODEX_PAIRING_ISSUE_NUMBER = 0;

/**
 * ペアリングのジョブの活性キー。**ホストで一意にする**（`buildRebootActiveKey`と同じ作法）。
 *
 * 同じホストへ2枚のコードを同時に発行させない。連打するとそのぶん短命のコードが増えるだけで、
 * 押した人が見るのは最後の1枚だけになる。
 */
export function buildCodexPairingActiveKey(hostName: string): string {
  return `codex_pairing:host:${hostName}`;
}

/**
 * ペアリングコードの形（`XXXX-XXXX`）。
 *
 * **pollerから届いた値もこの形だけを通す**（`parsePreviewAction`と同じ作法）。Codexの出力を
 * そのまま画面へ流すと、CLIの版が変わって別のものが返ったときに、それが何であれ画面へ出る。
 */
const CODEX_PAIRING_CODE_PATTERN = /^[0-9A-Za-z]{4}-[0-9A-Za-z]{4}$/;

/** 届いた値をペアリングコードとして読む。形が違えば`null`（画面には何も出ない） */
export function parseCodexPairingCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return CODEX_PAIRING_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * 期限として受け取れる時刻の上限。**発行から10分**というCodexの仕様に対して余裕を持たせた値。
 *
 * pollerから届いた`expiresAt`をそのまま信じると、壊れた値（遠い未来）が入ったときにコードが
 * 消えないまま残る。**上限を超える申告は、この場で今から10分後へ丸める。**
 */
export const CODEX_PAIRING_MAX_TTL_MS = 30 * 60 * 1000;

/** 期限の既定（Codexが`expiresAt`を返さなかった場合に使う） */
export const CODEX_PAIRING_DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * 届いた期限を、保存してよい範囲へ収める。
 *
 * - 過去 … `null`（本当に切れている。コードごと捨てる）
 * - 読めない・届かない … 今から`CODEX_PAIRING_DEFAULT_TTL_MS`後
 * - 遠すぎる未来 … 同じく今から`CODEX_PAIRING_DEFAULT_TTL_MS`後へ丸める
 *
 * **読めなかったからといってコードを捨てない。** 捨てるのは`expiresAt`が壊れていた場合で、
 * `manualPairingCode`のほうは有効なまま——押した人は何も受け取れずに終わる。Codexの仕様
 * （発行から10分）は実機で確かめてある（#2521）ので、読めない巡はそれを当てる。
 * **どのみち期限は必ず入る**ので、掃除（`expireStaleDispatchJobs`）の条件から外れる行は生まれない。
 */
export function normalizeCodexPairingExpiry(value: unknown, now: Date = new Date()): Date | null {
  const fallback = new Date(now.getTime() + CODEX_PAIRING_DEFAULT_TTL_MS);
  const raw =
    typeof value === "number"
      ? // Codexが返すのはepoch秒（#2521の実機確認）。ミリ秒で来た場合も読めるようにしておく
        new Date(value > 1e11 ? value : value * 1000)
      : typeof value === "string" && value !== ""
        ? new Date(value)
        : null;
  if (!raw || Number.isNaN(raw.getTime())) return fallback;
  // **過去だけは`null`。** 既に切れているものを、10分後まで有効だと言い直さない
  if (raw.getTime() <= now.getTime()) return null;
  if (raw.getTime() - now.getTime() > CODEX_PAIRING_MAX_TTL_MS) return fallback;
  return raw;
}

/** そのコードがもう使えないか。期限が入っていなければ「切れている」扱い（出さない側へ倒す） */
export function isCodexPairingExpired(expiresAt: string | Date | null, now: Date = new Date()) {
  if (!expiresAt) return true;
  const at = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() <= now.getTime();
}

/**
 * 押せない理由。**画面と受け口（`enqueueCodexPairingJob`）が同じ判定を使う**
 * （`resolveRebootRejection`と同じ形）。画面が押せると判断した操作だけが届く前提にはしない。
 */
export type CodexPairingRejection =
  | "host_not_found"
  | "offline"
  | "not_capable"
  | "already_queued";

/** 押せない理由を返す。押せるなら`null` */
export function resolveCodexPairingRejection(params: {
  host: DispatchHostView | null;
  /** 未処理の発行が既にあるか。**受け口では`false`で呼ぶ**（最終的な排他はactiveKeyの制約） */
  hasQueuedJob: boolean;
}): CodexPairingRejection | null {
  const host = params.host;
  if (!host) return "host_not_found";
  if (!host.online) return "offline";
  if (host.codexRemoteControlCapable !== true) return "not_capable";
  if (params.hasQueuedJob) return "already_queued";
  return null;
}

/** 押せない理由を、そのまま画面に出す文にする */
export function describeCodexPairingRejection(
  rejection: CodexPairingRejection,
  hostName: string,
): string {
  switch (rejection) {
    case "host_not_found":
      return `${hostName} はまだ申告していません。pollerが動いているか確認してください。`;
    case "offline":
      return `${hostName} が応答していません。pollerが戻ってくると押せるようになります。`;
    case "not_capable":
      return `${hostName} ではCodexのペアリングコードを発行できません（standalone installのCodexが要ります）。`;
    case "already_queued":
      return `${hostName} のペアリングコードは発行中です。`;
  }
}

/** 画面に出す重さ。使用率・チェックアウト・再起動と**同じ3段階** */
export type CodexPairingTone = "normal" | "warn" | "critical";

/** 押した「Codexに繋ぐ」がいまどうなっているか */
export type DispatchHostCodexPairingRow = {
  label: string;
  tone: CodexPairingTone;
  /** まだ結果が出ていない。押し直させないために使う */
  pending: boolean;
  /**
   * 発行されたペアリングコード（`XXXX-XXXX`）。まだ出ていない・切れたなら`null`。
   *
   * **`label`には入れない。** 押した本人にコピーさせるものなので、文の中に埋めずに
   * 単独で出す（画面側が等幅で大きく出し、コピーのボタンを添える）。
   */
  code: string | null;
  /** コードが切れるまでの残り秒。コードが無ければ`null` */
  expiresInSeconds: number | null;
};

/**
 * 発行の結果を、カードの1行へ直す。出すものが無ければ`null`。
 *
 * **成功しても、コードが切れたら消える。** `REBOOT`・`SELF_UPDATE`の結果が10分間そのまま
 * 残るのと違い、こちらは値そのものに寿命がある——切れたコードを出し続けると、押した人は
 * 効かないコードを打ち込むことになる。
 */
export function describeCodexPairingJob(
  job: DispatchJobView | null,
  now: Date = new Date(),
): DispatchHostCodexPairingRow | null {
  if (!job) return null;

  if (job.status === "QUEUED") {
    return {
      label: "ペアリングコードを発行しています。届くまで数秒〜30秒。",
      tone: "normal",
      pending: true,
      code: null,
      expiresInSeconds: null,
    };
  }
  if (job.status === "CLAIMED" || job.status === "RUNNING") {
    return {
      label: "Codexのデーモンを起こしています",
      tone: "normal",
      pending: true,
      code: null,
      expiresInSeconds: null,
    };
  }

  if (job.status === "SUCCEEDED") {
    const code = parseCodexPairingCode(job.codexPairingCode);
    // **コードが切れたら行ごと消す。** 成功の報告だけを残しても、そこからできることが無い
    if (!code || isCodexPairingExpired(job.codexPairingExpiresAt, now)) return null;
    const expiresInSeconds = Math.max(
      0,
      Math.floor((new Date(job.codexPairingExpiresAt as string).getTime() - now.getTime()) / 1000),
    );
    return {
      label: "ChatGPTアプリの「Connect to Codex」でこのコードを入力してください",
      tone: "normal",
      pending: false,
      code,
      expiresInSeconds,
    };
  }

  // 失敗・見送り・取り消しは、押した結果として短い間だけ残す（`REBOOT`と同じ10分）
  const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : null;
  if (finishedAt === null || now.getTime() - finishedAt > CODEX_PAIRING_RESULT_WINDOW_MS) {
    return null;
  }
  if (job.status === "CANCELED") {
    return {
      label: "ペアリングコードの発行を取り消しました。",
      tone: "normal",
      pending: false,
      code: null,
      expiresInSeconds: null,
    };
  }
  return {
    label: `発行できませんでした: ${job.message ?? "理由が返っていません。"}`,
    tone: "critical",
    pending: false,
    code: null,
    expiresInSeconds: null,
  };
}

/**
 * 失敗の表示をボタンの下に出し続ける時間。**`REBOOT_RESULT_WINDOW_MS`と同じ10分**。
 *
 * 成功のほうはコードの期限（`codexPairingExpiresAt`）で消えるので、ここは使わない。
 */
const CODEX_PAIRING_RESULT_WINDOW_MS = 10 * 60 * 1000;

/** 残り時間を「あと 8分20秒」の形にする。切れていれば`null` */
export function formatCodexPairingCountdown(expiresInSeconds: number | null): string | null {
  if (expiresInSeconds === null || expiresInSeconds <= 0) return null;
  const minutes = Math.floor(expiresInSeconds / 60);
  const seconds = expiresInSeconds % 60;
  if (minutes === 0) return `あと ${seconds}秒`;
  return `あと ${minutes}分${String(seconds).padStart(2, "0")}秒`;
}
