import {
  ClipboardList,
  Code2,
  GitMerge,
  GitPullRequest,
  ListTodo,
  Rocket,
  type LucideIcon,
} from "lucide-react";

import type { IssueLabel } from "@/types/issue";

/**
 * Issueの進捗状態。GitHub Projects v2のStatusと、従来の進捗ラベル（01.planning〜09.main）の
 * 両方をこのキーへ正規化する。画面・判定ロジックはラベル名やStatus名を直接見ず、必ずここを通す。
 *
 * これが #991 の「実行環境に依存しない状態管理インターフェース」の実体である。
 * GitHub Actionsから更新されようとローカル実行から更新されようと、読む側は同じ入口を使う。
 */
export type ProgressStatusKey =
  | "ready"
  | "planning"
  | "implementation"
  | "develop-pr"
  | "develop"
  | "release"
  | "done";

export type ProgressStatusDef = {
  key: ProgressStatusKey;
  /** GitHub Projects v2 の Status フィールドの選択肢名 */
  projectStatus: string;
  /**
   * 対応する進捗ラベル名。`ready`だけは「進捗ラベルが付いていない状態」を指すためnull。
   * Projectへ未登録のIssueはこのラベルから状態を解決する。
   */
  labelName: string | null;
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
 * 進捗状態の遷移順（CLAUDE.md参照）。Status名・ラベル名・表示名の対応をここに一元化する。
 * 配列の順序がそのままカンバンとステップ表示の並び順になる。
 */
export const PROGRESS_STATUSES: readonly ProgressStatusDef[] = [
  {
    key: "ready",
    projectStatus: "Ready",
    labelName: null,
    label: "未着手",
    icon: ListTodo,
    active: false,
  },
  {
    key: "planning",
    projectStatus: "Planning",
    labelName: "01.planning",
    label: "計画検討中",
    icon: ClipboardList,
    active: true,
  },
  {
    key: "implementation",
    projectStatus: "Implementation",
    labelName: "02.wip",
    label: "実装中",
    icon: Code2,
    active: true,
  },
  {
    key: "develop-pr",
    projectStatus: "Develop PR",
    labelName: "03.d:marge",
    label: "developへマージ",
    icon: GitPullRequest,
    active: true,
  },
  {
    key: "develop",
    projectStatus: "Develop",
    labelName: "05.develop",
    label: "develop反映済",
    icon: GitMerge,
    active: false,
  },
  {
    key: "release",
    projectStatus: "Release",
    labelName: "07.m:marge",
    label: "本番へマージ",
    icon: GitPullRequest,
    active: true,
  },
  {
    key: "done",
    projectStatus: "Done",
    labelName: "09.main",
    label: "本番反映済",
    icon: Rocket,
    active: false,
  },
];

/** 進捗ラベルを持つ状態のみ（`ready`を除く）。ラベル起点の判定に使う */
export const LABELED_PROGRESS_STATUSES: readonly (ProgressStatusDef & { labelName: string })[] =
  PROGRESS_STATUSES.filter(
    (status): status is ProgressStatusDef & { labelName: string } => status.labelName !== null,
  );

/** 進捗状態の判定に必要な最小限のIssue。表示用のIssue型とDBの行のどちらからでも渡せる */
export type ProgressSource = {
  projectStatus: string | null;
  labels: IssueLabel[];
};

export function getProgressStatusDef(key: ProgressStatusKey): ProgressStatusDef {
  // PROGRESS_STATUSESは全キーを網羅しているため、findは必ず値を返す
  return PROGRESS_STATUSES.find((status) => status.key === key) ?? PROGRESS_STATUSES[0];
}

/** Project StatusフィールドのStatus名から状態を引く。未知の名前ならnull */
export function matchProjectStatus(projectStatus: string): ProgressStatusKey | null {
  return PROGRESS_STATUSES.find((status) => status.projectStatus === projectStatus)?.key ?? null;
}

/**
 * 進捗ラベルから状態を引く。該当ラベルが無ければ「未着手」とみなして`ready`を返す。
 *
 * 遷移の過渡期に新旧のラベルが同時に付くことがあるため、PROGRESS_STATUSESの並び順で
 * 最初に一致したものを採用する（＝より手前の状態を優先する）。これは移行前の
 * getWorkflowStepIndexの挙動を引き継いだもの。
 */
export function matchProgressLabels(labels: IssueLabel[]): ProgressStatusKey {
  const names = new Set(labels.map((label) => label.name));
  return LABELED_PROGRESS_STATUSES.find((status) => names.has(status.labelName))?.key ?? "ready";
}

/**
 * Issueの進捗状態を解決する。**Project Statusがあればそれを優先し、無ければ進捗ラベルへ
 * フォールバックする。**
 *
 * 二重運用期（#991 Phase 1）は両方が維持されるため通常は一致するが、食い違った場合は
 * Statusを正とする。Projectから外れたIssueは`projectStatus`がnullに戻るため、
 * 自動的にラベル起点の判定へ戻る。これが巻き戻しの経路にもなっている。
 *
 * Statusに未知の名前が入っていた場合（Project側で選択肢を増やした等）もラベルへ
 * フォールバックする。画面が空になるより既存の挙動を保つほうが安全なため。
 */
export function resolveProgressStatus(issue: ProgressSource): ProgressStatusKey {
  if (issue.projectStatus) {
    const fromStatus = matchProjectStatus(issue.projectStatus);
    if (fromStatus) return fromStatus;
  }
  return matchProgressLabels(issue.labels);
}

/** 進捗状態の遷移順における位置。比較に使う */
export function getProgressStatusIndex(key: ProgressStatusKey): number {
  return PROGRESS_STATUSES.findIndex((status) => status.key === key);
}

/**
 * GitHub Actionsの実行が進行し得る段階かどうか。実行状況のポーリング対象を絞り込むのに使う。
 *
 * 遷移の過渡期に新旧のラベルが同時に付くことがあるため、現在ステップ（先頭一致）ではなく
 * 「進行し得るラベルがひとつでも付いているか」で判定する。Project Statusは単一値のため
 * この過渡期の問題は起きず、Statusがある場合はその状態のactiveをそのまま見る。
 */
export function hasActiveProgress(issue: ProgressSource): boolean {
  if (issue.projectStatus) {
    const fromStatus = matchProjectStatus(issue.projectStatus);
    if (fromStatus) return getProgressStatusDef(fromStatus).active;
  }
  const names = new Set(issue.labels.map((label) => label.name));
  return LABELED_PROGRESS_STATUSES.some((status) => status.active && names.has(status.labelName));
}
