/**
 * リリースの開始方式（#4604）。リポジトリごとに、通常の開始操作が新方式（候補を作成して検証）で動くか、
 * 旧方式で動くか、起動できないかを決める。
 *
 * **候補作成だけ有効にして公開できない状態にしない**ため、候補（`candidate_request`）と
 * 公開準備（`finalize_request`）の**両方**にcallerが対応しているときだけ新方式にする。
 * 判定の材料はdevelopにあるcallerの本文だけで、読めなければ`unknown`（起動しない）。
 */

import type { DevelopSyncStatus } from "@/lib/release-develop-sync";
import { parseFinalizeCallerSupport } from "@/lib/release-finalize";
import { parseRcCallerSupport, type RcBlockSummary } from "@/lib/release-rc";

export type ReleaseStartMode =
  /** 候補作成・公開準備の両方に対応。通常の開始操作は候補を作る */
  | { mode: "candidate" }
  /** どちらか（または両方）に未対応。caller・参照タグの更新が要る。通常開始は止まる（旧方式へ落とさない） */
  | { mode: "legacy"; reason: "caller_without_input" | "finalize_without_input"; label: string }
  /** callerを読めず判定できない。起動しない（旧方式を黙って起動しない） */
  | { mode: "unknown"; label: string }
  /** 新方式に対応しているが、新規開始を妨げる既存候補がある（#4628）。起動しない */
  | { mode: "blocked"; label: string; block: RcBlockSummary }
  /** 前回の公開がdevelopへ戻っていない、または戻っているか判定できない（#4641）。起動しない */
  | { mode: "develop_sync"; label: string; sync: DevelopSyncStatus };

export const START_MODE_LEGACY_LABEL =
  "新方式（候補の作成・検証）に未対応です。caller（.github/workflows/release-develop-to-main.yml）へ`candidate_request`・`finalize_request`のinputと受け渡しを足し、共有ワークフローの参照タグを最新へ更新してください。更新するまで通常開始は止まります（旧方式では起動しません）";

export function decideReleaseStartMode(callerText: string | null): ReleaseStartMode {
  if (callerText === null) {
    return { mode: "unknown", label: "リリースworkflowのcallerを読めず、新方式に対応しているか判定できません" };
  }
  if (!parseRcCallerSupport(callerText).supported) {
    return { mode: "legacy", reason: "caller_without_input", label: START_MODE_LEGACY_LABEL };
  }
  if (!parseFinalizeCallerSupport(callerText).supported) {
    return {
      mode: "legacy",
      reason: "finalize_without_input",
      label: "候補の作成には対応していますが公開準備（finalize_request）に未対応のため、新方式を有効にしていません。callerへ`finalize_request`のinputと受け渡しを足し、参照タグを更新してください。更新するまで通常開始は止まります",
    };
  }
  return { mode: "candidate" };
}
