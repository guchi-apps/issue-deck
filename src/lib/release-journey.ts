import { releaseMergeTargetLabel, type ReleaseMergeTarget } from "@/lib/github/release-button-status";
import { isRcReleaseCandidateHeadRef, legacyReleaseVersionOf, rcSequenceOf } from "@/lib/release-branch";
import { resolvePullRequestReleaseVerification } from "@/lib/release-candidate-status";
import { isReleasePullRequest } from "@/lib/release-merge-gate";
import { resolveReleaseStageBadges, type ReleaseStageBadge } from "@/lib/release-stage-badges";
import type { BranchFlowDeployState } from "@/types/branch-flow";
import type { PullRequestReleaseCheckState, PullRequestSummary, ReleaseRcFacts } from "@/types/pull-request";

/**
 * 本番リリースの工程（#5076）。**ブランチ画面・PR：本番リリース一覧・本番PR詳細・要対応件数が使う唯一の工程定義。**
 *
 * #4930の6区切りバー（バンプ→CI→統合検証→全体レビュー→mainマージ→本番反映）と、#4814の公開段階
 * （承認→バンプ→main→本番反映→稼働確認→完了）を1本にまとめた。承認の前後で区切りが変わらないよう、
 * 区切りは固定の7つにする: 作成→RC検証→公開承認→最終検証→mainマージ→本番反映→稼働確認。
 *
 * - CI・統合検証・全体レビューは並行で進むので、1つの区切り（RC検証）の中に`checks`として並べる（直列に見せない）
 * - 修正Issue→修正PR→取込→再検証のループはRC検証の「修正中」として出す
 * - **根拠が取れない区切りは推測で済みにしない。** 記録を読めなかった区切りは「取得不能」にし、済みに数えない
 * - 旧方式の候補（`release-main/v*`）は公開承認・最終検証・稼働確認が無いので「対象外」にし、分母から外す
 * - 作り直し前の候補（取り消した直前の番号）は注記だけにし、この候補の進捗に数えない
 * - 公開可否はサーバーのゲート（`decideRcPublish`・`decideCompletionMerge`）が決める。ここは表示だけで、ゲートを緩めない
 */
export type JourneyStepKey = "create" | "verify" | "approve" | "final" | "merge" | "deploy" | "prod";

export type JourneyState =
  /** 済み */
  | "done"
  /** 自動で動いている */
  | "running"
  /** 自動で始まる・条件が揃うのを待っている */
  | "waiting"
  /** 人の操作待ち */
  | "user"
  /** 指摘を直している */
  | "fixing"
  /** 失敗・停止。直す必要がある */
  | "failed"
  /** 記録・状態を取得できない。推測しない */
  | "unknown"
  /** まだ */
  | "todo"
  /** 対象外（旧方式の候補） */
  | "skipped";

export type JourneyTone = Exclude<JourneyState, "done" | "todo" | "skipped">;
export type JourneyOwner = "auto" | "user" | "none";

export type JourneyStep = {
  key: JourneyStepKey;
  label: string;
  state: JourneyState;
  /** 動いている・止まっているときの文言（「統合検証を実行中」など）。済み・まだ・対象外ではnull */
  status: string | null;
  /** ホバー・読み上げ用の補足 */
  title: string | null;
  /** 済んだ時刻（ISO8601。承認時刻など）。分かるときだけ */
  at: string | null;
};

export type JourneyCheck = {
  key: "ci" | "integration" | "review";
  label: string;
  state: JourneyState;
  status: string | null;
  title: string | null;
};

export type ReleaseJourney = {
  /** 候補の名前（`RC-13`・旧方式は`v1.17.13`）。分からなければnull */
  candidateLabel: string | null;
  legacy: boolean;
  steps: JourneyStep[];
  /** 済みの区切りの数（取得不能・対象外は数えない） */
  done: number;
  /** 対象外を除いた区切りの数 */
  total: number;
  /** いまの工程の1つ。失敗＞人の番＞修正中＞取得不能＞実行中＞自動処理待ちの順で選ぶ。全て済み・まだならnull */
  headline: { key: JourneyStepKey; label: string; tone: JourneyTone; title: string | null } | null;
  /** いまの担当。人の番・失敗は`user`、自動で進むものは`auto`、取得不能・何も動いていないときは`none` */
  owner: JourneyOwner;
  /** 次に起きること・必要な操作（1文） */
  next: string | null;
  /** 見出しに選ばれなかった、動いている・止まっている工程の文言（並行して進むものを隠さない） */
  others: string[];
  /** RC検証の内訳（CI・統合検証・全体レビュー）。RC検証が済んだ後・出せないときはnull */
  checks: JourneyCheck[] | null;
  /** 作り直しの元の候補の注記。無ければnull */
  predecessor: string | null;
  /** 候補の記録の最終更新（ISO8601）。記録が無ければnull */
  updatedAt: string | null;
  /** 画面の取得に失敗して、古い情報を出している */
  stale: boolean;
};

export const JOURNEY_STEP_LABEL: Record<JourneyStepKey, string> = {
  create: "作成",
  verify: "RC検証",
  approve: "公開承認",
  final: "最終検証",
  merge: "mainマージ",
  deploy: "本番反映",
  prod: "稼働確認",
};

export const JOURNEY_STATE_TEXT: Record<JourneyState, string> = {
  done: "済み",
  running: "実行中",
  waiting: "自動処理待ち",
  user: "あなたの操作待ち",
  fixing: "修正中",
  failed: "失敗・停止",
  unknown: "取得不能",
  todo: "まだ",
  skipped: "対象外",
};

const ORDER: JourneyStepKey[] = ["create", "verify", "approve", "final", "merge", "deploy", "prod"];

const TONE_RANK: Record<JourneyTone, number> = { failed: 0, user: 1, fixing: 2, unknown: 3, running: 4, waiting: 5 };

/** 記録の段階の順。取り消しは進捗に使わない */
const PHASE_RANK: Record<string, number> = {
  creating: 0,
  review: 1,
  preparing: 2,
  awaiting_approval: 3,
  deploying: 4,
  verifying_production: 5,
  completed: 6,
};

type JourneyPullRequest = Pick<
  PullRequestSummary,
  "state" | "merged" | "baseRef" | "headRef" | "ciState" | "ciChecks" | "mergeJudgement" | "releaseChecks" | "iosPrecheck"
> & { draft?: boolean };

type Draft = { state: JourneyState; status: string | null; title: string | null; at?: string | null };

const draft = (state: JourneyState, status: string | null = null, title: string | null = null): Draft => ({ state, status, title });

/** 検証1区分の結果（実行中・開始待ちの文言は工程バッジが上書きする） */
function verificationDraft(
  name: string,
  state: PullRequestReleaseCheckState,
  options: { enforced: boolean; cleared: boolean; rerun: boolean; reasons: string[] },
): Draft {
  const reasons = options.reasons.join("\n") || null;
  switch (state) {
    case "passed":
      return draft("done");
    case "not_applicable":
      return draft("skipped");
    case "running":
      return draft("waiting", `${name}待ち`);
    case "needs_check":
      // 止める指摘が全件判断済み（#4814）なら人の判断は済んでいる
      if (options.cleared) return draft("done");
      // 要確認は人の判断の番。直す必要がある失敗（赤）とは分ける（#5076）
      return draft("user", `${name}要確認`, reasons);
    case "failed":
      return draft("failed", `${name}が失敗`, reasons);
    case "invalidated":
      if (options.rerun) return draft("waiting", `${name}の再検証待ち`);
      return draft("failed", `${name}の再検証が必要`, reasons);
    case "not_run":
      return options.enforced ? draft("failed", `${name}が未実施`) : draft("skipped");
  }
}

function deployDraft(deploy: BranchFlowDeployState): Draft {
  switch (deploy.kind) {
    case "success":
      return draft("done");
    case "running":
      return draft("running", deploy.autoRetried ? "自動で再デプロイ中" : "本番反映中");
    case "waiting":
      return draft("waiting", "デプロイ待ち");
    case "failure":
      return draft("failed", deploy.autoRetried ? "再デプロイも失敗" : "デプロイ失敗");
  }
}

/** 複数の検証を1つの区切りへ畳む。重い方（失敗＞人の番＞…）を取り、全て済み・対象外なら済み */
function aggregate(drafts: readonly Draft[]): JourneyState {
  const active = drafts.map((d) => d.state).filter((s): s is JourneyTone => s in TONE_RANK);
  if (active.length > 0) return active.sort((a, b) => TONE_RANK[a] - TONE_RANK[b])[0];
  if (drafts.some((d) => d.state === "todo")) return "todo";
  if (drafts.some((d) => d.state === "done")) return "done";
  return "skipped";
}

/** CI・統合検証・全体レビューの内訳。候補の現在headの結果だけを使う（`releaseChecks`は現在のbase/headで畳んである） */
function resolveChecks(candidate: JourneyPullRequest): JourneyCheck[] {
  // draftの候補（正式バンプ前の新方式の候補）はチェックを読まない（#4916）。CIは公開準備の最終検証で見るので、
  // 未取得を「取得不能」にせず対象外として出す
  const ci: Draft =
    candidate.draft === true && candidate.ciState === "unknown"
      ? draft("skipped", null, "正式バンプ前の候補のCIは、公開準備の最終検証で確かめます")
      : candidate.ciState === "success"
      ? draft("done")
      : candidate.ciState === "failure"
        ? draft("failed", "CIが失敗")
        : candidate.ciState === "pending"
          ? draft("running", "CI実行中")
          : draft("unknown", "CIの状態を取得できません");
  let integration: Draft = draft("todo");
  let review: Draft = draft("todo");

  if (!isReleasePullRequest(candidate)) {
    integration = draft("skipped");
    review = draft("skipped");
  } else {
    const checks = candidate.releaseChecks;
    if (!checks || checks.unavailable) {
      integration = draft("unknown", "統合検証を取得できません");
      review = draft("unknown", "全体レビューを取得できません");
    } else {
      const parts = new Set(checks.unavailableParts ?? []);
      const reasons = resolvePullRequestReleaseVerification(candidate).problem?.reasons ?? [];
      const enforced = checks.enforced !== false;
      const stage = checks.aiReviewStage;
      const fix = checks.fix ?? null;
      // 修正系列が対応中・停止の区分は、結果より修正の進み具合を優先する（#4972）。系列を読めなかったら推測しない（#5076）
      const fixDraft = (integrationKind: boolean, state: PullRequestReleaseCheckState, cleared: boolean): Draft | null => {
        if ((state !== "needs_check" && state !== "failed") || cleared) return null;
        if (parts.has("fix")) return draft("unknown", "修正の状況を取得できません");
        if (!fix || integrationKind !== (fix.sourceKind === "integration_failure")) return null;
        return fix.stalled
          ? draft("failed", "修正が停止中", `修正Issue #${fix.issueNumber}${fix.reason ? `: ${fix.reason}` : ""}`)
          : draft("fixing", `修正Issue #${fix.issueNumber}を対応中`, "修正がdevelopへ入ると候補へ取り込み、再検証します。操作は不要です");
      };
      integration =
        fixDraft(true, checks.integration, false) ??
        verificationDraft("統合検証", checks.integration, {
          enforced,
          cleared: false,
          rerun: checks.rerun?.integration ?? false,
          reasons: reasons.filter((reason) => reason.startsWith("統合検証")),
        });
      const cleared = stage?.kind === "needs_check" && stage.cleared === true;
      // 証跡を待つ・確認中・統合検証の完了待ちの段階（#4664・#4763）は、結果より段階を優先する
      review =
        stage?.kind === "integration_waiting" || stage?.kind === "reevaluating" || stage?.kind === "awaiting_integration"
          ? draft("waiting", "全体レビュー 統合検証待ち")
          : checks.aiReview === "needs_check" && parts.has("reviewStage")
            ? draft("unknown", "全体レビューの段階を取得できません")
            : (fixDraft(false, checks.aiReview, cleared) ??
              verificationDraft("全体レビュー", checks.aiReview, {
                enforced,
                cleared,
                rerun: checks.rerun?.aiReview ?? false,
                reasons: reasons.filter((reason) => reason.startsWith("全体レビュー")),
              }));
    }
  }

  const drafts: Record<JourneyCheck["key"], Draft> = { ci, integration, review };
  // 動いている検証の文言は工程バッジ（#4602）に揃える。失敗・人の番・修正中・取得不能は上書きしない
  applyBadges(drafts, resolveReleaseStageBadges({ bumpPullRequest: null, candidatePullRequest: { ...candidate, state: "open" } }));
  const label: Record<JourneyCheck["key"], string> = { ci: "CI", integration: "統合検証", review: "全体レビュー" };
  return (["ci", "integration", "review"] as const).map((key) => ({ key, label: label[key], ...drafts[key] }));
}

/** 工程バッジのkey（`release-stage-badges.ts`）から検証の区分へ */
const BADGE_CHECK: Record<string, JourneyCheck["key"]> = {
  "candidate-ci": "ci",
  "candidate-judgement": "ci",
  integration: "integration",
  "ios-precheck": "integration",
  "ai-review": "review",
};

function applyBadges(drafts: Record<JourneyCheck["key"], Draft>, badges: ReleaseStageBadge[]) {
  const byKey = new Map<JourneyCheck["key"], ReleaseStageBadge>();
  for (const badge of badges) {
    const key = BADGE_CHECK[badge.key];
    if (!key) continue;
    const current = byKey.get(key);
    if (!current || (!current.running && badge.running)) byKey.set(key, badge);
  }
  for (const [key, badge] of byKey) {
    // 済みのCIでも、自動マージ可否の判定が走っている間は判定中として出す（#2326）。失敗・人の番・修正中・取得不能は上書きしない
    if (drafts[key].state !== "running" && drafts[key].state !== "waiting" && drafts[key].state !== "todo" && drafts[key].state !== "done") continue;
    drafts[key] = draft(badge.running ? "running" : "waiting", badge.label, badge.title);
  }
}

/** バンプPRの区切り（旧方式。新方式の候補はバンプPRを使わない） */
function bumpDraft(bump: JourneyPullRequest, mergeTarget: ReleaseMergeTarget | null): Draft {
  if (bump.ciState === "failure") return draft("failed", "バージョンバンプのCI失敗");
  if (mergeTarget === "develop") return draft("user", releaseMergeTargetLabel("develop"));
  const badge = resolveReleaseStageBadges({ bumpPullRequest: { ...bump, state: "open" }, candidatePullRequest: null })[0];
  return badge ? draft(badge.running ? "running" : "waiting", badge.label, badge.title) : draft("running", "バージョンバンプ中");
}

/**
 * 工程を組み立てる。リリースが動いていない（開いたバンプPR・候補PR・マージ後の候補・進行中のデプロイが無い）ときはnull。
 *
 * @param detached 開いたPRに載らない候補の記録（作成直後でPRがまだ無い・mainへマージした後）。`loadDetachedRcFacts`
 * @param snapshot 画面の取得が失敗し、古い情報を出しているか
 */
export function resolveReleaseJourney({
  bumpPullRequest,
  candidatePullRequest,
  mergeTarget,
  deploy,
  detached = null,
  snapshot = null,
}: {
  bumpPullRequest: JourneyPullRequest | null;
  candidatePullRequest: JourneyPullRequest | null;
  /** 人のマージ待ち（`resolveReleaseMergeTarget`の結果） */
  mergeTarget: ReleaseMergeTarget | null;
  /** いちばん新しくmainへ入ったリリースのデプロイ状態 */
  deploy: BranchFlowDeployState | null;
  detached?: ReleaseRcFacts | null;
  snapshot?: { failed: boolean } | null;
}): ReleaseJourney | null {
  const bump = bumpPullRequest?.state === "open" ? bumpPullRequest : null;
  const candidate = candidatePullRequest?.state === "open" ? candidatePullRequest : null;
  const liveDeploy = deploy && !deploy.manual ? deploy : null;
  // 開いた候補があればその記録を、無ければPRに載らない候補（作成中・マージ後）の記録を使う
  const rc = candidate ? (candidate.releaseChecks?.rc ?? null) : detached;
  const isRc = candidate ? isRcReleaseCandidateHeadRef(candidate.headRef) : rc !== null;

  if (!bump && !candidate && !rc && !(liveDeploy && liveDeploy.kind !== "success")) return null;

  const legacy = !isRc;
  // 新方式なのに記録を読めない（DBの失敗・`unavailableParts`の`rc`・記録が無い）。承認以降の区切りは推測しない
  const rcUnknown = isRc && rc === null;
  const rank = rc ? (PHASE_RANK[rc.phase] ?? 1) : null;
  const approval = rc?.approval ?? null;
  const approvalValid = approval !== null && (approval.status === "active" || approval.status === "merging");

  const d: Record<JourneyStepKey, Draft> = {
    create: draft("todo"),
    verify: draft("todo"),
    approve: draft(legacy ? "skipped" : "todo"),
    final: draft(legacy ? "skipped" : "todo"),
    merge: draft("todo"),
    deploy: draft("todo"),
    prod: draft(legacy ? "skipped" : "todo"),
  };
  let checks: JourneyCheck[] | null = null;

  if (!bump && !candidate && !rc) {
    // マージ済みでデプロイだけが残っている旧方式の版。mainへ入った版はそこまでの工程を通っている
    for (const key of ["create", "verify", "merge"] as const) d[key] = draft("done");
    d.deploy = deployDraft(liveDeploy!);
  } else {
    // 作成
    if (bump) d.create = bumpDraft(bump, mergeTarget);
    else if (rc && (rc.phase === "creating" || rc.pendingRevision?.reason === "initial" || rc.pendingRevision?.reason === "migration")) {
      d.create = draft("running", `${rcLabelOf(rc)}を作成中（受付済み）`, "候補ブランチとPRを作っています。操作は不要です");
    } else d.create = draft("done");

    // RC検証（公開準備に入った後は、検証は最終検証の区切りで見る）
    if (rank !== null && rank >= 2) {
      d.verify = draft("done");
    } else if (candidate) {
      checks = resolveChecks(candidate);
      const state = aggregate(checks);
      const lead = checks.find((c) => c.state === state && c.status !== null) ?? null;
      d.verify = draft(state, lead?.status ?? null, lead?.title ?? null);
      if (rc?.pendingRevision && rc.pendingRevision.reason !== "initial" && rc.pendingRevision.reason !== "migration") {
        d.verify = draft("fixing", `修正を候補へ取り込み中（revision ${rc.pendingRevision.revision}）`, "取り込みが終わると再検証します。操作は不要です");
      }
    }

    if (!legacy) {
      const verified = d.verify.state === "done";
      // 公開承認
      if (rcUnknown) d.approve = draft("unknown", "承認の記録を取得できません");
      else if (rank !== null && rank >= 4) d.approve = { ...draft("done"), at: approval?.approvedAt ?? null };
      else if (approvalValid) {
        d.approve =
          candidate?.releaseChecks?.publishApproved === false && rc?.phase === "awaiting_approval"
            ? draft("waiting", "承認の範囲を確認中", "承認した候補と現在の候補が一致するかを確かめています")
            : { ...draft("done"), at: approval.approvedAt };
      } else if (approval && (approval.status === "invalidated" || approval.status === "revoked")) {
        const label = approval.status === "revoked" ? "自動公開を取り消し済み" : "公開承認が失効";
        d.approve = verified || (rank !== null && rank >= 2) ? draft("user", label, approval.invalidMessage) : draft("todo", `${label}・検証の後に再承認`, approval.invalidMessage);
      } else if (rc?.phase === "awaiting_approval" || (rc?.phase === "review" && verified)) {
        d.approve = draft("user", "公開承認待ち");
      }

      // 最終検証（正式バンプ→バンプ後の検証）
      if (rcUnknown) d.final = draft("unknown", "公開準備の記録を取得できません");
      else if (rank !== null && rank >= 3) d.final = draft("done");
      else if (rc?.phase === "preparing") {
        if (rc.finalization?.status !== "applied") d.final = draft("running", "正式バンプ中");
        else if (candidate) {
          const finalChecks = resolveChecks(candidate);
          const state = aggregate(finalChecks);
          const lead = finalChecks.find((c) => c.state === state && c.status !== null) ?? null;
          d.final =
            state === "done"
              ? draft("waiting", "公開準備の完了待ち")
              : draft(state === "user" ? "failed" : state, lead?.status ? `最終検証: ${lead.status}` : "最終検証中", lead?.title ?? null);
        } else d.final = draft("running", "最終検証中");
      } else if (rc?.phase === "review" && rc.finalization?.status === "failed" && approvalValid) {
        d.final = draft("failed", "公開準備が失敗", rc.finalization.failureReason);
      }
    }

    // mainマージ
    if (candidate?.merged || (rank !== null && rank >= 4)) d.merge = draft("done");
    else if (legacy) {
      if (mergeTarget === "main") d.merge = draft("user", releaseMergeTargetLabel("main"));
    } else if (rcUnknown) d.merge = draft("unknown", "自動公開の状態を取得できません");
    else if (approval?.status === "merging") d.merge = draft("running", "mainへマージ中");
    else if (approvalValid && rc?.phase === "awaiting_approval") {
      if (approval.progress === "stopped") d.merge = draft("failed", "自動公開が停止", approval.stopMessage);
      else if (approval.runStatus === "merging") {
        d.merge = draft(
          "waiting",
          approval.waitStalled ? "mainマージの条件確認が長引いています" : `mainマージの条件確認中${approval.waitMessage ? `（${approval.waitMessage}）` : ""}`,
          "公開承認済みです。条件が揃うと自動でmainへマージします。操作は不要です",
        );
      } else d.merge = draft("waiting", "自動でmainへマージ待ち", "公開承認済みです。条件が揃うと自動でmainへマージします。操作は不要です");
    } else if (approvalValid && rc?.phase === "preparing") d.merge = draft("waiting", "最終検証の合格待ち");

    // 本番反映・稼働確認
    if (rc && rank !== null) {
      if (rank === 4) d.deploy = rc.productionStopLabel ? draft("failed", `稼働確認が停止（${rc.productionStopLabel}）`) : liveDeploy ? deployDraft(liveDeploy) : draft("running", "本番反映中");
      else if (rank >= 5) d.deploy = draft("done");
      if (rank === 5) d.prod = rc.productionStopLabel ? draft("failed", `稼働確認が停止（${rc.productionStopLabel}）`) : draft("running", "稼働版を照合中");
      else if (rank >= 6) d.prod = draft("done");
    }
  }

  // 画面の取得に失敗している間は、動いている区切りを「取得不能」にする（古い進行を現在の進行に見せない）
  const stale = snapshot?.failed === true;
  if (stale) {
    for (const key of ORDER) {
      if (d[key].state === "running" || d[key].state === "waiting" || d[key].state === "fixing") d[key] = draft("unknown", "最新の状態を取得できません");
    }
  }

  const steps: JourneyStep[] = ORDER.map((key) => ({ key, label: JOURNEY_STEP_LABEL[key], at: null, ...d[key] }));
  const active = steps
    .filter((step): step is JourneyStep & { state: JourneyTone; status: string } => step.status !== null && step.state in TONE_RANK)
    // 同じ重さなら工程の順を保つ（sortは安定）
    .sort((a, b) => TONE_RANK[a.state] - TONE_RANK[b.state]);
  const [first, ...rest] = active;
  const headline = first ? { key: first.key, label: first.status, tone: first.state, title: first.title } : null;
  return {
    candidateLabel: rc ? rcLabelOf(rc) : candidate ? candidateLabelOf(candidate.headRef) : null,
    legacy,
    steps,
    done: steps.filter((step) => step.state === "done").length,
    total: steps.filter((step) => step.state !== "skipped").length,
    headline,
    owner: ownerOf(headline?.tone ?? null),
    next: headline ? nextOf(headline.key, headline.tone, legacy, approval?.status ?? null) : null,
    // RC検証の中で並行して進む・止まっている検証も隠さない（区切りの見出しに選ばれたもの以外）
    others: [
      ...rest.map((step) => step.status),
      ...(checks ?? [])
        .filter((c) => c.status !== null && c.state in TONE_RANK && c.status !== d.verify.status)
        .map((c) => c.status!),
    ],
    checks,
    predecessor:
      rc?.predecessor && rank !== null && rank <= 1
        ? `RC-${rc.predecessor.sequence}は取り消し済み${rc.predecessor.cancelReason ? `（${rc.predecessor.cancelReason}）` : ""}。この候補の進捗には数えません`
        : null,
    updatedAt: rc?.updatedAt ?? null,
    stale,
  };
}

function rcLabelOf(rc: ReleaseRcFacts): string {
  return `RC-${rc.sequence}`;
}

function candidateLabelOf(headRef: string): string | null {
  const sequence = rcSequenceOf(headRef);
  if (sequence !== null) return `RC-${sequence}`;
  return legacyReleaseVersionOf(headRef);
}

function ownerOf(tone: JourneyTone | null): JourneyOwner {
  if (tone === "user" || tone === "failed") return "user";
  if (tone === "running" || tone === "waiting" || tone === "fixing") return "auto";
  return "none";
}

/** いまの工程から、次に起きること・必要な操作を1文で */
function nextOf(key: JourneyStepKey, tone: JourneyTone, legacy: boolean, approvalStatus: string | null): string {
  if (tone === "unknown") return "通信が戻ると自動で取り直します。急ぐときは更新してください";
  const auto = tone === "running" || tone === "waiting" || tone === "fixing";
  switch (key) {
    case "create":
      if (tone === "user") return "バージョンバンプのPRをdevelopへマージしてください";
      if (tone === "failed") return "バージョンバンプのCIを確かめてください";
      return "操作は不要です。候補のPRができると検証が自動で始まります";
    case "verify":
      if (tone === "fixing") return "操作は不要です。修正がdevelopへ入ると候補へ取り込み、再検証します";
      if (auto) {
        return legacy
          ? "操作は不要です。検証が終わるとmainへマージできます"
          : "操作は不要です。CI・統合検証・全体レビューに合格すると公開承認があなたの番になります";
      }
      return "検証の結果を確かめて、修正を依頼するか再実行してください";
    case "approve":
      if (approvalStatus === "invalidated" || approvalStatus === "revoked") {
        return "現在の内容を確かめて承認し直すと、最終検証の合格後に自動で本番公開します";
      }
      if (auto) return "操作は不要です。承認の範囲を確かめています";
      return "内容を確かめて公開承認すると、正式バンプ・最終検証・mainマージ・本番反映・稼働確認まで自動で進みます";
    case "final":
      if (auto) return "操作は不要です。最終検証に合格すると自動でmainへマージします";
      return "公開準備・最終検証が止まった理由を確かめてください";
    case "merge":
      if (auto) return "操作は不要です。条件が揃うと自動でmainへマージします";
      if (tone === "failed") return "自動公開が止まった理由を確かめてください";
      return "本番PRをmainへマージしてください";
    case "deploy":
      if (auto) return "操作は不要です。デプロイが終わると稼働版を確かめます";
      return "デプロイのログを確かめて、復旧を依頼するか再デプロイしてください";
    case "prod":
      if (auto) return "操作は不要です。稼働版を確かめると完了します";
      return "稼働確認が止まった理由を確かめて、確認をやり直してください";
  }
}

/** 要対応件数（ヘッダー・タブ・通知）に数えるか。工程の担当が人のときだけ */
export function isReleaseJourneyNeedingUser(journey: ReleaseJourney | null): boolean {
  return journey?.owner === "user";
}

/**
 * PR1本（PR一覧・PR詳細）から出す工程。**新方式の候補（`release-rc/<番号>`）だけ**を対象にし、それ以外はnull
 * （旧方式の人のマージ待ちは従来の`deriveMergeHold`が出す）。ブランチ画面の畳んだ行と同じ候補の記録（`releaseChecks.rc`）を読む
 */
export function resolvePullRequestJourney(pullRequest: JourneyPullRequest): ReleaseJourney | null {
  if (!isRcReleaseCandidateHeadRef(pullRequest.headRef)) return null;
  return resolveReleaseJourney({ bumpPullRequest: null, candidatePullRequest: pullRequest, mergeTarget: null, deploy: null });
}
