import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { formatRelativeDate } from "@/lib/format-relative-date";

/**
 * ホストが申告する「いま動いているスクリプトの版」（#1612）。
 *
 * pollerが動かすのは自分と同じチェックアウト（`SCRIPT_DIR`基準）の
 * `reap-sessions.sh`・`reap-dev-servers.sh`・ランチャーで、**これを自動で更新する仕組みは無い**。
 * つまり`develop`へマージしただけではサブPCの挙動は変わらないのに、変わっていないことに
 * 気付く手掛かりがどこにも無かった。2026-08-15に#1600を調べたときは97コミット遅れており、
 * #1454（横断質問セッションの回収）と#1541（引き渡し済みセッションの回収）が
 * **どちらもマージ済みなのに一度も効いていなかった**（worktreeで`--dry-run`すると直って
 * 見えるため、実機との差にも気付けない）。
 *
 * **足すのは計器だけで、pollerに`git pull`はさせない**（`docs/multi-agent/gates.md`
 * 「監督のための役は新設しない」）。レビューを経ていないコードが無人で走り出す形にはせず、
 * 「遅れている」という事実だけを画面へ出して、取り込むかどうかは人が決める。
 *
 * **`agentVersion`とは別物。** あちらは約束を変えたときに手で上げるプロトコル版数で、
 * チェックアウトの鮮度とは無関係（実際、版数が同じまま97コミット遅れていた）。
 *
 * Prismaに触れないため、クライアントコンポーネントからimportできる
 * （`host-metrics.ts`・`issue-session.ts`と同じ形）。
 */

/**
 * 申告1回ぶんのチェックアウトの状態。
 *
 * **`commit`だけが必須。** 「どのコミットが動いているか」はgitさえ読めれば必ず分かる一方、
 * 残りは取れないことがある（fetchできなければ遅れは数えられず、detached HEADにはブランチが
 * 無い）。取れなかった項目のために全体を落とすと、いちばん確実な事実まで見えなくなる。
 */
export type DispatchHostCheckout = {
  /** 短縮SHA（`git rev-parse --short HEAD`） */
  commit: string;
  /** チェックアウトしているブランチ。detached HEADでは`null` */
  branch: string | null;
  /** HEADのコミット日時。版の古さを「日数」でも読めるようにするためのもの */
  committedAt: string | null;
  /**
   * 追跡ブランチ（既定は`origin/develop`）に対して何コミット遅れているか。
   * **`null`は「数えられなかった」**（fetchに失敗した・追跡ブランチが無い）で、0とは区別する。
   */
  behindCount: number | null;
  /**
   * 最後にoriginを見た時刻（`.git/FETCH_HEAD`のmtime）。**`behindCount`はこの時点の値**で、
   * それ以降にマージされたぶんは含まれない。pollerは毎巡fetchしない（既定6時間ごと）ため、
   * これが無いと「0コミット遅れ」がいつ時点の話なのか分からない。
   */
  fetchedAt: string | null;
};

/** 短縮SHAから完全なSHAまで受ける。gitの出力なので小文字の16進のみ */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
/** gitのブランチ名として通る範囲へ絞る（申告は外から届くため、そのまま画面へ出さない） */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,191}$/;

function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * pollerが送ってきた`checkout`を検証する。
 *
 * **`commit`が読めなければ全体を`null`にする**（版が特定できない申告に意味が無いため）。
 * 逆に、`branch`・`committedAt`・`behindCount`・`fetchedAt`が欠けたり壊れていたりしても
 * 全体は落とさず、その項目だけを`null`にする。`parseDispatchHostMetrics`が1つでも壊れていれば
 * 全体を落とすのとは向きが違うのは、あちらが**割合として並ぶ5つ**（欠けた項目が0＝空きに
 * 見える）なのに対し、こちらは**独立した事実の集まり**で、1つ欠けても残りが誤読されないため。
 */
export function parseDispatchHostCheckout(value: unknown): DispatchHostCheckout | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Record<string, unknown>;

  const commit = typeof input.commit === "string" ? input.commit.trim().toLowerCase() : "";
  if (!COMMIT_PATTERN.test(commit)) return null;

  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const behind = input.behindCount;

  return {
    commit,
    branch: BRANCH_PATTERN.test(branch) ? branch : null,
    committedAt: parseIsoDate(input.committedAt),
    behindCount:
      typeof behind === "number" && Number.isInteger(behind) && behind >= 0 ? behind : null,
    fetchedAt: parseIsoDate(input.fetchedAt),
  };
}

/**
 * 画面に出す1行の重さ。**使用率（`DispatchHostMetricTone`）と同じ3段階**にして、
 * 同じ色が画面の中で違う重さを指さないようにする。
 */
export type DispatchHostCheckoutTone = "normal" | "warn" | "critical";

/**
 * 赤へ変わる遅れのコミット数。
 *
 * **1コミットでも遅れていれば橙**（マージ済みの修正が効いていない可能性がその時点で生まれる）。
 * ただしマージ直後は必ずここを通るため、数コミットの遅れを赤にすると常時赤になって
 * 意味を失う。日をまたいで放置されるとこの桁になる（#1600のときは97）ため、そこを赤にする。
 */
const CRITICAL_BEHIND_COUNT = 10;

/**
 * `behindCount`がこの時間より古いfetchに基づいていれば、数字に「いつ時点か」を添える。
 * pollerの既定のfetch間隔（6時間）の倍で、1回取りこぼした程度では注記が出ない幅。
 */
const STALE_FETCH_MS = 12 * 60 * 60 * 1000;

/** 画面に出す1行 */
export type DispatchHostCheckoutRow = {
  /** 「develop fbb809d」のような、いま動いている版そのもの */
  version: string;
  /** 「97コミット遅れ」「最新」「遅れ不明」など。遅れの状態を1語で表す */
  status: string;
  /** 状態の補足（いつ時点の数字か・HEADの日付）。無ければ`null` */
  detail: string | null;
  tone: DispatchHostCheckoutTone;
};

/**
 * 申告されたチェックアウトの状態を画面の行へ直す。**出せない場合は`null`**（行ごと出さない）。
 *
 * 出さないのは次の2つで、どちらも使用率（`describeDispatchHostMetrics`）と同じ理由。
 * 古い申告を今の姿として見せない。
 *
 * - 申告が無い（古いpoller・gitが無い・読めなかった巡）
 * - ホストが応答していない（`online`がfalse）
 */
export function describeDispatchHostCheckout(
  host: DispatchHostView,
  now: Date = new Date(),
): DispatchHostCheckoutRow | null {
  const checkout = host.checkout;
  if (!checkout || !host.online) return null;

  const version = checkout.branch
    ? `${checkout.branch} ${checkout.commit}`
    : // detached HEADはそれ自体が異常な状態なので、ブランチ名の代わりに事実を出す
      `${checkout.commit}（detached）`;

  const details: string[] = [];
  if (checkout.committedAt) details.push(formatRelativeDate(checkout.committedAt, now.getTime()));

  if (checkout.behindCount === null) {
    // fetchできていない。**「遅れていない」とは言えない**ので、遅れ0と同じ顔にはしない
    return { version, status: "遅れ不明", detail: details.join("・") || null, tone: "warn" };
  }

  // 数えた時点が古ければ、そのぶんは数字に含まれていないことを明示する
  if (checkout.fetchedAt && now.getTime() - new Date(checkout.fetchedAt).getTime() > STALE_FETCH_MS) {
    details.push(`${formatRelativeDate(checkout.fetchedAt, now.getTime())}時点`);
  }
  const detail = details.join("・") || null;

  if (checkout.behindCount === 0) {
    return { version, status: "最新", detail, tone: "normal" };
  }
  return {
    version,
    status: `${checkout.behindCount}コミット遅れ`,
    detail,
    tone: checkout.behindCount >= CRITICAL_BEHIND_COUNT ? "critical" : "warn",
  };
}
