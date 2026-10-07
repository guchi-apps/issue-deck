/**
 * iOS事前検証（#4138）の結果を、PRの画面へ出す形に読む（#4140）。
 *
 * 結果はサブPCの`scripts/ios-precheck.sh`が**検証したSHAへcommit status**
 * （`issue-deck/ios-precheck`）として付ける（[docs/multi-agent/ios-precheck.md](../../../docs/multi-agent/ios-precheck.md)）。
 * statusはコミットに付くので、修正をpushした新しいSHAには前の結果が引き継がれない。
 * **PRのheadにstatusが無ければ「最新SHAでは未実施」**で、古いSHAの成功を最新の成功として見せない。
 *
 * **対象リポジトリかどうかは`scripts/ios-precheck.conf`ではなく、PRのコミットにstatusが
 * 1件でも付いたかで決める。** confはサブPCのチェックアウトにしか無く、本番のissue-deckは
 * デプロイ物に含めていないため読めない。PRの直近のコミットのどれにもstatusが無ければ
 * 何も出さない（検証の対象外か、一度も依頼していない）。
 */

/** commit statusのcontext名。`scripts/ios-precheck.sh`の`STATUS_CONTEXT`と揃える */
export const IOS_PRECHECK_CONTEXT = "issue-deck/ios-precheck";

/**
 * PRのコミットを遡って見る件数。headが未実施のときに「前回どのSHAで何だったか」を探す範囲。
 *
 * PR一覧（10秒間隔の自動更新）には載せず、Issue詳細の対応PRだけが引く。
 */
export const IOS_PRECHECK_COMMIT_WINDOW = 20;

/**
 * 画面での状態。commit statusの`state`と`description`から決める。
 *
 * - `success` … 成功（テスト未設定でも`success`。その旨は`description`に出る）
 * - `failure` … 検証失敗（ビルド・テスト）
 * - `running` … 依頼済みで、キュー待ち・準備中・ビルド中・テスト中
 * - `waiting` … 検証待ち（接続できない・環境不足・タイムアウトなど）。**成功にも失敗にもしない**
 */
export type IosPrecheckPhase = "success" | "failure" | "running" | "waiting";

export type IosPrecheckResult = {
  phase: IosPrecheckPhase;
  /** commit statusのdescription（「iOS検証待ち（unreachable）: …」など）。無ければnull */
  description: string | null;
  /** 検証したSHA（statusが付いているコミット） */
  sha: string;
  /** statusが付いた時刻（ISO8601）。無ければnull */
  updatedAt: string | null;
};

/**
 * PR1件ぶんのiOS事前検証の要約。PRのコミットのどれにもstatusが無ければ、この値自体を作らない（null）。
 */
export type IosPrecheckSummary = {
  /** PRのheadのSHA */
  headSha: string;
  /** headに付いた結果。無ければnull＝最新SHAでは未実施 */
  head: IosPrecheckResult | null;
  /** headが未実施のとき、それより前で最後に結果が付いたコミット。headに結果があればnull */
  previous: IosPrecheckResult | null;
};

/** GraphQLの`Commit`1件ぶん（`status.context(name:)`で1件だけ引いたもの） */
export type IosPrecheckCommitNode = {
  oid: string;
  status: {
    context: {
      state: string | null;
      description: string | null;
      createdAt: string | null;
    } | null;
  } | null;
};

/** PRのコミットに付けて引くフィールド。`commits(last: …)`の各`commit`の中へ置く */
export const IOS_PRECHECK_COMMIT_FIELDS = `
  oid
  status {
    context(name: "${IOS_PRECHECK_CONTEXT}") {
      state
      description
      createdAt
    }
  }
`;

/**
 * pendingを「検証中」と「検証待ち」に分ける。`scripts/ios-precheck.sh`の`status_for`の文言に合わせる。
 *
 * 進行中は「iOS検証: 準備中／ビルド中／テスト中」「iOS検証待ち（Macのキュー待ち）」、
 * 検証待ちは「iOS検証待ち（<理由>）: <メッセージ>」。知らない文言は検証待ちとして扱う
 * （進んでいるように見せない）。
 */
function pendingPhaseOf(description: string | null): IosPrecheckPhase {
  if (!description) return "waiting";
  if (description.startsWith("iOS検証: ")) return "running";
  if (description.startsWith("iOS検証待ち（Macのキュー待ち）")) return "running";
  return "waiting";
}

function toResult(node: IosPrecheckCommitNode): IosPrecheckResult | null {
  const context = node.status?.context;
  if (!context?.state) return null;
  const state = context.state.toLowerCase();
  const description = context.description?.trim() || null;
  const phase: IosPrecheckPhase =
    state === "success"
      ? "success"
      : state === "pending" || state === "expected"
        ? pendingPhaseOf(description)
        : "failure";
  return { phase, description, sha: node.oid, updatedAt: context.createdAt ?? null };
}

/**
 * PRのコミット（古い順。最後がhead）から要約を作る。どのコミットにもstatusが無ければnull。
 */
export function toIosPrecheckSummary(commits: IosPrecheckCommitNode[]): IosPrecheckSummary | null {
  const headNode = commits[commits.length - 1];
  if (!headNode) return null;
  const head = toResult(headNode);
  if (head) return { headSha: headNode.oid, head, previous: null };
  for (let index = commits.length - 2; index >= 0; index -= 1) {
    const previous = toResult(commits[index]);
    if (previous) return { headSha: headNode.oid, head: null, previous };
  }
  return null;
}
