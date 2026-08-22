/**
 * 他リポジトリが参照している共有ワークフローのタグ（`@workflows/vN`）を読み取り、
 * issue-deck 側の最新タグと突き合わせるための純粋関数群（#985）。
 *
 * **なぜ要るか。** 共有ワークフローは `uses:` のタグ固定で配っているため、issue-deck 側を
 * 直しても各リポジトリの caller を上げるまで反映されない。上げ忘れても何も起きないので
 * 気づけない。実際 v10 は car-care だけ、v11・v12 は10リポジトリへ手作業で配った。
 *
 * GitHub API へのアクセスは呼び出し側（`src/lib/github/workflow-tags.ts`）が担い、
 * ここは文字列解析と比較だけを持つ。
 */

/** caller が参照している共有ワークフローのタグ（1ファイルぶん） */
export type WorkflowTagRef = {
  /** ワークフローのファイル名（例: `claude-issue-dispatch.yml`） */
  file: string;
  /** `uses:` が指すタグ（例: `workflows/v12`） */
  uses: string;
  /**
   * `prompts-ref` の値。指定が無いファイルでは `null`。
   *
   * **`uses` と同じ値でなければならない。** 片方だけ上げると、新しいワークフローで古い
   * プロンプトが使われる（#1158 で `${PACKAGE_MANAGER}` を足した際、prompts-ref が古いと
   * 未展開のまま渡る状態になった）。
   */
  promptsRef: string | null;
};

/** タグ名（`workflows/v12`）から版数（12）を取り出す。形式が違えば null */
export function parseWorkflowTagVersion(tag: string): number | null {
  const match = /^workflows\/v(\d+)$/.exec(tag);
  if (!match) return null;
  return Number(match[1]);
}

/** `workflows/vN` 形式のタグ一覧から最新（版数が最大のもの）を返す */
export function latestWorkflowTag(tags: string[]): string | null {
  let latest: { tag: string; version: number } | null = null;
  for (const tag of tags) {
    const version = parseWorkflowTagVersion(tag);
    if (version === null) continue;
    if (!latest || version > latest.version) latest = { tag, version };
  }
  return latest?.tag ?? null;
}

/**
 * caller のワークフローYAMLから、参照しているタグを読み取る。
 *
 * YAMLとして構文解析せず正規表現で拾う。`uses:` の値はコメント行にも現れる
 * （どのタグを指すべきかの説明として書かれている）ため、**行頭が `uses:` のものだけ**を
 * 対象にする。
 */
export function extractWorkflowTagRef(file: string, source: string): WorkflowTagRef | null {
  const uses = /^\s*uses:\s*\S+@(workflows\/v\d+)\s*$/m.exec(source);
  if (!uses) return null;

  const promptsRef = /^\s*prompts-ref:\s*(workflows\/v\d+)\s*$/m.exec(source);
  return {
    file,
    uses: uses[1] as string,
    promptsRef: (promptsRef?.[1] as string | undefined) ?? null,
  };
}

/** 更新PR（配布ワークフローが作ったもの）のうち画面に出すぶん */
export type WorkflowTagPullRequest = {
  number: number;
  url: string;
};

/** リポジトリ1件ぶんの判定結果 */
export type WorkflowTagStatus = {
  fullName: string;
  refs: WorkflowTagRef[];
  /** 最新タグより古い参照があるか */
  outdated: boolean;
  /** `uses` と `prompts-ref` が食い違っている参照があるか */
  mismatched: boolean;
  /**
   * 最新タグへ上げる更新PRのうち、まだopenのもの。無ければ`null`。
   *
   * **これが有る間は配布の対象から外す**（`propagationTargets`）。参照タグが上がるのは
   * PRがマージされた後なので、それまでは「古い」と判定されたままになり、続けて押すと
   * 同じリポジトリへ2本目のPRが作られる（#1602）。
   */
  updatePullRequest: WorkflowTagPullRequest | null;
  /**
   * 置かれていないcaller（#1948・#1475）。**そのリポジトリで意味を持つものだけ**が入る
   * （判定は`missingRepairWorkflows`）。空なら不足なし。
   */
  missingRepairWorkflows: string[];
  /**
   * 不足しているcallerを配布するPRのうち、まだopenのもの。無ければ`null`。
   *
   * **これが有る間は配布の対象から外す**（`repairPropagationTargets`）。callerが増えるのは
   * PRがマージされた後なので、それまでは「不足」と判定されたままになる。
   */
  repairPullRequest: WorkflowTagPullRequest | null;
};

/**
 * リポジトリの参照状況を判定する。
 *
 * **「古い」と「不一致」は別種の異常として区別する。** 古いだけなら単に改善が届いて
 * いないだけだが、不一致は**新しいワークフローが古いプロンプトで動く**という、
 * どちらのバージョンとも違う組み合わせになる。
 */
export function evaluateWorkflowTags(
  fullName: string,
  refs: WorkflowTagRef[],
  latest: string | null,
  updatePullRequest: WorkflowTagPullRequest | null = null,
  /**
   * 不足しているcallerの配布状況（#1948・#1475）。参照タグとは独立した軸のため、
   * 位置引数を増やさず1つのオブジェクトにまとめて受ける。
   */
  repair: {
    /** `.github/workflows/`直下のファイル名一覧 */
    files?: string[];
    pullRequest?: WorkflowTagPullRequest | null;
  } = {},
): WorkflowTagStatus {
  const latestVersion = latest === null ? null : parseWorkflowTagVersion(latest);

  const outdated = refs.some((ref) => {
    if (latestVersion === null) return false;
    const version = parseWorkflowTagVersion(ref.uses);
    return version !== null && version < latestVersion;
  });

  const mismatched = refs.some((ref) => ref.promptsRef !== null && ref.promptsRef !== ref.uses);

  return {
    fullName,
    refs,
    outdated,
    mismatched,
    updatePullRequest,
    missingRepairWorkflows: missingRepairWorkflows(repair.files ?? []),
    repairPullRequest: repair.pullRequest ?? null,
  };
}

/**
 * 配布ワークフローが作る更新PRのタイトル。
 *
 * **`.github/scripts/propagate-workflow-tag.sh`の`gh pr create --title`と同じ文面**にする。
 * 更新PRかどうかの判定はこのタイトルだけを頼りにしており（ブランチ名は自動マージの有無で
 * 変わる）、片方だけ変えると画面から更新PRが見えなくなる。
 */
export function workflowTagPullRequestTitle(tag: string): string {
  return `共有ワークフローの参照を${tag}へ上げる`;
}

/**
 * openなPRの中から、最新タグへの更新PRを1件探す。
 *
 * **古いタグ（`v18`へ上げるPRが残ったまま最新が`v19`になった場合）は対象外**にする。
 * それを「更新PR作成済み」と扱うと、最新への更新が永久に始まらない。
 */
export function findWorkflowTagPullRequest(
  pullRequests: { number: number; title: string; url: string }[],
  latest: string | null,
): WorkflowTagPullRequest | null {
  if (!latest) return null;

  const title = workflowTagPullRequestTitle(latest);
  const found = pullRequests.find((pullRequest) => pullRequest.title.trim() === title);
  return found ? { number: found.number, url: found.url } : null;
}

/**
 * いま配布すべきリポジトリ。**更新PRが既にopenのものは含めない**（#1602）。
 *
 * 画面のボタンの件数とワークフローへ渡す対象は、必ずこの関数で揃える。ずれると
 * 「14件へ作成」と出しながら実際には別の件数へ配る、という状態になる。
 */
export function propagationTargets(statuses: WorkflowTagStatus[]): WorkflowTagStatus[] {
  return statuses.filter(
    (status) => (status.outdated || status.mismatched) && status.updatePullRequest === null,
  );
}

/** 一覧のグループ分け。更新が必要 → 更新PRの確認待ち → 最新 の順に出す */
export type WorkflowTagGroup = "outdated" | "pull-request" | "latest";

export function workflowTagGroup(status: WorkflowTagStatus): WorkflowTagGroup {
  if (!status.outdated && !status.mismatched) return "latest";
  return status.updatePullRequest ? "pull-request" : "outdated";
}

/** `workflows/v19` を `v19` にする。一覧では版数だけで足りる */
export function shortWorkflowTag(tag: string): string {
  return tag.replace(/^workflows\//, "");
}

/** 配布ワークフローの実行（run）のうち画面に出すぶん */
export type PropagationRun = {
  /** `queued` | `in_progress` | `completed` など */
  status: string;
  /** `success` | `failure` | `cancelled` | null（未完了時） */
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
};

/** 配布ワークフローが動いている最中か。**画面を開き直しても効く連続押下の防止はこれで判定する** */
export function isPropagationRunning(run: PropagationRun | null): boolean {
  return run !== null && run.status !== "completed";
}

export type PropagationStartDecision =
  | { allowed: true }
  | { allowed: false; reason: "running"; message: string };

/**
 * いま配布を起こしてよいか（#1602）。
 *
 * **起動は数秒で返るのに、PRが出来上がるまでは数分かかる。** その間ボタンが押せると、
 * 同じリポジトリへ2本目のIssueとPRが作られる。判定の形は`canStartSecretsSync`
 * （`src/lib/secrets-sync.ts`）に揃えている。
 */
export function canStartPropagation(run: PropagationRun | null): PropagationStartDecision {
  if (!isPropagationRunning(run)) return { allowed: true };

  return {
    allowed: false,
    reason: "running",
    message: "更新の実行中です。完了してからもう一度実行してください。",
  };
}

/**
 * 配る caller 1件ぶんの定義（#1948）。
 *
 * **配る条件をファイルの実在で表す。** 例えば`claude-pr-repair.yml`が受け持つのは
 * バンプPR・develop→mainのリリースPRなので、リリースフローを持たないリポジトリへ配っても
 * 起動する対象が存在しない。「そのリポジトリで意味を持つか」を`requires`のファイルの
 * 有無で判定する。
 */
export type RepairWorkflowSpec = {
  /** 配るcallerのファイル名 */
  file: string;
  /** これを持つリポジトリにだけ配る */
  requires: string;
  /** 画面に出す説明 */
  label: string;
};

/**
 * 配布対象のワークフロー（#1948・#1475）。
 *
 * 自動修復の3種は、どれが何を直すかを
 * [docs/multi-agent/auto-repair.md](../../docs/multi-agent/auto-repair.md)に書いてある。
 * `claude-ci-fix.yml`・`claude-conflict-resolve.yml`は対応Issueを持つ`issue-<番号>`のPRが、
 * `claude-pr-repair.yml`はIssueを持たないPR（バンプPR・リリースPR）が対象。
 *
 * `claude-review-develop.yml`は自動修復ではないが、**置かれていないと機能が丸ごと働かない**
 * 点が同じなので同じ配布経路に載せる（#1475）。develop向けPRを「自動マージしてよい」
 * 「ユーザーのマージが必要」のどちらかへ確定させるのはこのcallerだけで、無いリポジトリでは
 * 低リスクPRも含めて全て手動マージになる（#1470）。
 *
 * `deploy-retry.yml`（#2134）も同じ理由で載せる。本番デプロイが一時的な失敗で落ちたときに
 * 拾うのはこのcallerだけで、無いリポジトリでは人が「本番へ再デプロイ」を押しに来るまで本番が
 * 古いままになる。**ただし`vps`・`subpc`へ配るかは配布のときに判断すること**——あの2つは
 * 実機のインフラ設定を流すリポジトリで、Issue #2134でも自動再実行に含めるかを別扱いにしている。
 */
export const REPAIR_WORKFLOW_SPECS: readonly RepairWorkflowSpec[] = [
  {
    file: "claude-conflict-resolve.yml",
    requires: "claude-issue-dispatch.yml",
    label: "develop向けPRのコンフリクト解消",
  },
  {
    file: "claude-ci-fix.yml",
    requires: "claude-issue-dispatch.yml",
    label: "develop向けPRのCI失敗修正",
  },
  {
    file: "claude-pr-repair.yml",
    requires: "release-develop-to-main.yml",
    label: "バンプPR・リリースPRの修復",
  },
  {
    file: "claude-review-develop.yml",
    requires: "claude-issue-dispatch.yml",
    label: "develop向けPRの自動マージ判定",
  },
  {
    file: "deploy-retry.yml",
    requires: "deploy.yml",
    label: "本番デプロイの一時的な失敗の再実行",
  },
];

/** ファイル名から画面に出す説明を引く。未知のファイルはそのまま返す */
export function repairWorkflowLabel(file: string): string {
  return REPAIR_WORKFLOW_SPECS.find((spec) => spec.file === file)?.label ?? file;
}

/**
 * `.github/workflows/`のファイル名一覧から、**あるべきなのに無い**callerを返す。
 *
 * 判定にファイルの中身は見ない。issue-deck自身はローカルパス参照（`uses: ./`）で、
 * 他リポジトリはタグ固定と方式が違うが、**どちらも「そのファイルが置いてあるか」だけで
 * 起動できるかが決まる**ため（`workflow_dispatch`の受け口はファイルの実在で解決される）。
 */
export function missingRepairWorkflows(files: string[]): string[] {
  const present = new Set(files);
  return REPAIR_WORKFLOW_SPECS.filter(
    (spec) => present.has(spec.requires) && !present.has(spec.file),
  ).map((spec) => spec.file);
}

/**
 * 配布ワークフローが作るPRのタイトル（#1948）。
 *
 * **`.github/scripts/propagate-repair-workflows.sh`の`gh pr create --title`と同じ文面**に
 * する。配布済みかどうかの判定はこのタイトルだけを頼りにしており、片方だけ変えると
 * 同じリポジトリへ2本目のPRが作られる（タグ配布の`workflowTagPullRequestTitle`と同じ理由）。
 *
 * 配る対象が自動修復だけではなくなったため「自動修復ワークフローを追加する」から
 * 改称した（#1475。改称の時点でこのタイトルのopenなPRは1件も無かった）。
 */
export function repairWorkflowPullRequestTitle(): string {
  return "不足しているワークフローを追加する";
}

/** openなPRの中から、callerの配布PRを1件探す */
export function findRepairWorkflowPullRequest(
  pullRequests: { number: number; title: string; url: string }[],
): WorkflowTagPullRequest | null {
  const title = repairWorkflowPullRequestTitle();
  const found = pullRequests.find((pullRequest) => pullRequest.title.trim() === title);
  return found ? { number: found.number, url: found.url } : null;
}

/**
 * いまcallerを配るべきリポジトリ。**配布PRが既にopenのものは含めない。**
 *
 * 画面のボタンの件数とワークフローへ渡す対象は、必ずこの関数で揃える
 * （`propagationTargets`と同じ理由）。
 */
export function repairPropagationTargets(statuses: WorkflowTagStatus[]): WorkflowTagStatus[] {
  return statuses.filter(
    (status) => status.missingRepairWorkflows.length > 0 && status.repairPullRequest === null,
  );
}

/**
 * いま不足しているcallerの配布を起こしてよいか（#1948）。
 *
 * 判定の形も理由もタグ配布（`canStartPropagation`）と同じ。**実行の正はGitHub側のrun**で、
 * runを別に持つぶんだけ関数を分けてある（タグ配布が動いている間も、こちらは押せてよい）。
 */
export function canStartRepairPropagation(run: PropagationRun | null): PropagationStartDecision {
  if (!isPropagationRunning(run)) return { allowed: true };

  return {
    allowed: false,
    reason: "running",
    message: "配布の実行中です。完了してからもう一度実行してください。",
  };
}
