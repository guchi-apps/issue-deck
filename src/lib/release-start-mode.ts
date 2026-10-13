/**
 * リリースの開始方式（#4604）。リポジトリごとに、通常の開始操作が新方式（候補を作成して検証）で動くか、
 * 旧方式で動くか、起動できないかを決める。
 *
 * **候補作成だけ有効にして公開できない状態にしない**ため、候補（`candidate_request`）と
 * 公開準備（`finalize_request`）の**両方**にcallerが対応しているときだけ新方式にする。
 * 判定の材料はdevelopにあるcallerの本文だけで、読めなければ`unknown`（起動しない）。
 */

import { parseFinalizeCallerSupport } from "@/lib/release-finalize";
import { parseRcCallerSupport } from "@/lib/release-rc";

export type ReleaseStartMode =
  /** 候補作成・公開準備の両方に対応。通常の開始操作は候補を作る */
  | { mode: "candidate" }
  /** どちらか（または両方）に未対応。caller・参照タグの更新が要る。旧方式のまま動く */
  | { mode: "legacy"; reason: "caller_without_input" | "finalize_without_input"; label: string }
  /** callerを読めず判定できない。起動しない（旧方式を黙って起動しない） */
  | { mode: "unknown"; label: string };

export const START_MODE_LEGACY_LABEL =
  "新方式（候補の作成・検証）に未対応です。caller（release-develop-to-main.yml）の更新が要ります。更新するまで旧方式で動作します";

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
      label: "候補の作成には対応していますが公開準備（finalize_request）に未対応のため、新方式を有効にしていません。callerの更新が要ります",
    };
  }
  return { mode: "candidate" };
}
