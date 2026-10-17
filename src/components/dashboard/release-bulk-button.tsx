"use client";

import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useReleasePreparation } from "@/hooks/use-release-preparation";
import { PREP_OVERRIDE_CONFIRM_TEXT, type ReleasePrepState } from "@/lib/release-prep-state";
import { releaseBlockShortLabel } from "@/components/dashboard/release-block-notice";
import { fetchReleaseStartModes, requestReleaseBulk, type ReleaseStartModes } from "@/lib/release-request";

export type ReleaseBulkTarget = {
  repositoryFullName: string;
  /** 確認ダイアログに出す未リリースの件数表示（`formatUnreleasedSummary`の結果） */
  unreleasedLabel: string;
};

type ReleaseBulkButtonProps = {
  /** developがmainより進んでいて、個別の「リリースする」も押せる状態のリポジトリだけ（#2770） */
  targets: ReleaseBulkTarget[];
  /**
   * ブランチ状況を取得できず、対象に含められるか判定できなかったリポジトリの件数（#2770）。
   * 0より大きいときは確認ダイアログへ「この一覧には含まれていない」旨を添える——`targets`は
   * 判定できたものだけなので、それに気づけないままだと「まとめて出した」つもりで1件
   * 取りこぼす（計画レビュー指摘3）。
   */
  unknownRepositoryCount?: number;
  /** 起動できたリポジトリぶん、親が「起動中」表示の反映と再取得を行う */
  onTriggered: (succeededFullNames: string[]) => void;
};

/**
 * 「ブランチ」画面から、developがmainより進んでいる複数のリポジトリのリリースworkflowを
 * まとめて起動するボタン（#2770）。
 *
 * 対象は個別の「リリースする」ボタンと同じ判定（`canTriggerRelease`。`lib/branch-flow.ts`）を
 * 通したものだけを親から受け取る。**新規のGitHub API問い合わせは行わない**——「ブランチ」画面が
 * 開いた時点で既に持っているデータをそのまま使うため、対象が0件のときはボタンごと出さない
 * （Issue本文の「デプロイするものがない場合は実行しない」を満たす）。
 *
 * 起動も新規の一括APIを持たず、`repository-release-button.tsx`と同じ`requestRelease`を
 * 対象ぶんループするだけにしてある（計画レビューの指摘を受けた判断。`requestReleaseBulk`
 * 参照）。develop→mainへの実際のマージには関与しない——起動するのは各リポジトリの
 * バージョンバンプPR作成までで、mainへのマージは引き続き人が個別に行う。
 */
export function ReleaseBulkButton({
  targets,
  unknownRepositoryCount = 0,
  onTriggered,
}: ReleaseBulkButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 準備中・準備失敗のリポジトリが含まれるときは、確認のうえ起動できる（#4421。個別ボタンと同じ挙動）
  const [prepStates, setPrepStates] = useState<Record<string, ReleasePrepState>>({});
  const [allowPrepOverride, setAllowPrepOverride] = useState(false);
  const prepStateList = Object.values(prepStates);
  const hasPrepBlocked = prepStateList.some((state) => state === "running" || state === "failed");
  // 準備状態を取得できていない対象が1つでもあれば起動を確定させない（#4556。未報告の行もunknown扱い）
  // リポジトリごとの開始方式（#4604）。ダイアログを開いたときに取り、候補を作れるrepoだけを起動する
  const [startModes, setStartModes] = useState<ReleaseStartModes | null>(null);
  const targetNamesKey = targets.map((target) => target.repositoryFullName).join(",");
  useEffect(() => {
    if (!confirmOpen || targetNamesKey === "") return;
    let cancelled = false;
    void fetchReleaseStartModes(targetNamesKey.split(",")).then((modes) => {
      if (!cancelled) setStartModes(modes);
    });
    return () => {
      cancelled = true;
    };
  }, [confirmOpen, targetNamesKey]);
  const startable = startModes ? targets.filter((target) => startModes[target.repositoryFullName]?.mode === "candidate") : [];
  const prepUnknown = targets.some((target) => (prepStates[target.repositoryFullName] ?? "unknown") === "unknown");

  // 対象が無ければボタンごと出さない（#2770）。単一ボタンの「押せないときも消さない」
  // （#2711）とは異なり、こちらは0件のとき押す意味のある操作が1つも無いため。
  if (targets.length === 0) return null;

  async function handleTrigger() {
    setIsTriggering(true);
    setError(null);
    try {
      // 旧方式・判定不能のrepoは起動しない（一括で旧方式を黙って起動しない。#4604）
      const result = await requestReleaseBulk(startable.map((target) => target.repositoryFullName));
      setConfirmOpen(false);
      onTriggered(result.succeeded);
      if (result.failed.length > 0) {
        setError(
          `${result.failed.length}件の起動に失敗しました: ${result.failed
            .map((failure) => `${failure.repoFullName}（${failure.message}）`)
            .join(" / ")}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsTriggering(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 shrink-0 gap-1.5"
        disabled={isTriggering}
        onClick={() => setConfirmOpen(true)}
      >
        <Rocket className={isTriggering ? "size-3.5 animate-pulse" : "size-3.5"} />
        {isTriggering ? "起動中..." : `未リリース${targets.length}件をまとめてリリース`}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => {
        setConfirmOpen(open);
        if (!open) {
          setAllowPrepOverride(false);
          setPrepStates({});
          setStartModes(null);
        }
      }}>
        <AlertDialogContent className="flex flex-col gap-4 overflow-hidden">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {startModes ? startable.length : targets.length}件のリポジトリでリリース候補を作成して検証しますか？
            </AlertDialogTitle>
            <AlertDialogDescription>
              新方式に対応したリポジトリで、developの先端を候補（release-rc/*）として固定し、全体レビュー・統合検証へ進めます。
              正式な版は、合格後の「公開準備」で初めて上げます。
              <strong className="text-foreground">未対応・判定できないリポジトリは起動しません</strong>
              （旧方式を一括で黙って起動することはありません。各リポジトリの個別の操作で起動してください）。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {/* ブランチ状況を取得できず判定できなかったリポジトリがあるとき、この一覧が
              「まとめて出した」つもりで取りこぼす1件になり得ることを明示する（計画レビュー指摘3） */}
          {unknownRepositoryCount > 0 && (
            <p className="text-xs text-muted-foreground">
              このほかブランチ状況を取得できていないリポジトリが{unknownRepositoryCount}
              件あり、この一覧には含まれていません。
            </p>
          )}
          <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
            {targets.map((target) => (
              <BulkTargetRow
                key={target.repositoryFullName}
                target={target}
                startMode={startModes?.[target.repositoryFullName] ?? null}
                enabled={confirmOpen}
                onPrepState={(state) =>
                  setPrepStates((prev) => (prev[target.repositoryFullName] === state ? prev : { ...prev, [target.repositoryFullName]: state }))
                }
              />
            ))}
          </div>
          {hasPrepBlocked && (
            <label className="flex items-start gap-2 rounded-md border border-amber-500/40 p-3 text-sm">
              <Checkbox
                checked={allowPrepOverride}
                onCheckedChange={(checked) => setAllowPrepOverride(checked === true)}
                disabled={isTriggering}
              />
              <span>
                {prepStateList.includes("failed") ? PREP_OVERRIDE_CONFIRM_TEXT.failed : PREP_OVERRIDE_CONFIRM_TEXT.running}
                （「準備中」「準備失敗」と表示したリポジトリを含みます）
              </span>
            </label>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              disabled={isTriggering || prepUnknown || startable.length === 0 || (hasPrepBlocked && !allowPrepOverride)}
              onClick={(event) => {
                // 起動の結果を待たずに閉じないよう既定の閉じる動作を止める（#1548と同じ理由）。
                event.preventDefault();
                void handleTrigger();
              }}
            >
              {isTriggering ? "起動中..." : "起動する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 確認ダイアログの1行。開いている間だけ準備の状態を取り、準備中・失敗を行に添えて親へ知らせる（#4421） */
function BulkTargetRow({
  target,
  startMode,
  enabled,
  onPrepState,
}: {
  target: ReleaseBulkTarget;
  startMode: ReleaseStartModes[string] | null;
  enabled: boolean;
  onPrepState: (state: ReleasePrepState) => void;
}) {
  const { prepState } = useReleasePreparation(target.repositoryFullName, enabled);
  useEffect(() => {
    onPrepState(prepState);
    // onPrepStateは親が毎回作り直すため依存に含めない（値が変わったときだけ知らせる）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepState]);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate">{target.repositoryFullName}</span>
      <span className="flex shrink-0 items-center gap-2 text-muted-foreground tabular-nums">
        {startMode === null ? (
          <span className="rounded bg-muted px-1.5 text-[11px]">対応確認中</span>
        ) : startMode.mode === "candidate" ? (
          <span className="rounded bg-muted px-1.5 text-[11px]" title={startMode.successorOf?.reason}>
            {startMode.successorOf ? `候補を作成（${startMode.successorOf.label}は後続で確認）` : "候補を作成"}
          </span>
        ) : (
          <span className="rounded bg-amber-500/15 px-1.5 text-[11px] text-amber-700" title={startMode.label}>
            {startMode.mode === "legacy"
              ? "未対応（更新が必要）・起動しない"
              : startMode.mode === "blocked"
                ? (releaseBlockShortLabel(startMode) ?? "既存候補あり・起動しない")
                : startMode.mode === "develop_sync"
                  ? startMode.sync.state === "unknown"
                    ? "develop同期を判定できず・起動しない"
                    : "developへ未同期・起動しない"
                  : "判定不能・起動しない"}
          </span>
        )}
        {prepState !== "idle" && (
          <span className="rounded bg-muted px-1.5 text-[11px]">
            {prepState === "unknown" ? "確認中" : prepState === "running" ? "準備中" : "準備失敗"}
          </span>
        )}
        {target.unreleasedLabel}
      </span>
    </div>
  );
}
