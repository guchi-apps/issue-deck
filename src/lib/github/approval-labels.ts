import type { IssueStateFilter } from "@/hooks/use-issue-filters";
import { commentAgentRole, resolveCommentSource } from "@/lib/github/comment-source";
import { resolveProgressStatus, type ProgressSource, type ProgressStatusKey } from "@/lib/issue-progress";
import type { Issue, IssueComment, IssueLabel, LabelNavViewId } from "@/types/issue";

/** ユーザーの確認・指示が必要であることを示すラベル */
export const CHECK_USER_LABEL = "00.check-user";

/** 実装前の計画承認待ちであることを示すラベル */
export const PLAN_REQUIRED_LABEL = "21.plan-required";

/**
 * エージェントが代行できないユーザー自身の手作業が必要であることを示すラベル（#1240）。
 *
 * `00.check-user`と併用しないのが運用上の取り決め。併用すると承認・修正ボタン
 * （`isApprovalPending`）が出てしまい、押しても実行する@claudeコメントの宛先が無い。
 * また00番台のラベルは一覧カードの表示から除外される（`isAttentionLabel`）ため、
 * 盤面で手作業Issueだと見分けられなくなる。運用ルールは
 * docs/multi-agent/labels.md「デプロイ後などに残るユーザーの手作業はIssueとして起票する」。
 */
export const MANUAL_STEP_LABEL = "71.manual-step";

/** ユーザー自身の手作業を待っているIssueかどうか（#1240・#1280） */
export function isManualStepIssue(labels: IssueLabel[]): boolean {
  return labels.some((label) => label.name === MANUAL_STEP_LABEL);
}

/**
 * 手作業Issueに「完了してクローズ」の導線を出すかどうか（#1280）。
 *
 * 手作業Issueは`Develop`→`Done`のリリースフローに乗らないため、実行したユーザーが
 * closeするまでopenのまま残り続ける。closeが「…」メニューの奥にしか無いと、
 * 実行し終えた後に何をすればよいかが画面から読み取れない。
 */
export function canCompleteManualStep(issue: Pick<Issue, "state" | "labels">): boolean {
  return issue.state === "open" && isManualStepIssue(issue.labels);
}

/**
 * `00.check-user`が付いている理由（#1490）。**`00.check-user`とのANDでしか読まない。**
 *
 * `00.check-user`は「人の対応が要る」ことしか表さないため、画面は理由を周辺情報から推測して
 * いた（`isMergeApprovalPending`が進捗Statusに加えて直近botコメントの発信元まで見ているのが
 * その典型で、#728の巻き戻りを埋めるための後付け）。理由を`01.`帯の補助ラベルで併用する。
 *
 * | 理由 | ユーザーがやること | エージェントの状態 |
 * | --- | --- | --- |
 * | `plan` | 計画を承認する／修正を依頼する | 待機 |
 * | `input` | 質問・確認に答える | 待機 |
 * | `merge` | PRをマージする | 待機 |
 * | `blocked` | 続け方を指示する | 停止 |
 * | `answered` | 回答を読む | 待っていない |
 *
 * 設計の全文は docs/multi-agent/labels.md「理由を表す`01.check-*`ラベル」。
 */
export type CheckUserReason = "plan" | "input" | "merge" | "blocked" | "answered";

/**
 * ラベル判定に必要なのは名前だけ。DBから引いた`{ name }`だけの行（`pull-request-check-user.ts`）
 * もそのまま渡せるようにする。
 */
type LabelNames = readonly Pick<IssueLabel, "name">[];

/** 理由ごとのラベル名。`01.`帯は`00.check-user`に併用する補助ラベルで、単独では意味を持たない */
export const CHECK_USER_REASON_LABELS: Record<CheckUserReason, string> = {
  plan: "01.check-plan",
  input: "01.check-input",
  merge: "01.check-merge",
  blocked: "01.check-blocked",
  answered: "01.check-answered",
};

/**
 * 質問への回答のみが完了した状態であることを示すラベルの**旧名**（#887）。
 * `01.check-answered`へのリネーム中は、**読む側だけが新旧どちらの名前も受け付ける**（#1490）。
 * リネームは`gh label edit "00.qa-answered" --name "01.check-answered"`で、付いているIssueから
 * 外れずにその場で名前が変わる。
 */
export const LEGACY_QA_ANSWERED_LABEL = "00.qa-answered";

/**
 * 理由は常に1枚だが、付け替えの取りこぼしなどで複数付いた場合に読む順を固定する。
 * 「人が次に何をすればよいか」が曖昧にならないよう、行動が重いものから並べる。
 */
const CHECK_USER_REASON_PRIORITY: readonly CheckUserReason[] = [
  "plan",
  "merge",
  "blocked",
  "input",
  "answered",
];

/** 一覧カードのバッジなど、短く添えるときの文言 */
export const CHECK_USER_REASON_TEXT: Record<CheckUserReason, string> = {
  plan: "計画の承認",
  input: "質問への回答",
  merge: "PRのマージ",
  blocked: "続け方の指示",
  answered: "回答の確認",
};

/** 承認カードの見出し */
export const CHECK_USER_REASON_HEADING: Record<CheckUserReason, string> = {
  plan: "計画の承認が必要です",
  input: "質問への回答が必要です",
  merge: "Pull Requestのマージが必要です",
  blocked: "続け方の指示が必要です",
  answered: "回答を確認してください",
};

/** `00.check-user`の理由を表すラベルか（旧名`00.qa-answered`を含む） */
export function isCheckUserReasonLabel(name: string): boolean {
  if (name === LEGACY_QA_ANSWERED_LABEL) return true;
  return Object.values(CHECK_USER_REASON_LABELS).includes(name);
}

function hasCheckUserReasonLabel(names: Set<string>, reason: CheckUserReason): boolean {
  if (names.has(CHECK_USER_REASON_LABELS[reason])) return true;
  // リネーム移行中は旧名も「回答済み」として読む
  return reason === "answered" && names.has(LEGACY_QA_ANSWERED_LABEL);
}

/**
 * `00.check-user`が付いている理由を読む（#1490）。
 *
 * **`00.check-user`が無ければ必ずnullを返す**（理由ラベルとのANDでしか読まない）。外し忘れた
 * 理由ラベルが単独で残っていても、画面が誤った表示をしないようにするため。
 * 理由ラベルが配られていないリポジトリでも常にnullになり、呼び出し側は従来どおりの推測へ
 * フォールバックする。
 */
export function checkUserReason(labels: LabelNames): CheckUserReason | null {
  if (!isApprovalPending(labels)) return null;
  const names = new Set(labels.map((label) => label.name));
  return CHECK_USER_REASON_PRIORITY.find((reason) => hasCheckUserReasonLabel(names, reason)) ?? null;
}

/**
 * 理由を`reason`の1枚に付け替えたあとの、あるべきラベル名の集合を返す（#1490）。
 *
 * **理由は常に1枚**なので、既に付いている他の理由ラベル（旧名を含む）は落とす。返すのは
 * 「あるべき集合」であって全置換の指示ではない。`updateIssue`の`labels`は全置換で、その間に
 * 他の経路が付けたラベルを巻き込むため、呼び出し側はこれと現状の差分からadd/removeを組み立てる
 * （`src/lib/dispatch/check-user-labels.ts`）。
 */
export function labelsWithCheckUserReason(labels: IssueLabel[], reason: CheckUserReason): string[] {
  const kept = labels
    .map((label) => label.name)
    .filter((name) => name !== CHECK_USER_LABEL && !isCheckUserReasonLabel(name));
  return [...kept, CHECK_USER_LABEL, CHECK_USER_REASON_LABELS[reason]];
}

/**
 * claude-issue-dispatch.ymlのissue_commentトリガーを起動させないためのマーカー（#566）。
 * ラベル操作（PATCH /api/issues）が個人OAuthトークン化されたことで、`00.check-user`除去
 * イベント（issues.unlabeled）のsender.typeがUserになり、第2層Bot判定（コメント側で
 * 使うissue-deck-source系マーカーとは別物）を素通りするようになった。21.plan-required保持時
 * （承認でブランチ作成前の計画やり直し・実装開始に入る分岐）は、ラベル除去イベント単独で
 * MODE判定に必要な情報が揃うため、後続のコメント投稿（issue_commentイベント）が同じ操作を
 * 二重にトリガーしてしまう。このマーカーを付けたコメントはワークフロー起動条件から除外し、
 * ラベル除去イベント側のみを正規のトリガーとする。マーカーはワークフロー起動条件の除外にのみ
 * 作用し、コメント自体は通常どおり投稿される（Issue画面上の記録、Claude側の`gh issue view
 * --comments`での可読性は維持する）。
 */
const NO_TRIGGER_MARKER = "<!-- issue-deck:no-trigger -->";

function isPlanApprovalPending(labels: IssueLabel[]): boolean {
  return labels.some((label) => label.name === PLAN_REQUIRED_LABEL);
}

function withNoTriggerMarkerIfPlanPending(labels: IssueLabel[], body: string): string {
  return isPlanApprovalPending(labels) ? `${body}\n${NO_TRIGGER_MARKER}` : body;
}

export function isApprovalPending(labels: LabelNames): boolean {
  return labels.some((label) => label.name === CHECK_USER_LABEL);
}

/**
 * 00.check-userが「実装・計画の承認待ち」ではなく「質問への回答のみを確認してほしいだけ」の
 * 状態かどうかを判定する。21.plan-requiredが付いている間は計画そのものへの承認待ちが実体として
 * 残っているため、isPlanApprovalPendingを優先しfalseを返す。
 *
 * 判定は`checkUserReason`（`01.check-answered`と旧名`00.qa-answered`のどちらでも成立する）を
 * 通す（#1490）。
 */
export function isQaOnlyApprovalPending(labels: IssueLabel[]): boolean {
  if (isPlanApprovalPending(labels)) return false;
  return checkUserReason(labels) === "answered";
}

export type LabelFilterPreset = {
  key: LabelNavViewId;
  label: string;
  /**
   * このいずれかのラベルが付いているIssueに絞り込む（OR一致）。
   * **進捗はラベルではなくStatusで表すため（#991 Phase 5）、ここに指定するのは
   * 条件系ラベル（`00.check-user`）だけ**になった。進捗による絞り込みは`statuses`を使う。
   */
  labels: string[];
  /**
   * このいずれかのラベルが付いているIssueを除外する（labelsとは逆にAND条件）。
   * 「未着手」のように、特定ラベルの不在で定義するプリセット向け。
   */
  excludeLabels?: string[];
  /**
   * このいずれかの進捗状態にあるIssueに絞り込む（OR一致）。
   * 判定は`resolveProgressStatus`（＝Project Status）を通す。
   */
  statuses?: ProgressStatusKey[];
  /**
   * 質問Issue（`isAskRepoQuestionIssue`＝タイトルが`[質問] `/`質問: `で始まる）だけに
   * 絞り込む（#1514）。質問であることはラベルにもStatusにも現れないため、専用の条件にしている。
   */
  questionOnly?: boolean;
  /**
   * 質問Issueを除外する（#1514）。質問Issueは実装フローに乗らないまま`Ready`に居続けるため、
   * 除外しないと「次にどれへ着手させるか」を選ぶビューへ恒久的に溜まる。
   */
  excludeQuestions?: boolean;
  /**
   * プリセット選択時に適用するstateフィルター（省略時はstateを変更しない）。
   * `Done`（本番反映済）はマージ完了と同時にissueをcloseする運用（CLAUDE.md）のため、
   * 「直近main反映済み」プリセットはデフォルトのopen絞り込みのままだと該当issueが
   * 出てこない。
   */
  state?: IssueStateFilter;
};

/**
 * 定型の絞り込みプリセット。
 * サイドメニュー・スマホのクイックビューでは、これをビュー（viewクエリ）として扱う
 * （@/lib/nav-views の labelNavViews）。
 *
 * **進捗による絞り込みはProject Statusを見る（#991 Phase 5・#1010）。** Phase 1では
 * 影響範囲の広さからラベル配列マッチのまま据え置いていたが、進捗ラベルの廃止にあわせて移した。
 * 「ユーザーの確認待ち」だけはラベル（`00.check-user`）が引き続き判断材料で、これは
 * 進捗（今どこにいるか）ではなく条件（どんな性質があるか）を表すため。
 */
export const LABEL_FILTER_PRESETS: readonly LabelFilterPreset[] = [
  { key: "check-user", label: "ユーザーの確認待ち", labels: [CHECK_USER_LABEL] },
  { key: "manual-step", label: "手作業待ち", labels: [MANUAL_STEP_LABEL] },
  // 「リポジトリに質問する」で作られた質問Issueの置き場（#1514）。回答を読み終えて承認を押すと
  // `00.check-user`が外れ、Statusは`Ready`のままなので、専用ビューが無いと「未着手」へ戻る。
  // 完了の合図はcloseなので、openな質問Issueが全部ここに並ぶ（既定のstate=openのまま）。
  { key: "question", label: "質問", labels: [], questionOnly: true },
  {
    key: "not-started",
    label: "未着手",
    labels: [],
    // 手作業Issueはエージェントが着手することが無く、ユーザーが実行するまで`Ready`に居続ける。
    // 除外しないと「次にどれへ着手させるか」を選ぶビューへ恒久的に溜まるため、確認待ちと
    // 同じく専用ビュー（manual-step）側に寄せる（#1240）。質問Issueも同じ理由で除外する（#1514）。
    excludeLabels: [CHECK_USER_LABEL, MANUAL_STEP_LABEL],
    excludeQuestions: true,
    statuses: ["ready"],
  },
  {
    key: "in-progress",
    label: "実行中",
    labels: [],
    // 回答待ちの質問Issueは`qaAnswerPendingAt`でここへ来ていたが（#978）、質問ビューへ寄せる
    // （#1514）。通常の実装Issueへ`@claude 質問:`した場合の回答待ちは引き続きここに出る。
    excludeQuestions: true,
    statuses: ["planning", "implementation", "develop-pr"],
  },
  {
    key: "release-pending",
    label: "本番反映待ち",
    labels: [],
    statuses: ["develop", "release"],
  },
  {
    key: "recently-merged",
    label: "直近本番に反映した",
    labels: [],
    statuses: ["done"],
    state: "all",
  },
];

/**
 * 現在選択中のラベル集合が、指定したプリセットとちょうど一致しているかを判定する。
 * ラベルを持たないプリセット（進捗Statusで定義されるもの・「未着手」など）はlabels配列
 * （選択中ラベルのトグル）では表現できないため、常に非アクティブとして扱う。
 */
export function isLabelFilterPresetActive(labels: string[], preset: LabelFilterPreset): boolean {
  if (preset.labels.length === 0) return false;
  return labels.length === preset.labels.length && preset.labels.every((name) => labels.includes(name));
}

export type LabelFilterPresetSelection = {
  labels: string[];
  state?: IssueStateFilter;
};

/**
 * プリセットボタン押下時に適用すべきラベル・stateフィルターを返す。
 * 選択中なら解除し、プリセットがstateを指定していれば併せてデフォルト（open）へ戻す。
 */
export function resolveLabelFilterPresetSelection(
  preset: LabelFilterPreset,
  isActive: boolean,
): LabelFilterPresetSelection {
  if (isActive) {
    return preset.state ? { labels: [], state: "open" } : { labels: [] };
  }
  return preset.state ? { labels: preset.labels, state: preset.state } : { labels: preset.labels };
}

/**
 * 00.check-userかつ進捗が`Develop PR`/`Release`の場合、または直近のbotコメントが
 * claude-review-develop（レビューボット）発の場合、PRマージ待ち（GitHub上で人間が直接マージ
 * する必要があり、@claudeコメントでの再開対象ではない）と判定する。
 *
 * 進捗だけでは判定できないケースがある（#728）。「additional」モードの再開時、実装は
 * 着手直後に`Develop PR`→`Implementation`へ戻るが、それより後に発生する追加コミットの
 * pushをトリガーとしたclaude-review-develop.ymlのレビュー（00.check-user付与）は、
 * PR作成・`Develop PR`への復帰を終える前に完了しうる。この間の進捗は一時的に
 * `Implementation`のままなため、進捗だけを見ると「PRマージ待ち」と判定できず、承認ボタンを
 * 押すと本来のPRマージ待ち文言ではなく「実装を進めてください」という汎用の確認文言が
 * 投稿されてしまう。直近のbotコメントの発信元（レビューボットかどうか）を見ることで、
 * 進捗の一時的な状態に依存せず判定する。
 *
 * **理由ラベル（`01.check-*`）が読めるならそれだけで判定し、上の推測は使わない**（#1490）。
 * 例外は`answered`で、これは「エージェントは待っていない・回答を読むだけ」を表すだけであり、
 * PRのマージ待ちと同時に成立しうる（質問に答えた時点でPRは開いたまま）。理由が`answered`の
 * ときと、理由ラベルが配られていないリポジトリでは従来どおり推測へフォールバックする。
 */
export function isMergeApprovalPending(
  issue: ProgressSource & { labels: IssueLabel[] },
  comments: Pick<IssueComment, "body" | "author">[] = [],
): boolean {
  if (!isApprovalPending(issue.labels)) return false;
  const reason = checkUserReason(issue.labels);
  if (reason === "merge") return true;
  if (reason !== null && reason !== "answered") return false;
  if (isLatestSourcedCommentFromReviewer(comments)) return true;
  const status = resolveProgressStatus(issue);
  return status === "develop-pr" || status === "release";
}

/** コメント配列を末尾から走査し、発信元を特定できる直近のbotコメントがレビューボット発かどうかを判定する */
function isLatestSourcedCommentFromReviewer(
  comments: Pick<IssueComment, "body" | "author">[],
): boolean {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    const resolved = resolveCommentSource(comment, comment.author.login);
    if (!resolved) continue;
    return commentAgentRole(resolved) === "reviewer";
  }
  return false;
}

/**
 * 承認時に外すラベル名の配列を返す（00.check-userに加え、計画承認待ちなら21.plan-requiredも外す。
 * 理由ラベル（`01.check-*`と旧名`00.qa-answered`）は00.check-userとの併用でのみ意味を持つため、
 * 常にあわせて外す）
 */
export function labelsAfterApproval(labels: IssueLabel[]): string[] {
  return labels
    .map((label) => label.name)
    .filter(
      (name) =>
        name !== CHECK_USER_LABEL && name !== PLAN_REQUIRED_LABEL && !isCheckUserReasonLabel(name),
    );
}

/**
 * 却下（UI上のボタン表記は「修正」）時に外すラベル名の配列を返す（00.check-userと理由ラベル
 * （`01.check-*`・旧名`00.qa-answered`）を外す。21.plan-requiredは計画の再提示が必要なため残す）
 */
export function labelsAfterRejection(labels: IssueLabel[]): string[] {
  return labels
    .map((label) => label.name)
    .filter((name) => name !== CHECK_USER_LABEL && !isCheckUserReasonLabel(name));
}

/**
 * 承認ボタン押下時、ラベル更新に続けて投稿する定型コメント本文
 * （claude-issue-dispatch.ymlの@claudeトリガーに反応する）。
 *
 * ラベル更新はissue-deckのGitHub App（インストールトークン）で行うためGitHub上は
 * issue-deck[bot]の操作として記録され、issues.unlabeledイベントだけでは実際に
 * 承認操作をした人間を特定できず、ワークフロー側の自己ループ防止ロジックにより
 * 実装が再開されない（#173）。GitHub Appの人力アプリ操作であっても
 * 個人のGitHubアカウントで投稿されるコメント（POST /api/issues/comments、
 * user.githubAccessToken使用）を承認ラベル更新の直後に送ることで、
 * issue_commentトリガー経由で実装を確実に再開させる。
 *
 * 21.plan-required（または理由ラベル`01.check-plan`）による計画承認待ちの場合、
 * `01.check-answered`（旧名`00.qa-answered`）による「質問への回答のみ確認待ち」の
 * 場合、それ以外（画面確認待ち・フォールバックエラー通知など）の汎用確認待ちの場合の3通りで
 * 文言を出し分ける（優先順位はこの順、#887）。質問のみ回答済みの場合は、実装承認待ちではないため
 * 「実装を進めてください」を含まない文言にする。
 * また21.plan-required保持時は、ラベル除去イベントとの二重発火を防ぐためNO_TRIGGER_MARKER
 * を付与する（#566、詳細は同定数のコメントを参照）。
 *
 * textが指定された場合は`@claude <text>`の後に上記の定型文を補足として続ける（#688）。
 * 指定が無ければ従来どおり定型文のみを返す。
 */
export function approveCommentBody(labels: IssueLabel[], text?: string): string {
  const followUp = isPlanApprovalPending(labels) || checkUserReason(labels) === "plan"
    ? "計画を承認しました。実装を進めてください。"
    : isQaOnlyApprovalPending(labels)
      ? "回答を確認しました。"
      : "確認しました。実装を進めてください。";
  const trimmed = text?.trim();
  const body = trimmed ? `@claude ${trimmed}\n\n${followUp}` : `@claude ${followUp}`;
  return withNoTriggerMarkerIfPlanPending(labels, body);
}

/**
 * 却下（UI上のボタン表記は「修正」）時に、ラベル更新に続けて投稿する定型コメント本文。
 * reasonが空でなければ`@claude <reason>`、空なら汎用の見直し依頼文言にする。
 * approveCommentBodyと同様、21.plan-required保持時（計画のやり直し）はラベル除去イベントとの
 * 二重発火を防ぐためNO_TRIGGER_MARKERを付与する（#566）。
 */
export function rejectCommentBody(labels: IssueLabel[], reason: string): string {
  const trimmed = reason.trim();
  const body = trimmed ? `@claude ${trimmed}` : "@claude 内容を見直してください。";
  return withNoTriggerMarkerIfPlanPending(labels, body);
}

/**
 * フォールバック通知（計画コメント投稿・実装結果報告のいずれも確認できなかった場合の通知）に対して、
 * 「続きを実装・調査を依頼」ボタン押下時に投稿する定型コメント本文。
 *
 * ボタン押下時はこのコメント投稿に先立ち、labelsAfterRejection（00.check-userのみ除去、
 * 21.plan-requiredは残す）でラベルを更新する（#330）。00.check-userを残したままだと、
 * 投稿直後は直近コメントがこの継続依頼コメントになるためisFallbackNoticeComment判定が
 * 外れ、UI上フォールバック専用のボタンではなく通常の承認・修正・取り下げボタンに戻って
 * 表示されてしまう不具合があった。ラベル更新はissue-deckのGitHub App経由でissues.unlabeled
 * イベントとして記録されるが、claude-issue-dispatch.yml側の自己ループ防止ロジックにより
 * Botの操作は無視されるため実装の再開はトリガーされず、続けて投稿する本コメント
 * （issue_commentイベント）経由でのみ再開される。21.plan-requiredを残すため、
 * 計画フェーズ・分割フェーズでのフォールバック（ブランチ未作成）に対する継続依頼でも
 * 従来どおり計画の再試行として扱われる。
 */
export function requestContinuationCommentBody(): string {
  return "@claude 続きを実装・調査してください。";
}

/**
 * PRマージ待ち画面（isMergeApprovalPending）の「修正を依頼する」ボタン押下時に投稿する
 * コメント本文。ボタン押下時はこのコメント投稿に先立ち、handleReject等と同様
 * labelsAfterRejection（00.check-userのみ除去、21.plan-requiredは残す）でラベルを
 * 更新する。修正コミットが積まれている間はユーザー確認待ちではないため、他の操作と
 * 揃えて00.check-userを外す（#409）。claude-issue-dispatch.ymlは対応issueのブランチが
 * 既にありdevelopへのPRがOPENであればmode=additionalとして扱うため、このコメント投稿
 * により既存PRへの追加コミットが行われる（#376）。再度ユーザー確認が必要な状態になった
 * 場合は、追加コミットのpushがclaude-review-develop.ymlを再発火させ、そちらのrisk-check/
 * claude-reviewが必要に応じて00.check-userを再付与する。
 */
export function requestPrFixCommentBody(reason: string): string {
  const trimmed = reason.trim();
  return trimmed ? `@claude ${trimmed}` : "@claude PRの内容を見直して修正してください。";
}

/**
 * 承認・修正依頼・継続依頼・PR修正依頼の各操作は「ラベル更新→コメント投稿」の順で行うが、
 * コメント投稿（個人のGitHub OAuthトークン使用）はトークン失効時に失敗しうる（#421）。
 * その場合ラベル更新のみが反映され「ラベル上は操作済みに見えるが実装は再開されない」不整合
 * 状態になるため、呼び出し側はラベルをロールバックしたうえで、次に取るべき行動が分かるよう
 * 元のエラーメッセージにこの案内を追記する。
 */
export function withRollbackNotice(baseMessage: string): string {
  return `${baseMessage} ラベルの変更は取り消しました。GitHubからログアウトし、再度ログインしてからもう一度お試しください。`;
}

/**
 * ラベルのロールバック（updateIssueの再実行）自体も失敗した場合の案内。手動確認を促す。
 */
export function withRollbackFailureNotice(baseMessage: string): string {
  return `${baseMessage} ラベルの復元にも失敗しました。手動でご確認ください。`;
}
