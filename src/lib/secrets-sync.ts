/**
 * 1Password → GitHub のシークレット同期を画面のボタンから起こすための純粋関数と定数（#1309）。
 *
 * **issue-deckはsecretを書かない。** 起こすのは対象リポジトリの`sync-secrets.yml`
 * （`.github/workflows/reusable-sync-secrets.yml`が本体）で、書き込み権限を持つトークンは
 * その中に閉じている。ここが持つのは「起動してよいか」「画面に何と出すか」の判断だけ。
 *
 * DBに触る処理は`src/lib/secrets-sync-runs.ts`。クライアントコンポーネントからも
 * importするため、このファイルはPrismaに触れない（`lib/dispatch/dispatch-job.ts`と同じ分け方）。
 */

/** 対象リポジトリ側で起動するワークフロー。全リポジトリで同じ名前にする */
export const SECRETS_SYNC_WORKFLOW_FILE = "sync-secrets.yml";

/** 実行の状態。Prismaの`SecretSyncRunStatus`と同じ並び */
export type SecretSyncRunStatus = "QUEUED" | "SUCCEEDED" | "FAILED" | "TIMEOUT";

/**
 * 連打の抑止（クールダウン）。
 *
 * **1Passwordのサービスアカウントには日次レート制限がある**（1Passwordアカウント全体で
 * 1,000リクエスト/日。サービスアカウントを分けても分割されない）。全件同期1回で
 * マニフェストの項目数ぶん（20〜30件）を消費し、`--dry-run`も同じだけ読むため「安全な下見」に
 * ならない。ボタンで気軽に押せるようになるぶん、押しすぎがフリート全体のデプロイを止めうる。
 *
 * ただし**直前が失敗した場合はクールダウンを課さない**。1Password側を直してすぐ試したい
 * 場面が実際にあり（#1307で`db-console`の空値・参照ミスがまさにこれ）、そこで10分待たせると
 * 「押しても何も起きない」と同じ体験になる。
 */
export const SECRETS_SYNC_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 報告が来ないまま放置された実行を諦める時間。ワークフロー側の`timeout-minutes: 10`より
 * 長くとる。**定期実行は持たず、一覧取得・起動のたびに遅延評価で倒す**
 * （`expireStaleDispatchJobs`と同じ形。常駐プロセスを増やさない）。
 */
export const SECRETS_SYNC_TIMEOUT_MS = 20 * 60 * 1000;

/** `only`で指定できるKEYの上限。マニフェスト全件でも30件程度のため、超える指定は誤り */
export const SECRETS_SYNC_MAX_ONLY_KEYS = 40;

/** 画面・APIでやり取りする1実行の形 */
export type SecretSyncRunView = {
  id: string;
  repositoryFullName: string;
  /** 対象を絞ったKEY。空文字はマニフェスト全件 */
  only: string;
  status: SecretSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
  /** 失敗した項目の**名前だけ**。値も値の長さも含めない */
  failedKeys: string[];
  runUrl: string | null;
  message: string | null;
};

/**
 * `only`の入力を正規化する。
 *
 * この値はワークフローの入力を経てシェルスクリプトの引数に入るため、マニフェストのKEYと
 * 同じ字種（英大文字・数字・アンダースコア）だけを通す。ワークフロー側でも同じ形を検証するが、
 * **弾くのは早いほうがよい**（起動してから失敗すると、押した側には理由が見えない）。
 *
 * 戻り値は正規化済みのカンマ区切り文字列。空入力は「全件」を意味する空文字。
 * 不正な場合は`null`。
 */
export function normalizeOnlyKeys(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return "";
  if (typeof input !== "string") return null;

  const keys = input
    .split(",")
    .map((key) => key.trim().toUpperCase())
    .filter((key) => key !== "");

  if (keys.length === 0) return "";
  if (keys.length > SECRETS_SYNC_MAX_ONLY_KEYS) return null;
  if (keys.some((key) => !/^[A-Z0-9_]+$/.test(key))) return null;

  // 重複を落としてから並べる。同じKEYを2回書いても1回ぶんしか読まないようにする
  return [...new Set(keys)].join(",");
}

export type SecretsSyncStartDecision =
  | { allowed: true }
  | { allowed: false; reason: "running" | "cooldown"; message: string };

/**
 * いま同期を起こしてよいか。`latest`はそのリポジトリの最新の実行（無ければ`null`）。
 *
 * - 未完了の実行がある … 二重起動になるため断る
 * - 直近の**成功**から`SECRETS_SYNC_COOLDOWN_MS`以内 … 日次枠の保護のため断る
 * - 直近が失敗・時間切れ … すぐ再実行してよい（直して試す場面のため）
 */
export function canStartSecretsSync(
  latest: SecretSyncRunView | null,
  now: Date,
): SecretsSyncStartDecision {
  if (!latest) return { allowed: true };

  if (latest.status === "QUEUED") {
    return {
      allowed: false,
      reason: "running",
      message: "同期の実行中です。完了してからもう一度実行してください。",
    };
  }

  if (latest.status !== "SUCCEEDED") return { allowed: true };

  const finishedAt = latest.finishedAt ?? latest.startedAt;
  const elapsed = now.getTime() - new Date(finishedAt).getTime();
  if (elapsed >= SECRETS_SYNC_COOLDOWN_MS) return { allowed: true };

  const remainingMinutes = Math.max(1, Math.ceil((SECRETS_SYNC_COOLDOWN_MS - elapsed) / 60_000));
  return {
    allowed: false,
    reason: "cooldown",
    message: `直前の同期から間もないため実行できません（あと約${remainingMinutes}分）。1Passwordの日次枠を消費するため、値を変えたときだけ実行してください。`,
  };
}

/** 画面に出す1行。**値も値の長さも出さない。失敗は項目名だけを見せる** */
export function formatSecretsSyncResult(run: SecretSyncRunView): string {
  if (run.status === "QUEUED") return "実行中...";
  if (run.status === "TIMEOUT") {
    return "結果の報告がありませんでした（GitHub Actionsの実行ログを確認してください）";
  }

  const counts = `同期=${run.syncedCount} スキップ=${run.skippedCount} 失敗=${run.failedCount}`;
  if (run.failedKeys.length === 0) return counts;
  return `${counts}（失敗: ${run.failedKeys.join(", ")}）`;
}
