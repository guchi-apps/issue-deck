import { describe, expect, it } from "vitest";

import { releaseDevelopToMainCaller } from "@/lib/new-app/scaffold-workflows";
import { decideReleaseStartMode } from "@/lib/release-start-mode";

const LEGACY_CALLER = `on:
  workflow_dispatch:
    inputs:
      bump_kind:
        type: string
      rebuild_selection:
        type: string
jobs:
  release:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-release-develop-to-main.yml@workflows/v51
    with:
      rebuild-selection: x
`;

const CANDIDATE_ONLY = `${LEGACY_CALLER}      candidate_request:
        type: string
    with2:
      candidate-request: x
`;

describe("decideReleaseStartMode", () => {
  it("読めないcallerは判定不能（旧方式を黙って起動しない）", () => {
    expect(decideReleaseStartMode(null).mode).toBe("unknown");
  });
  it("candidate_requestが無ければ未対応", () => {
    expect(decideReleaseStartMode(LEGACY_CALLER)).toMatchObject({ mode: "legacy", reason: "caller_without_input" });
  });
  it("候補作成だけ対応で公開準備が未対応なら新方式にしない", () => {
    expect(decideReleaseStartMode(CANDIDATE_ONLY)).toMatchObject({ mode: "legacy", reason: "finalize_without_input" });
  });
  it("新規repo雛形のcallerは新方式を開始できる", () => {
    const caller = releaseDevelopToMainCaller({} as never, "workflows/v51");
    expect(decideReleaseStartMode(caller)).toEqual({ mode: "candidate" });
  });
});
