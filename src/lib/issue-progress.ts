import {
  Archive,
  ClipboardList,
  Code2,
  GitMerge,
  GitPullRequest,
  ListTodo,
  Rocket,
  type LucideIcon,
} from "lucide-react";

/**
 * Issueの進捗状態。**GitHub Projects v2のStatusが唯一の正**で、このキーへ正規化する。
 * 画面・判定ロジックはStatus名を直接見ず、必ずここを通す。
 *
 * これが #991 の「実行環境に依存しない状態管理インターフェース」の実体である。
 * GitHub Actionsから更新されようとローカル実行から更新されようと、読む側は同じ入口を使う。
 *
 * **進捗ラベル（`01.planning`〜`09.main`）は #991 Phase 5（#1010）で廃止した。**
 * Phase 1〜4の間はラベルが安全網（Statusが壊れてもラベルから状態を復元できる）として
 * 二重に維持されていたが、Statusを唯一の正にする段階でその保険を外した。
 * `00.check-user`・`21.plan-required`等の条件系ラベルは引き続きラベルのまま残る
 * （Status = 今どこにいるか、Label = どんな性質・条件があるか）。
 */
export type ProgressStatusKey =
  | "ready"
  | "planning"
  | "implementation"
  | "develop-pr"
  | "develop"
  | "release"
  | "done"
  | "closed";

export type ProgressStatusDef = {
  key: ProgressStatusKey;
  /** GitHub Projects v2 の Status フィールドの選択肢名 */
  projectStatus: string;
  /** 画面表示用の短い日本語ラベル */
  label: string;
  /** ステップ表示用のアイコン（円の中身。未完了・現在ステップ時のみ使う。完了済みはCheckで統一） */
  icon: LucideIcon;
  /**
   * この段階でGitHub Actions（実装・レビューエージェント）の実行が進行し得るかどうか。
   * `develop`（developマージ完了）・`done`（mainマージ完了）はマージ後の定常状態で
   * 実行は走らないため、一覧の実行状況ポーリング対象から外してGitHub APIの消費を抑える。
   * `ready`（未着手）もまだ何も動いていないため対象外。
   */
  active: boolean;
};

/**
 * 進捗状態の遷移順（CLAUDE.md参照）。Status名・表示名の対応をここに一元化する。
 * 配列の順序がそのままカンバンとステップ表示の並び順になる。
 *
 * **`closed`（対応終了）だけは`ready` → `done`の本流から外れた終端**で、PRを経ずに終わった
 * Issueのclose時に入る（#1856。`CLOSE_TERMINAL_SOURCE_STATUSES`）。`done`（本番反映済）と
 * 分けているのは、`done`が「mainへマージ完了」を意味し、リリース関連のビューと一括遷移が
 * その意味に依存しているため。並びとしてはカンバンの最右になるよう末尾へ置く。
 */
export const PROGRESS_STATUSES: readonly ProgressStatusDef[] = [
  {
    key: "ready",
    projectStatus: "Ready",
    label: "未着手",
    icon: ListTodo,
    active: false,
  },
  {
    key: "planning",
    projectStatus: "Planning",
    label: "計画検討中",
    icon: ClipboardList,
    active: true,
  },
  {
    key: "implementation",
    projectStatus: "Implementation",
    label: "実装中",
    icon: Code2,
    active: true,
  },
  {
    key: "develop-pr",
    projectStatus: "Develop PR",
    label: "developへマージ",
    icon: GitPullRequest,
    active: true,
  },
  {
    key: "develop",
    projectStatus: "Develop",
    label: "develop反映済",
    icon: GitMerge,
    active: false,
  },
  {
    key: "release",
    projectStatus: "Release",
    label: "本番へマージ",
    icon: GitPullRequest,
    active: true,
  },
  {
    key: "done",
    projectStatus: "Done",
    label: "本番反映済",
    icon: Rocket,
    active: false,
  },
  {
    key: "closed",
    projectStatus: "Closed",
    label: "対応終了",
    icon: Archive,
    active: false,
  },
];

/**
 * `ready`（未着手）と`closed`（対応終了）を除く、遷移順に並んだ6状態。
 * ステップ表示（`WORKFLOW_STEPS`）の母集団になる。
 *
 * **`closed`を含めない。** ステップ表示は`Planning` → `Done`の一本道を進捗として見せるもので、
 * そこへ本流から外れた終端を足すと、通常のIssueの表示まで「実装中（2/7）」のように
 * 分母が増え、到達し得ない段が1つ常に残る。`closed`のIssueはステップ表示自体を出さない
 * （`getWorkflowStepIndex`がnullを返す）。途中のどこまで進んでいたかは、対応が終わった
 * Issueにとって意味を持たないため。
 */
export const ADVANCED_PROGRESS_STATUSES: readonly ProgressStatusDef[] = PROGRESS_STATUSES.filter(
  (status) => status.key !== "ready" && status.key !== "closed",
);

/**
 * Issueがcloseされたとき、終端（`closed`）へ送る対象になる進捗（#1856）。
 *
 * **PRを作らずに終わるIssueは例外ではない。** 他ブランチ・他PRへ反映して完了した場合、
 * 「すでに実装済み・対応不要」と判断して止まった場合、成果が別リポジトリのPRや
 * `71.manual-step` Issueの起票だった場合、重複・見送りでcloseした場合がこれにあたる。
 * `develop-pr`以降を報告するのは`reusable-issue-labels.yml`のPRオープン・PRマージ・sweepだけで、
 * どれも対象Issueをブランチ名`issue-<番号>`から特定するため、**そのブランチをheadとするPRが
 * 存在しない限り誰も報告せず**、Statusが実装中の列に残り続ける。closeは上のどの経路でも必ず
 * 起きる唯一確実な完了のシグナルなので、これを終端への遷移として扱う。
 *
 * **`develop`・`release`は含めない。** これらはdevelopまで入って本番へ出ていない変更を
 * 抱えており、終端へ送ると「終わった」という嘘になる（closedなIssueがリリースの一括遷移から
 * 漏れる問題は#1348で別途扱っている）。**`ready`も含めない。** 未着手のまま終わっただけで、
 * 取り残されているわけではない。
 */
export const CLOSE_TERMINAL_SOURCE_STATUSES: readonly ProgressStatusKey[] = [
  "planning",
  "implementation",
  "develop-pr",
];

/**
 * 進捗状態の判定に必要な最小限のIssue。表示用のIssue型とDBの行のどちらからでも渡せる。
 *
 * Phase 5でラベルへのフォールバックが無くなったため、必要なのは`projectStatus`だけになった。
 */
export type ProgressSource = {
  projectStatus: string | null;
};

export function getProgressStatusDef(key: ProgressStatusKey): ProgressStatusDef {
  // PROGRESS_STATUSESは全キーを網羅しているため、findは必ず値を返す
  return PROGRESS_STATUSES.find((status) => status.key === key) ?? PROGRESS_STATUSES[0];
}

/**
 * 外部から受け取った文字列を`ProgressStatusKey`として検証する。
 * 進捗報告API（`POST /api/progress`）・状態問い合わせAPI（`GET /api/progress`）が
 * ワークフローからの入力を受けるのに使う。
 */
export function parseProgressStatusKey(value: unknown): ProgressStatusKey | null {
  if (typeof value !== "string") return null;
  return PROGRESS_STATUSES.find((status) => status.key === value)?.key ?? null;
}

/** Project StatusフィールドのStatus名から状態を引く。未知の名前ならnull */
export function matchProjectStatus(projectStatus: string): ProgressStatusKey | null {
  return PROGRESS_STATUSES.find((status) => status.projectStatus === projectStatus)?.key ?? null;
}

/**
 * Issueの進捗状態を解決する。**Project Statusが唯一の判断材料**で、
 * Statusが無いIssue（Projectへ未登録・Projectから外された）は`ready`（未着手）とみなす。
 *
 * Statusに未知の名前が入っていた場合（Project側で選択肢を増やした等）も`ready`になる。
 * Phase 4までは進捗ラベルへフォールバックしていたが、Phase 5（#1010）でラベルを廃止した
 * ため復元元が無い。**Projectへ載っていないリポジトリのIssueは一律「未着手」に見える。**
 * 盤面へ載せる条件は`hasClaudeWorkflow`（docs/progress-status-architecture.md）。
 */
export function resolveProgressStatus(issue: ProgressSource): ProgressStatusKey {
  if (!issue.projectStatus) return "ready";
  return matchProjectStatus(issue.projectStatus) ?? "ready";
}

/**
 * リリース関連の表示で使う、進捗＋Issueの開閉。
 * `state`は`@/types/issue`の`IssueState`と同じ形だが、この層は表示用のIssue型にも
 * DBの行にも依存しないでおきたいためリテラルで受ける。
 */
export type ReleaseIssueSource = ProgressSource & { state: "open" | "closed" };

/**
 * develop→mainのリリースで今回mainへ反映される（＝`Develop`にいる）Issueかどうか。
 *
 * **closedなIssueを含めない。** リリース時に`Done`へ一括遷移させる対象を引く
 * `queryIssuesByProgressStatus`（`GET /api/progress?status=...`）はopenなIssueしか
 * 返さないため、closedのままStatusが`Develop`に残っているIssueを画面だけが数え続けると、
 * 実際には決して反映されないIssueが「今回反映する内容」に永久に並ぶ（#1348）。
 */
export function isNextReleaseIssue(issue: ReleaseIssueSource): boolean {
  return issue.state === "open" && resolveProgressStatus(issue) === "develop";
}

/**
 * 本番反映待ち（`Develop`・`Release`）のIssueかどうか。件数バッジに使う。
 * closedを除く理由は`isNextReleaseIssue`と同じ（#1348）。
 */
export function isReleasePendingIssue(issue: ReleaseIssueSource): boolean {
  if (issue.state !== "open") return false;
  const status = resolveProgressStatus(issue);
  return status === "develop" || status === "release";
}

/** 進捗状態の遷移順における位置。比較に使う */
export function getProgressStatusIndex(key: ProgressStatusKey): number {
  return PROGRESS_STATUSES.findIndex((status) => status.key === key);
}

/**
 * GitHub Actionsの実行が進行し得る段階かどうか。実行状況のポーリング対象を絞り込むのに使う。
 */
export function hasActiveProgress(issue: ProgressSource): boolean {
  return getProgressStatusDef(resolveProgressStatus(issue)).active;
}
