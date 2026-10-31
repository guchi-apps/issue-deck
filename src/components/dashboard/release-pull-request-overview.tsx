"use client";

import { useState } from "react";
import { isRcReleaseCandidateHeadRef, isReleaseCandidateHeadRef } from "@/lib/release-branch";
import { useReleaseRc } from "@/hooks/use-release-rc";
import { ReleaseRcVerificationEvidence } from "@/components/dashboard/release-rc-evidence";
import { ReleaseRcFinalizePanel } from "@/components/dashboard/release-rc-finalize";
import { ReleaseRcCancel } from "@/components/dashboard/release-rc-cancel";
import { ReleaseDevelopSyncNotice } from "@/components/dashboard/release-develop-sync";
import { ReleaseRcIdentity, ReleaseRcLegacyNotice, ReleaseRcRevisionHistory } from "@/components/dashboard/release-rc-identity";

import { decidePublishForPullRequest, ReleasePublishAction } from "@/components/dashboard/release-publish-action";
import { JourneyMoreActions, ReleaseJourneyNow, ReleaseJourneySteps } from "@/components/dashboard/release-journey";
import {
  ReleaseContentsList,
  ReleaseFixHistory,
  ReleaseFixSummary,
  useReleaseFixOverview,
} from "@/components/dashboard/release-fix-panel";
import { ReleaseReviewSections } from "@/components/dashboard/release-review-sections";
import { ReleaseAutoProceedPanel, shouldShowAutoProceed } from "@/components/dashboard/release-auto-proceed-panel";
import { useNow } from "@/hooks/use-now";
import { useReferenceNavigation } from "@/hooks/use-reference-navigation";
import { useReleaseCandidates } from "@/hooks/use-release-candidates";
import { useReleaseChanges } from "@/hooks/use-release-changes";
import { useReleaseVerification } from "@/hooks/use-release-verification";
import { buildMergeChecks, cellsFromSummary, type MergeCheckItem, type MergeCheckTone } from "@/lib/pull-request-merge-checks";
import { buildReleaseCheckCells, describeCandidateTarget } from "@/lib/release-candidate-checks";
import { resolvePullRequestJourney } from "@/lib/release-journey";
import { cn } from "@/lib/utils";
import type { PullRequestSummary } from "@/types/pull-request";

/**
 * 本番PR詳細の上部に出すか（#4428）。開いている固定済みのリリース候補（旧方式`release-main/…`・新方式`release-rc/…`。#4495）だけ。
 * マージ済み・クローズ済み・旧世代（head=develop）は従来の詳細のまま
 */
export function isOpenReleaseCandidate(pullRequest: PullRequestSummary): boolean {
  return (
    pullRequest.kind === "release" &&
    !pullRequest.merged &&
    pullRequest.state === "open" &&
    isReleaseCandidateHeadRef(pullRequest.headRef)
  );
}

const TONE_TEXT: Record<MergeCheckTone, string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
  run: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/**
 * 本番PR詳細の「現在候補の検証」（4チェック（競合・全体・統合・iOS）。#4366の判定をそのまま使う）。
 *
 * 一覧・通常PR詳細の並び（`PullRequestMergeChecks`）とは別に、**利用できる幅で列数を変える**。
 * スマホ・狭い詳細ペインは2列×3段、中くらいは3列×2段、十分な幅では6列（コンテナ幅で判定するので、
 * PCで詳細ペインが狭いときも詰め込まない）。各項目を押すと理由・対象・根拠を開く。
 * 共通結果（全体・統合・iOS）は**このリリースPR自身**を候補として読み、別の候補の結果で代用しない。
 */
function ReleaseCandidateChecks({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const source = useReleaseCandidates(pullRequest.repositoryFullName);
  const now = useNow(5_000, source.status === "loaded" && source.candidates.length > 0);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const release = buildReleaseCheckCells({
    source,
    pullRequestNumber: pullRequest.number,
    selectedNumber: pullRequest.number,
    nowMs: now ?? 0,
  });
  // リリースPR自身にはCI・コードレビューが無く常に未実施になるため出さない（#4859）
  const checks = buildMergeChecks({ ...cellsFromSummary(pullRequest), release }).filter((c) => c.key !== "ci" && c.key !== "code");
  const open = checks.find((check) => check.key === openKey) ?? null;
  // 自分自身が候補として見つからないとき、別の候補（古い候補など）の結果を現在値として出さない
  const candidateIsSelf = release.candidate?.number === pullRequest.number;

  return (
    <div className="@container" data-testid="release-candidate-checks">
      <div className="grid grid-cols-2 gap-1.5 @3xl:grid-cols-4">
        {checks.map((check) => (
          <CheckButton
            key={check.key}
            check={candidateIsSelf || !check.common ? check : unavailable(check)}
            expanded={openKey === check.key}
            onToggle={() => setOpenKey(openKey === check.key ? null : check.key)}
          />
        ))}
      </div>
      {release.candidate && candidateIsSelf && (
        <p className="mt-1 text-xs text-muted-foreground">共通結果の対象: {describeCandidateTarget(release.candidate)}</p>
      )}
      {open && <CheckDetail check={candidateIsSelf || !open.common ? open : unavailable(open)} />}
    </div>
  );
}

/** 候補の取得結果にこのPRが無いときの共通結果。成功・失敗のどちらとも扱わない */
function unavailable(check: MergeCheckItem): MergeCheckItem {
  return {
    ...check,
    mark: "–",
    state: "取得中",
    tone: "muted",
    reason: "このリリースPRの検証結果をまだ取得できていません。別の候補の結果は使いません",
    evidence: null,
  };
}

function CheckButton({ check, expanded, onToggle }: { check: MergeCheckItem; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`${check.fullName}: ${check.state}`}
      onClick={onToggle}
      className={cn(
        "flex min-h-12 min-w-0 flex-col items-start justify-center rounded-md border px-2.5 py-1 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        expanded && "bg-muted",
      )}
    >
      <span className="text-sm leading-5 text-muted-foreground">{check.shortLabel.replace("〔共通〕", "")}</span>
      <span className={cn("text-sm leading-5 font-bold", TONE_TEXT[check.tone])}>
        <span aria-hidden="true">{check.mark}</span> {check.state}
      </span>
    </button>
  );
}

function CheckDetail({ check }: { check: MergeCheckItem }) {
  return (
    <div role="group" aria-label={`${check.fullName}の詳細`} className="mt-1.5 rounded-md border bg-muted/30 px-3 py-2 text-xs">
      <p className="font-semibold">{check.fullName}</p>
      <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted-foreground">状態</dt>
        <dd className={cn("font-bold", TONE_TEXT[check.tone])}>
          <span aria-hidden="true">{check.mark}</span> {check.state}
        </dd>
        <dt className="text-muted-foreground">判定対象</dt>
        <dd className="min-w-0 break-words">{check.target}</dd>
        <dt className="text-muted-foreground">理由・指摘</dt>
        <dd className="min-w-0 break-words">{check.reason ?? "なし"}</dd>
      </dl>
      {check.common && <p className="mt-1 text-muted-foreground">根拠（指摘本文・ログ・再実行）は下の「リリースの検証」の各区分で確認できます。</p>}
    </div>
  );
}

/**
 * 本番PR詳細の上部（#4428）。**現在状態＋次の主操作 → 現在候補の検証 → 今回リリースする変更 → 詳細・履歴**
 * の順に並べる。状態の判定は#4398の`describeFixOverview`、マージの可否は#4390の判定を持つ
 * `PullRequestMergeButton`をそのまま使い、ここでは並べ方だけを持つ。
 *
 * 修正の操作が要る間（指摘あり・修正の開始・判断待ちなど）は修正の操作を主操作にし、マージのボタンは出さない。
 * 修正の操作が無いときだけ「本番公開へ進む」を置く（押すと既存の本番マージ確認を必ず通る）。
 * 検証中・準備中はボタン自身が理由付きで押せなくなる。
 */
export function ReleasePullRequestOverview({
  pullRequest,
  onMerged,
}: {
  pullRequest: PullRequestSummary;
  onMerged: () => void;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  const { repositoryFullName, number, headRef } = pullRequest;
  const { verification, error } = useReleaseVerification(repositoryFullName, number, true, reloadToken);
  const changes = useReleaseChanges(repositoryFullName, true, number, reloadToken, false);
  // リリース候補（#4495）。新方式は候補ID・revision、旧方式は識別と移行の導線を出す
  const rc = useReleaseRc(repositoryFullName, number, true, reloadToken);
  const rcCandidate = isRcReleaseCandidateHeadRef(headRef) ? (rc.overview?.candidate ?? null) : null;
  const legacy = rc.overview?.legacy?.prNumber === number ? rc.overview.legacy : null;
  // 公開できる工程か（#4635）。サーバーのマージAPIと同じ判定。旧方式はundefined、取得前はnull（推測で公開可にしない）
  const publishDecision = decidePublishForPullRequest(pullRequest, rc.overview);
  const publishBlock = publishDecision && !publishDecision.ok ? { next: publishDecision.next, message: publishDecision.message } : null;
  const state = useReleaseFixOverview({
    repositoryFullName,
    pullRequestNumber: number,
    verification,
    verificationError: error,
    changes,
    reloadToken,
    publishBlock,
    headRef,
  });
  const { openPullRequest } = useReferenceNavigation();
  // 工程はPR一覧と同じ入力（`releaseChecks`）から作る（#5076）。候補の記録だけは、操作後・進行中に取り直す
  // 候補の状況（`useReleaseRc`）の新しい値で置き換え、承認の直後に古い「公開承認待ち」が残らないようにする
  const journey = resolvePullRequestJourney(
    rc.overview && pullRequest.releaseChecks
      ? {
          ...pullRequest,
          releaseChecks: {
            ...pullRequest.releaseChecks,
            rc: rc.overview.journeyFacts !== undefined ? rc.overview.journeyFacts : (pullRequest.releaseChecks.rc ?? null),
            unavailableParts: [
              ...(pullRequest.releaseChecks.unavailableParts ?? []).filter((part) => part !== "rc"),
              ...(rc.overview.journeyFactsUnavailable ? (["rc"] as const) : []),
            ],
          },
        }
      : pullRequest,
    rc.error ? { failed: true } : null,
  );
  const manualPublish =
    journey && publishDecision?.ok ? (
      <ReleasePublishAction pullRequest={pullRequest} decision={publishDecision} onMerged={onMerged} variant="outline" label="承認せずに本番公開へ進む" />
    ) : null;
  const reload = () => setReloadToken((n) => n + 1);
  // 未判断の止める指摘があれば、判定表と「おまかせで公開承認まで進める」を次の操作にする（#5138。新方式の候補だけ）
  const autoProceed =
    rcCandidate !== null && !state.previousResults && verification !== null && shouldShowAutoProceed(verification, state.completionRun?.active ?? false);

  return (
    <div className="-mx-4 flex flex-col gap-3 border-b px-4 py-4 text-xs" data-testid="release-pull-request-overview">
      {/* 正式タイトルとリポジトリ名は共通詳細の見出しが持つ（#4463）。ここはブランチ情報だけを出す */}
      {rcCandidate ? (
        <ReleaseRcIdentity candidate={rcCandidate} />
      ) : (
        <p className="break-words text-xs text-muted-foreground">
          {headRef} → {pullRequest.baseRef}
        </p>
      )}
      {rc.overview && legacy && (
        <ReleaseRcLegacyNotice overview={rc.overview} legacy={legacy} repositoryFullName={repositoryFullName} onChanged={rc.reload} />
      )}

      <section aria-label="現在の状態と次の操作" className="flex flex-col gap-3 rounded-[10px] border bg-card p-3.5 text-sm">
        {/* 新方式の候補は、ブランチ画面・PR一覧と同じ工程と「いま・担当・次」を先頭に出す（#5076）。主操作は1つで、
            承認を経ない手動の公開は「その他の操作」へ下げる（承認そのもののボタンは下の「公開準備」にある） */}
        {journey && (
          <div className="flex flex-col gap-2 text-xs" data-testid="release-pull-request-journey">
            <ReleaseJourneySteps journey={journey} />
            <ReleaseJourneyNow
              journey={journey}
              action={
                <button type="button" className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={reload}>
                  状態を取り直す
                </button>
              }
              link={
                journey.headline?.key === "approve" && journey.owner === "user" && rc.overview?.finalization ? (
                  <a href="#release-rc-finalize" className="text-primary hover:underline">
                    下の「公開準備」で{journey.headline.label === "公開承認待ち" ? "公開承認する" : "承認し直す"} ↓
                  </a>
                ) : null
              }
              more={
                <JourneyMoreActions count={manualPublish ? 1 : 0}>
                  {manualPublish}
                </JourneyMoreActions>
              }
            />
          </div>
        )}
        {autoProceed && verification && (
          <ReleaseAutoProceedPanel
            repositoryFullName={repositoryFullName}
            pullRequestNumber={number}
            verification={verification}
            onRunStarted={state.setCompletionRun}
            onReload={reload}
            manualHref="#release-candidate-verification"
          />
        )}
        <ReleaseFixSummary
          state={state}
          showPhases
          primaryAsSecondary={autoProceed}
          completionAsSecondary={autoProceed || (journey !== null && !(journey.headline?.key === "verify" && journey.owner === "user"))}
          extraAction={
            journey ? null : (
              <div className="pt-1">
                <ReleasePublishAction pullRequest={pullRequest} decision={publishDecision} onMerged={onMerged} />
              </div>
            )
          }
        />
      </section>

      {/* 公開準備は状態と主操作の直後に置く（合格後の主操作は「公開準備へ進む」。#4635） */}
      {rcCandidate && rc.overview?.finalization && (
        <ReleaseRcFinalizePanel candidate={rcCandidate} finalization={rc.overview.finalization} repositoryFullName={repositoryFullName} onChanged={rc.reload} />
      )}

      {/* 公開後のdevelop同期は、本番公開の結果とは別の欄として出す（#4641） */}
      {rcCandidate && <ReleaseRcCancel candidate={rcCandidate} repositoryFullName={repositoryFullName} onChanged={rc.reload} />}
      {rcCandidate && rc.overview?.developSync && (
        <ReleaseDevelopSyncNotice repositoryFullName={repositoryFullName} sync={rc.overview.developSync} onChanged={rc.reload} />
      )}

      <section id="release-candidate-verification" aria-label="現在候補の検証" className="flex scroll-mt-4 flex-col gap-2 rounded-[10px] border bg-card p-3.5">
        <h3 className="text-sm font-semibold">現在候補の検証</h3>
        {state.previousResults ? (
          // 修正後の候補が未作成・取得中の間は、旧候補の成功や指摘を現在値として代用しない（#4428）
          <p className="text-muted-foreground">
            修正を反映したリリース候補はまだできていません。修正前の結果は下の「修正前のリリース・検証履歴」にあります（現在の結果ではありません）。
          </p>
        ) : (
          <ReleaseCandidateChecks pullRequest={pullRequest} />
        )}
        <ReleaseReviewSections
          repositoryFullName={repositoryFullName}
          pullRequestNumber={number}
          headRef={headRef}
          verification={verification}
          verificationError={error}
          changes={changes}
          onReload={reload}
          onOpenPullRequest={(n) => openPullRequest(`${repositoryFullName}#${n}`)}
          hideOverview
          previousResults={state.previousResults}
        />
        {rcCandidate && (
          <ReleaseRcVerificationEvidence candidate={rcCandidate} finalization={rc.overview?.finalization?.current ?? null} />
        )}
      </section>

      <section aria-label="今回リリースする変更" className="rounded-[10px] border bg-card p-3.5">
        <ReleaseContentsList state={state} />
      </section>

      {/* 並びは 状態と次の操作 → 候補共通検証 → 公開対象 → 履歴（#4560） */}
      {rcCandidate && <ReleaseRcRevisionHistory candidate={rcCandidate} />}

      {state.list && state.list.length > 0 && (
        <section aria-label="修正の履歴" className="overflow-hidden rounded-[10px] border bg-card">
          <ReleaseFixHistory state={state} />
        </section>
      )}
    </div>
  );
}
