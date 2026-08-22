import { githubGraphql } from "@/lib/github/graphql";

/**
 * コミットの「GitHubがPRのChecksとして数えるチェック」を取得する（#1578）。
 *
 * **RESTの`/commits/{sha}/check-runs`を使ってはいけない。** あれはそのSHAに紐づくチェックを
 * 分け隔てなく返すため、`issues`・`issue_comment`・`workflow_dispatch`・`workflow_run`・
 * `schedule`で起動したワークフローのジョブまで混ざる。issue-deckの`develop`は無人実行の
 * ワークフローが常時走っているため、リリースPR（headが`develop`そのもの）のheadコミットには
 * 実測で**58件のワークフロー実行・218件のcheck-run**がぶら下がっており、そのうちGitHubが
 * PRのChecksとして数えるのは`pull_request`・`push`で起動した**5件のワークフロー実行・27件**
 * だけだった。残りをそのまま集約すると、無関係な自動化のキャンセル1件で「CI失敗」、実行中1件で
 * 「CI実行中」になり、GitHubの画面では成功・マージ可能なのにissue-deckだけが失敗を出す。
 *
 * GraphQLの`Commit.statusCheckRollup`は**GitHubの画面が出しているものそのもの**で、この
 * 選別を自前で再現しなくてよい（起動イベントで絞る自作フィルタは、GitHub Actions以外の
 * チェック——外部CIのcommit status——を落としてしまう）。
 */

/** チェック1件。RESTのcheck-runと同じ語彙（小文字）へ正規化したもの */
export type RollupCheck = { status: string; conclusion: string | null };

/**
 * CI状態の集約から外すワークフローのファイル名（#1799）。
 *
 * **これらはCIではなく、issue-deck自身が各リポジトリへ配っている運用自動化**（ラベル付け・
 * 自動レビュー・自動マージ・自動修復・リリース起動）で、callerのファイル名は配布先でも同じ。
 * PRのheadコミットにはこれらのcheck-runもぶら下がるため、素直に集約すると「CI」を名乗る
 * バッジが運用自動化の進行状況になってしまう。
 *
 * とくに`claude-review-develop.yml`は**CIの完了を待ってからレビューし、通ったらマージする**
 * ワークフローで、`wait-for-ci` → `risk-check` → `claude-review` → `auto-merge`のいずれかが
 * PRが開いている間ずっと実行中になる。つまり集約に含めている限り、自動マージされるPRは
 * 一度も「CI通過」を表示できない——CIが終わった後に更新ボタンを押しても「CI実行中」のままで、
 * ボタンが効いていないように見えていた（#1799。マージボタンが押せない事例は
 * [docs/multi-agent/labels.md](../../../docs/multi-agent/labels.md)にも記録がある）。
 *
 * 外すのはここに挙げたものだけで、`ci.yml`・`deploy.yml`・`version-tag-check.yml`などの
 * 検査系と、リポジトリ固有のワークフロー・外部CIのcommit statusはそのまま数える
 * （**知らないものは数える**側に倒し、CIを見落とさないようにする）。
 */
const NON_CI_WORKFLOW_FILES = new Set([
  "claude-issue-dispatch.yml",
  "claude-review-develop.yml",
  "claude-conflict-resolve.yml",
  "claude-ci-fix.yml",
  "claude-pr-repair.yml",
  "issue-labels.yml",
  "release-develop-to-main.yml",
  "shared-knowledge-propose.yml",
  "propagate-workflow-tag.yml",
  "sync-secrets.yml",
]);

/**
 * 自動マージ可否の判定（`claude-review-develop.yml`）の進み具合（#1968）。
 *
 * - `pending` … 判定のcheck-runがまだ完了していない（＝マージしてよいかがまだ決まっていない）
 * - `settled` … 判定のcheck-runが揃って完了している（結論は対応Issueの`00.check-user`側にある）
 * - `unknown` … 判定のcheck-runが1件も無い。ワークフローが配られていないリポジトリ、
 *   起動前、あるいはチェックが多すぎて1件ずつ見られなかった場合
 */
export type MergeJudgementState = "pending" | "settled" | "unknown";

/**
 * 判定のどの段階で止まっているか（#2059）。`state`が`pending`のときだけ意味を持つ。
 *
 * `claude-review-develop.yml`のジョブは**直列**（`wait-for-ci` → `risk-check` →
 * `claude-review` → `auto-merge`）で、CIの完了を待ってからレビューが始まる。実測
 * （PR #2056）ではCI完了が06:42:11、`claude-review`完了が06:45:03で、**画面に「CI通過」が
 * 出てからさらに約3分、レビューと判定だけが動いている窓**がある。この窓で何を待っているかを
 * 画面に出すためにジョブ名を取り出す。
 */
export type MergeJudgementStep = "wait-for-ci" | "risk-check" | "claude-review" | "auto-merge";

/** 自動マージ可否の判定（`claude-review-develop.yml`）の進み具合（#1968・#2059） */
export type MergeJudgement = {
  state: MergeJudgementState;
  /** 進行中のジョブ。`pending`以外・ジョブ名が想定外のときはnull（#2059） */
  step: MergeJudgementStep | null;
  /** 進行中のジョブの実行ログURL。`pending`以外・取得できなければnull（#2059） */
  runUrl: string | null;
};

/** 判定のcheck-runを1件も見られなかったときの値。従来どおり画面からマージできる側へ倒す */
export const MERGE_JUDGEMENT_UNKNOWN: MergeJudgement = {
  state: "unknown",
  step: null,
  runUrl: null,
};

/**
 * 自動マージ可否を判定するワークフローのファイル名（#1968）。callerのファイル名は配布先でも同じ。
 *
 * このワークフローのcheck-runは`NON_CI_WORKFLOW_FILES`でCI状態の集約から外れている（#1799）。
 * 外したこと自体は正しい（外さないと自動マージされるPRが一度も「CI通過」を表示できない）が、
 * その結果**判定が走っている最中でもCI状態が`success`になり、画面のマージボタンが警告も
 * 確認ダイアログも無しに1クリックでマージできる状態になっていた**。実際にPR #1959が判定の
 * 6分前にマージされている。CI状態とは別の軸としてここで進み具合を取り出し、判定中は
 * 画面からマージできないようにする（`isMergeJudgementPending`）。
 */
const MERGE_JUDGEMENT_WORKFLOW_FILE = "claude-review-develop.yml";

/**
 * 判定ワークフローのジョブ名 → 画面へ出す段階（#2059）。
 *
 * check-runの名前は`review / claude-review`のように「callerのジョブID / 呼び出し先のジョブ名」
 * になるため、最後の`/`より後ろだけを見る（callerのジョブIDは配布先で変わりうる）。
 * 失敗時の肩代わりジョブ（`*-fallback`）は本体と同じ段階として扱う——待っている人から見れば
 * 「レビュー中」「自動マージの判定中」であることに変わりがない。
 */
const JUDGEMENT_STEP_BY_JOB: Record<string, MergeJudgementStep> = {
  "wait-for-ci": "wait-for-ci",
  "risk-check": "risk-check",
  "claude-review": "claude-review",
  "claude-review-fallback": "claude-review",
  "auto-merge": "auto-merge",
  "auto-merge-fallback": "auto-merge",
};

/** ワークフロー内での進行順。未完了のジョブが複数あるときに先に来る方を「いま待っているもの」とする */
const JUDGEMENT_STEP_ORDER: MergeJudgementStep[] = [
  "wait-for-ci",
  "risk-check",
  "claude-review",
  "auto-merge",
];

export type CheckRollup = {
  /**
   * GitHub自身の集約結果（小文字。`success` / `pending` / `failure` / `error` / `expected`）。
   * チェックが1件も無ければnull。
   */
  state: string | null;
  /**
   * チェック1件ずつ。`CONTEXTS_PAGE_SIZE`を超える場合だけnullで、そのときは`state`だけで判断する
   * （ページングを重ねるより、GitHubの集約値をそのまま使う方が問い合わせ1回で済み、ずれも生まない）。
   */
  checks: RollupCheck[] | null;
  /**
   * 自動マージ可否の判定の進み具合（#1968）。CI状態（`checks`）とは別の軸で、
   * `claude-review-develop.yml`のcheck-runだけを見て決める。
   */
  mergeJudgement: MergeJudgement;
};

/** 1回のクエリで引くチェックの上限。GraphQLの`first`の上限値でもある */
const CONTEXTS_PAGE_SIZE = 100;

/**
 * `statusCheckRollup`の中身。ref経由・PR経由のどちらのクエリでも同じ形を引く。
 *
 * `checkSuite.workflowRun.workflow.resourcePath`は、そのcheck-runがどのワークフローのものかを
 * 見て運用自動化を集約から外すために取る（#1799。`NON_CI_WORKFLOW_FILES`）。`name`と
 * `detailsUrl`は、判定中に何を待っているのかを画面へ出すために取る（#2059）。いずれも同じ
 * クエリに足すだけなのでGitHub APIの消費は増えない。
 */
const ROLLUP_FIELDS = `
  state
  contexts(first: ${CONTEXTS_PAGE_SIZE}) {
    totalCount
    nodes {
      __typename
      ... on CheckRun {
        name
        detailsUrl
        status
        conclusion
        checkSuite {
          workflowRun {
            workflow {
              resourcePath
            }
          }
        }
      }
      ... on StatusContext {
        state
      }
    }
  }
`;

const QUERY = `
  query($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        ... on Commit {
          statusCheckRollup {
            ${ROLLUP_FIELDS}
          }
        }
      }
    }
  }
`;

/**
 * PR1件ぶんに引く中身（#1742）。**CI状態とコンフリクト有無を1回のクエリでまとめて取る**ためにある。
 *
 * `mergeable`はRESTだとPRの単体取得でしか返らないため、PR一覧で出そうとするとPR1件につき
 * 1回APIが増える。GraphQLの`PullRequest`は`mergeable`と（headコミットの）`statusCheckRollup`を
 * 同じ1クエリで返せるので、いま消費しているCI状態の1回に相乗りさせられる。
 *
 * `commits(last: 1)`が返すのはPRのheadコミットで、ref経由で`head.sha`を指定した場合と同じもの。
 */
const PULL_REQUEST_FIELDS = `
  mergeable
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          ${ROLLUP_FIELDS}
        }
      }
    }
  }
`;

/**
 * 複数PRを**エイリアス（`p0`・`p1`…）で1本のクエリへ並べる**（#1962）。
 *
 * PR一覧はPR1件につき1回GraphQLを投げており、10秒間隔の自動更新と合わせると消費が
 * 「360巡/時 × draft以外のopen PR数」になっていた。共有ワークフローの参照タグを配ると
 * 14リポジトリ前後へ一斉にPRが出るため、いちばん見たい場面で上限（5,000ポイント/時）に
 * 触れる形になっていた。
 *
 * **エイリアスで並べても消費はほぼ増えない。** GraphQLのコストは`first`/`last`を持つ
 * 接続のノード数から計算され、`repository` → `pullRequest`はどちらも単一ノードのため、
 * 実測（`rateLimit { cost }`）で50PRまで1ポイント・100PRで2ポイントだった。1件ずつ投げると
 * PR件数ぶんのポイントになるのと対照的で、これがまとめる理由そのものになっている。
 */
function buildPullRequestQuery(count: number): string {
  const declarations = Array.from(
    { length: count },
    (_, index) => `$owner${index}: String!, $name${index}: String!, $number${index}: Int!`,
  ).join(", ");
  const selections = Array.from(
    { length: count },
    (_, index) => `  p${index}: repository(owner: $owner${index}, name: $name${index}) {
    pullRequest(number: $number${index}) {
      ${PULL_REQUEST_FIELDS}
    }
  }`,
  ).join("\n");
  return `query(${declarations}) {\n${selections}\n}`;
}

type RollupContextNode = {
  __typename?: string;
  /** CheckRun。`review / claude-review`のように「callerのジョブID / ジョブ名」（#2059） */
  name?: string | null;
  /** CheckRun。そのジョブの実行ログのURL（#2059） */
  detailsUrl?: string | null;
  /** CheckRun。`QUEUED` / `IN_PROGRESS` / `COMPLETED`など */
  status?: string | null;
  /** CheckRun。`SUCCESS` / `FAILURE` / `CANCELLED` / `SKIPPED`など */
  conclusion?: string | null;
  /** StatusContext（外部CIのcommit status）。`SUCCESS` / `PENDING` / `FAILURE`など */
  state?: string | null;
  /** CheckRun。GitHub Actions発なら`/owner/repo/actions/workflows/ci.yml`が入る（#1799） */
  checkSuite?: {
    workflowRun?: { workflow?: { resourcePath?: string | null } | null } | null;
  } | null;
};

/** `statusCheckRollup`のノード。ref経由・PR経由で同じ形を受ける */
type RollupNode = {
  state: string | null;
  contexts: { totalCount: number; nodes: RollupContextNode[] };
};

type RollupResponse = {
  repository: {
    object: {
      statusCheckRollup: RollupNode | null;
    } | null;
  } | null;
};

type PullRequestNode = {
  /** `MERGEABLE` / `CONFLICTING` / `UNKNOWN`（GitHubが判定中） */
  mergeable: string | null;
  commits: { nodes: { commit: { statusCheckRollup: RollupNode | null } | null }[] };
};

/** エイリアス（`p0`・`p1`…）をキーにしたPRごとの応答。読めなかったエイリアスはnullで返る */
type PullRequestRollupResponse = Record<string, { pullRequest: PullRequestNode | null } | null>;

/**
 * commit status（StatusContext）を、check-runと同じ`status`/`conclusion`の形へ寄せる。
 * `PENDING`・`EXPECTED`は完了していない扱いにして、check-runの実行中と同じ経路で判定させる。
 */
function fromStatusContext(state: string): RollupCheck {
  const normalized = state.toLowerCase();
  if (normalized === "pending" || normalized === "expected") {
    return { status: normalized, conclusion: null };
  }
  return {
    status: "completed",
    conclusion: normalized === "success" ? "success" : "failure",
  };
}

function toRollupCheck(node: RollupContextNode): RollupCheck | null {
  if (node.__typename === "CheckRun") {
    return {
      status: (node.status ?? "").toLowerCase(),
      conclusion: node.conclusion ? node.conclusion.toLowerCase() : null,
    };
  }
  if (node.__typename === "StatusContext" && node.state) {
    return fromStatusContext(node.state);
  }
  return null;
}

/** `/owner/repo/actions/workflows/ci.yml` → `ci.yml`。Actions発でなければnull */
function workflowFileOf(node: RollupContextNode): string | null {
  const path = node.checkSuite?.workflowRun?.workflow?.resourcePath;
  if (!path) return null;
  return path.slice(path.lastIndexOf("/") + 1);
}

/** CI状態の集約に数えるチェックか（#1799）。ワークフローが分からないものは数える */
function isCiCheck(node: RollupContextNode): boolean {
  const file = workflowFileOf(node);
  return file === null || !NON_CI_WORKFLOW_FILES.has(file);
}

/** check-run名（`review / claude-review`）からジョブ名だけを取り出す（#2059） */
function jobNameOf(node: RollupContextNode): string {
  const name = node.name ?? "";
  return name.slice(name.lastIndexOf("/") + 1).trim();
}

/** そのcheck-runがどの段階のものか。想定外のジョブ名（`identify-issue`など）はnull（#2059） */
function judgementStepOf(node: RollupContextNode): MergeJudgementStep | null {
  return JUDGEMENT_STEP_BY_JOB[jobNameOf(node)] ?? null;
}

/**
 * 未完了のcheck-runから「いま待っているもの」を1件選ぶ（#2059）。
 *
 * `needs`で待っている後続ジョブもcheck-runとしては`queued`で先に並ぶため、単に先頭を取ると
 * 実行中でないジョブを指してしまう。実行中（`in_progress`）があればそれを優先し、無ければ
 * ワークフロー内の進行順（`JUDGEMENT_STEP_ORDER`）がいちばん早いものを選ぶ。
 */
function currentJudgementCheck(pendingChecks: RollupContextNode[]): RollupContextNode | null {
  const running = pendingChecks.filter(
    (node) => (node.status ?? "").toLowerCase() === "in_progress",
  );
  const candidates = running.length > 0 ? running : pendingChecks;
  const orderOf = (node: RollupContextNode) => {
    const step = judgementStepOf(node);
    // 想定外のジョブ名は最後尾へ。既知の段階が動いているならそちらを名乗らせる。
    return step === null ? JUDGEMENT_STEP_ORDER.length : JUDGEMENT_STEP_ORDER.indexOf(step);
  };
  return [...candidates].sort((a, b) => orderOf(a) - orderOf(b))[0] ?? null;
}

/**
 * 自動マージ可否の判定の進み具合を決める（#1968）。
 *
 * **`claude-review-develop.yml`のcheck-runだけを見る。** 1件でも未完了なら`pending`で、
 * 判定が下るまで画面からマージさせない。1件も無ければ`unknown`——ワークフローを配って
 * いないリポジトリまで巻き込んでマージできなくしないため、そこは従来どおり押せる側へ倒す。
 *
 * キャンセル・スキップされたcheck-runは`completed`なので`settled`として扱う。判定が
 * 得られないまま止まった場合に画面を塞ぎ続けるより、押せる側へ戻す方を選んでいる
 * （ワークフロー側も`wait-for-ci`のタイムアウトをfail-openにしており、方針を揃える）。
 *
 * `pending`のときは**どのジョブを待っているか**（`step`）と、その実行ログのURL（`runUrl`）も
 * 返す（#2059）。「CI通過」なのにマージボタンが「判定中」で押せない理由が、画面のどこにも
 * 書かれていなかったため（唯一あった文言はボタンの`title`属性で、スマホでは表示されない）。
 */
function toMergeJudgement(nodes: RollupContextNode[]): MergeJudgement {
  const judgementChecks = nodes.filter(
    (node) => workflowFileOf(node) === MERGE_JUDGEMENT_WORKFLOW_FILE,
  );
  if (judgementChecks.length === 0) return MERGE_JUDGEMENT_UNKNOWN;
  const pendingChecks = judgementChecks.filter(
    (node) => (node.status ?? "").toLowerCase() !== "completed",
  );
  if (pendingChecks.length === 0) return { state: "settled", step: null, runUrl: null };

  const current = currentJudgementCheck(pendingChecks);
  return {
    state: "pending",
    step: current ? judgementStepOf(current) : null,
    runUrl: current?.detailsUrl ?? null,
  };
}

function toRollupChecks(nodes: RollupContextNode[]): RollupCheck[] {
  return nodes.map(toRollupCheck).filter((check): check is RollupCheck => check !== null);
}

/**
 * GraphQLの`statusCheckRollup`ノードを`CheckRollup`へ写す。
 * ノードがnull（＝refは解決できたがチェックが1件も無い）の場合は空の一覧を返す。
 *
 * 運用自動化のcheck-runは数えない（#1799。`NON_CI_WORKFLOW_FILES`）。ただし**除いた結果が
 * 空になるなら、除く前をそのまま返す**——CIを持たず運用自動化のワークフローしか無い
 * リポジトリで、CI状態が一律「不明」になってPRが「実行中」のビューから出られなくなるため
 * （そこでの表示はこの変更の前と同じままになる）。
 */
function toCheckRollup(rollup: RollupNode | null | undefined): CheckRollup {
  if (!rollup) return { state: null, checks: [], mergeJudgement: MERGE_JUDGEMENT_UNKNOWN };

  const state = rollup.state ? rollup.state.toLowerCase() : null;
  if (rollup.contexts.totalCount > CONTEXTS_PAGE_SIZE) {
    // 1件ずつ見られないためGitHubの集約値（＝運用自動化も含む）へ縮退する。
    // 判定の進み具合も1件ずつ見ないと分からないため`unknown`にする（#1968）。
    return { state, checks: null, mergeJudgement: MERGE_JUDGEMENT_UNKNOWN };
  }
  const ciChecks = toRollupChecks(rollup.contexts.nodes.filter(isCiCheck));
  return {
    state,
    checks: ciChecks.length > 0 ? ciChecks : toRollupChecks(rollup.contexts.nodes),
    mergeJudgement: toMergeJudgement(rollup.contexts.nodes),
  };
}

/**
 * 指定ref（ブランチ名・タグ・SHA）のチェック集約を取得する。取得できなければnull
 * （呼び出し側で`unknown`へ縮退させる。CI状態が取れないだけでマージの導線を消さないため）。
 */
export async function fetchCheckRollup(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<CheckRollup | null> {
  const data = await githubGraphql<RollupResponse>(
    token,
    QUERY,
    { owner, name: repo, expression: ref },
    "statusCheckRollup",
    { permissionHint: "（Checks: Readの権限が要ります）" },
  ).catch((error: unknown) => {
    // 取れないと画面のCI状態が一律`unknown`になる。原因が分かるようログには残す。
    console.warn(`[fetchCheckRollup] ${owner}/${repo}@${ref} の取得に失敗しました:`, error);
    return null;
  });
  if (!data) return null;

  return toCheckRollup(data.repository?.object?.statusCheckRollup);
}

/** PR1件ぶんのチェック集約とコンフリクト有無（#1742） */
export type PullRequestRollup = {
  /** headコミットのチェック集約。取得できなければnull */
  rollup: CheckRollup | null;
  /**
   * コンフリクトの有無。`true`＝マージ可能・`false`＝コンフリクトあり・
   * `null`＝GitHubが判定中（`UNKNOWN`）または取得できなかった。
   */
  mergeable: boolean | null;
};

/** GraphQLの`MergeableState`をbooleanへ写す。`UNKNOWN`（判定中）はnullのまま扱う */
function toMergeable(state: string | null | undefined): boolean | null {
  if (state === "MERGEABLE") return true;
  if (state === "CONFLICTING") return false;
  return null;
}

/** まとめ取りの対象PR。同一installationのものだけを1本のクエリへ混ぜられる */
export type PullRequestRollupTarget = {
  owner: string;
  repo: string;
  number: number;
};

/** まとめ取りの結果を引くキー。`owner/repo#number` */
export function pullRequestRollupKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

/**
 * 1本のクエリへ並べるPRの上限（#1962）。
 *
 * ポイント消費の面では100件でも2ポイントで足りるが、PR1件につきチェックを最大100件
 * （`CONTEXTS_PAGE_SIZE`）返すため、応答の大きさで頭打ちになる。実運用のPR数（十数件）は
 * 1クエリに収まり、それを超えても件数に比例するのは応答の大きさだけで消費はほぼ一定になる。
 */
const PULL_REQUESTS_PER_QUERY = 25;

/**
 * 複数PRのチェック集約とコンフリクト有無を、**PR件数によらず少ない回数の**GraphQLで取得する（#1962）。
 *
 * 返すのは`pullRequestRollupKey()`をキーにしたMap。**取得できなかったPRはキーごと落とす**ので、
 * 呼び出し側は`?? { rollup: null, mergeable: null }`で未取得へ縮退させる（1件ずつ引いていた
 * ときと同じ扱い。CI状態やコンフリクトが取れないだけで一覧を落とさない）。
 *
 * `allowPartialData`を立てるのは、1PRが読めない（削除済み・権限が無いなど）ときにGraphQLが
 * そのエイリアスだけnullの`data`と`errors`を同時に返すため。既定のまま全体を失敗にすると、
 * 1件の欠けで同じクエリに乗った他のPRまで一斉に`unknown`になる。
 */
export async function fetchPullRequestRollups(
  targets: PullRequestRollupTarget[],
  token: string,
): Promise<Map<string, PullRequestRollup>> {
  const rollups = new Map<string, PullRequestRollup>();
  const chunks: PullRequestRollupTarget[][] = [];
  for (let start = 0; start < targets.length; start += PULL_REQUESTS_PER_QUERY) {
    chunks.push(targets.slice(start, start + PULL_REQUESTS_PER_QUERY));
  }

  await Promise.all(
    chunks.map(async (chunk) => {
      const variables: Record<string, unknown> = {};
      chunk.forEach((target, index) => {
        variables[`owner${index}`] = target.owner;
        variables[`name${index}`] = target.repo;
        variables[`number${index}`] = target.number;
      });

      const data = await githubGraphql<PullRequestRollupResponse>(
        token,
        buildPullRequestQuery(chunk.length),
        variables,
        "pullRequestStatusCheckRollup",
        {
          permissionHint: "（Pull requests: ReadとChecks: Readの権限が要ります）",
          allowPartialData: true,
        },
      ).catch((error: unknown) => {
        const labels = chunk.map((target) => pullRequestRollupKey(target.owner, target.repo, target.number));
        console.warn(`[fetchPullRequestRollups] ${labels.join(", ")} の取得に失敗しました:`, error);
        return null;
      });
      if (!data) return;

      chunk.forEach((target, index) => {
        const pullRequest = data[`p${index}`]?.pullRequest;
        if (!pullRequest) return;
        rollups.set(pullRequestRollupKey(target.owner, target.repo, target.number), {
          rollup: toCheckRollup(pullRequest.commits.nodes[0]?.commit?.statusCheckRollup),
          mergeable: toMergeable(pullRequest.mergeable),
        });
      });
    }),
  );

  return rollups;
}

/**
 * PR番号で、headコミットのチェック集約とコンフリクト有無を**1回のクエリで**取得する（#1742）。
 *
 * `mergeable`をCI状態と同じクエリに相乗りさせることで、RESTの単体取得を足さずにコンフリクトを
 * 出せるようにしている。PRが複数あるならまとめ取り（`fetchPullRequestRollups`）を使う。
 */
export async function fetchPullRequestRollup(
  owner: string,
  repo: string,
  number: number,
  token: string,
): Promise<PullRequestRollup> {
  const rollups = await fetchPullRequestRollups([{ owner, repo, number }], token);
  return rollups.get(pullRequestRollupKey(owner, repo, number)) ?? { rollup: null, mergeable: null };
}
