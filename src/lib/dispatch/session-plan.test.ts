import { describe, expect, it } from "vitest";

import {
  buildSessionPlanCommentBody,
  parsePlanBaseSha,
  parseSessionHostName,
  parseSessionPlanText,
  SESSION_PLAN_MARKER,
} from "@/lib/dispatch/session-plan";
import { SESSION_ARTIFACT_HTML_LIMIT } from "@/lib/dispatch/session-artifact";

describe("buildSessionPlanCommentBody", () => {
  it("計画本文をそのまま載せ、その下にRemote Controlのリンクを置く", () => {
    const body = buildSessionPlanCommentBody({
      plan: "## アプローチ\n- あれをする",
      remoteControlUrl: "https://claude.ai/code/session_01ABC",
      planBaseSha: "baf823f30a2ef7d8f80ff95665e7034e67d70171",
      hostName: "subpc",
    });

    expect(body).toContain("## アプローチ\n- あれをする");
    expect(body).toContain("[Remote Controlで開く](https://claude.ai/code/session_01ABC)");
    // **リンクは計画本文より後ろに置く**（Issue #1342 の「その下にも別途」）
    expect(body.indexOf("- あれをする")).toBeLessThan(body.indexOf("Remote Controlで開く"));
    expect(body).toContain(SESSION_PLAN_MARKER);
    expect(body).toContain("サブPCのセッションが承認を待っています");
  });

  /**
   * 手で投稿していたときと同じ形（`<!-- plan-base: <SHA> -->`）を先頭に保つ。
   * 後から`git log <SHA>..origin/develop`で前提の変化を辿るための手掛かり。
   */
  it("plan-baseのSHAを先頭のコメントとして残す", () => {
    const body = buildSessionPlanCommentBody({
      plan: "計画",
      remoteControlUrl: null,
      planBaseSha: "baf823f",
      hostName: null,
    });

    expect(body.startsWith("<!-- plan-base: baf823f -->")).toBe(true);
  });

  // #2200: 見た目が変わったことは、計画本文を読み切る前に分かる必要がある
  it("アーティファクトを取り込んだ回だけ、見出しの直後に案内を足す", () => {
    const params = {
      plan: "## アプローチ\n- あれをする",
      remoteControlUrl: null,
      planBaseSha: null,
      hostName: null,
    };

    const updated = buildSessionPlanCommentBody({ ...params, artifactUpdated: true });
    expect(updated).toContain("アーティファクトも更新しました");
    expect(updated.indexOf("アーティファクトも更新しました")).toBeLessThan(
      updated.indexOf("- あれをする"),
    );

    expect(buildSessionPlanCommentBody(params)).not.toContain("アーティファクトも更新しました");
  });

  it("SHAが取れなければplan-baseの行ごと落とす", () => {
    const body = buildSessionPlanCommentBody({
      plan: "計画",
      remoteControlUrl: null,
      planBaseSha: null,
      hostName: null,
    });

    expect(body).not.toContain("plan-base");
  });

  /**
   * URLが取れないのは異常ではない（`--remote-control`無しの起動・Claude Codeの内部ファイルの
   * 形が変わった場合）。**計画そのものは載せる価値がある**ので、リンクだけを落とす。
   */
  it("Remote ControlのURLが無ければリンクの代わりに案内を出し、計画は載せる", () => {
    const body = buildSessionPlanCommentBody({
      plan: "計画の中身",
      remoteControlUrl: null,
      planBaseSha: null,
      hostName: null,
    });

    expect(body).toContain("計画の中身");
    expect(body).not.toContain("Remote Controlで開く](");
    expect(body).toContain("Remote ControlのURLを取得できませんでした");
    expect(body).toContain(SESSION_PLAN_MARKER);
  });

  /**
   * GitHubのコメント本文は65536字が上限。**超えた場合に投稿ごと失敗する（計画がどこにも
   * 残らない）方が損失が大きい**ので切る。
   */
  it("長すぎる計画は切り詰めて、切ったことを本文に残す", () => {
    const body = buildSessionPlanCommentBody({
      plan: "あ".repeat(70000),
      remoteControlUrl: null,
      planBaseSha: null,
      hostName: null,
    });

    expect(body.length).toBeLessThan(65536);
    expect(body).toContain("長すぎるため以降を省略しました");
  });
});

describe("parseSessionPlanText", () => {
  it("前後の空白を落とす", () => {
    expect(parseSessionPlanText("  計画  ")).toBe("計画");
  });

  it("空・空白のみ・文字列でないものは受け取らない", () => {
    expect(parseSessionPlanText("")).toBeNull();
    expect(parseSessionPlanText("   \n ")).toBeNull();
    expect(parseSessionPlanText(null)).toBeNull();
    expect(parseSessionPlanText(123)).toBeNull();
  });

  // #2200: 切り出しに外れたアーティファクト（2MBまで）がそのまま届くことがあるので、
  // 20万字では**その回の計画がどこにも残らない**。投稿・表示の切り詰めは別に効く
  it("アーティファクトを埋めたままの計画も受け取る", () => {
    expect(parseSessionPlanText("a".repeat(300000))).not.toBeNull();
  });

  it("明らかに壊れた長さは受け取らない", () => {
    expect(parseSessionPlanText("あ".repeat(SESSION_ARTIFACT_HTML_LIMIT + 1))).toBeNull();
  });
});

describe("parsePlanBaseSha", () => {
  it("16進のSHAだけを通す", () => {
    expect(parsePlanBaseSha("baf823f")).toBe("baf823f");
    expect(parsePlanBaseSha("baf823f30a2ef7d8f80ff95665e7034e67d70171")).toBe(
      "baf823f30a2ef7d8f80ff95665e7034e67d70171",
    );
  });

  // 本文へそのまま埋めるため、Markdownやコメントを壊せる文字列は通さない
  it("SHAでない文字列は通さない", () => {
    expect(parsePlanBaseSha("-->悪意")).toBeNull();
    expect(parsePlanBaseSha("BAF823F")).toBeNull();
    expect(parsePlanBaseSha("abc")).toBeNull();
    expect(parsePlanBaseSha(null)).toBeNull();
  });
});

describe("parseSessionHostName", () => {
  it("識別子として妥当なホスト名だけを通す", () => {
    expect(parseSessionHostName("subpc")).toBe("subpc");
    expect(parseSessionHostName("main-pc.local")).toBe("main-pc.local");
    expect(parseSessionHostName("subpc **太字**")).toBeNull();
    expect(parseSessionHostName("")).toBeNull();
    expect(parseSessionHostName(undefined)).toBeNull();
  });
});
