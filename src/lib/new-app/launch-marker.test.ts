import { describe, expect, it } from "vitest";

import { buildManualStepRunPlan } from "@/lib/manual-step-autorun";
import { parseManualStepGuide } from "@/lib/manual-step-guide";
import {
  NEW_APP_MARKER_TAG,
  buildExistingLaunchIssueComment,
  buildNewAppMarker,
  findExistingLaunchIssue,
  parseNewAppMarker,
  withNewAppMarker,
  type ExistingIssue,
} from "@/lib/new-app/launch-marker";
import { buildSubpcManualIssueBody } from "@/lib/new-app/plan";
import { emptyNewAppSpec, type NewAppSpec } from "@/lib/new-app/spec";

const MARKER = {
  app: "aide-bot",
  repo: "guchi-apps/aide-bot",
  host: "aide-bot.gucchii.com",
  kind: "vps-issue" as const,
  parent: "guchi-apps/issue-deck#2213",
};

function issue(overrides: Partial<ExistingIssue> & { number: number }): ExistingIssue {
  return {
    title: "",
    body: null,
    htmlUrl: `https://github.com/guchi-apps/vps/issues/${overrides.number}`,
    ...overrides,
  };
}

const TARGET = {
  targetRepository: "guchi-apps/vps",
  appName: "aide-bot",
  hostname: "aide-bot.gucchii.com",
};

describe("マーカー", () => {
  it("本文の先頭へ置き、読み戻せる", () => {
    const body = withNewAppMarker("## やること\n\n- [ ] vhostを追加する\n", MARKER);
    expect(body.startsWith(`<!-- ${NEW_APP_MARKER_TAG}:`)).toBe(true);
    expect(parseNewAppMarker(body)).toEqual(MARKER);
  });

  it("すでに入っていれば足さない", () => {
    const once = withNewAppMarker("本文", MARKER);
    expect(withNewAppMarker(once, MARKER)).toBe(once);
  });

  it("1行に収める（HTMLコメントに改行を含めない）", () => {
    expect(buildNewAppMarker(MARKER)).not.toContain("\n");
  });

  it("マーカーが無い・壊れている本文はnull", () => {
    expect(parseNewAppMarker("ただの本文")).toBeNull();
    expect(parseNewAppMarker(null)).toBeNull();
    expect(parseNewAppMarker(`<!-- ${NEW_APP_MARKER_TAG}: {壊れている -->`)).toBeNull();
  });

  it("手作業Issueの本文へ足しても、代行実行の判定が壊れない", () => {
    const spec: NewAppSpec = {
      ...emptyNewAppSpec(),
      displayName: "家計レポート",
      repositoryName: "kakei-report",
      subdomain: "kakei-report",
      port: 3112,
      databaseName: "app_kakei_report",
    };
    const body = withNewAppMarker(
      buildSubpcManualIssueBody(spec, {
        parent: "guchi-apps/issue-deck#2201",
        vps: "guchi-apps/vps#91",
        subpc: null,
        localPortBase: 25000,
        portBandPullRequest: "guchi-apps/issue-deck#2204",
      }),
      { ...MARKER, app: "kakei-report", kind: "manual-subpc" },
    );
    const guide = parseManualStepGuide(body);
    expect(guide.hasTemplate).toBe(true);
    expect(guide.where.defaultDevice).toBe("サブPC");
    const plan = buildManualStepRunPlan(body, undefined, {
      host: { online: true, manualStepCapable: true, manualStepValuesCapable: true },
      isManualStepIssue: true,
    });
    expect(plan.entries.every((entry) => entry.rejection === null)).toBe(true);
    expect(plan.runnable).toBeGreaterThanOrEqual(3);
  });
});

describe("findExistingLaunchIssue", () => {
  it("同じ対象が無ければnull", () => {
    const found = findExistingLaunchIssue(
      [issue({ number: 100, title: "dayspanのvhostを追加する" })],
      TARGET,
    );
    expect(found).toBeNull();
  });

  it("マーカーが一致すれば、それを最優先で返す", () => {
    const found = findExistingLaunchIssue(
      [
        issue({ number: 124, title: "[手作業] VPS: aide-bot のDNSを登録する" }),
        issue({ number: 121, title: "VirtualHostを追加する", body: buildNewAppMarker(MARKER) }),
      ],
      TARGET,
    );
    expect(found).toMatchObject({ number: 121, reason: "marker", reference: "guchi-apps/vps#121" });
  });

  it("マーカーが無くてもホスト名で拾う", () => {
    const found = findExistingLaunchIssue(
      [issue({ number: 128, title: "デプロイが公開まで届いていない", body: "aide-bot.gucchii.com が 404" })],
      TARGET,
    );
    expect(found).toMatchObject({ number: 128, reason: "hostname" });
  });

  it("ホスト名が無くてもタイトルのアプリ名で拾う", () => {
    const found = findExistingLaunchIssue(
      [issue({ number: 122, title: "aide-bot を受け入れる設定が無い" })],
      TARGET,
    );
    expect(found).toMatchObject({ number: 122, reason: "app-name" });
  });

  it("いちばん古いものへ寄せる", () => {
    const found = findExistingLaunchIssue(
      [
        issue({ number: 128, title: "aide-bot のデプロイが失敗する" }),
        issue({ number: 122, title: "aide-bot を受け入れる設定が無い" }),
      ],
      TARGET,
    );
    expect(found?.number).toBe(122);
  });

  it("前方一致の別アプリを取り違えない", () => {
    const found = findExistingLaunchIssue(
      [issue({ number: 130, title: "aide-bottle のvhostを追加する" })],
      TARGET,
    );
    expect(found).toBeNull();
  });

  it("ホスト名を渡さないとき（パス配下）は、共有ホスト名で拾わない", () => {
    const found = findExistingLaunchIssue(
      [issue({ number: 131, title: "gucchii.com の証明書を更新する", body: "gucchii.com" })],
      { ...TARGET, hostname: null },
    );
    expect(found).toBeNull();
  });
});

describe("buildExistingLaunchIssueComment", () => {
  it("手順を複製せず、親Issueとマーカーを残す", () => {
    const comment = buildExistingLaunchIssueComment({
      displayName: "AIDE Bot",
      repositoryFullName: "guchi-apps/aide-bot",
      hostname: "aide-bot.gucchii.com",
      parent: "guchi-apps/issue-deck#2213",
      reason: "hostname",
    });
    expect(comment).toContain("guchi-apps/issue-deck#2213");
    expect(comment).toContain("新しく立てないでください");
    expect(parseNewAppMarker(comment)?.app).toBe("aide-bot");
    // 手順（チェックリスト）を持ち込まない
    expect(comment).not.toContain("- [ ]");
  });
});
