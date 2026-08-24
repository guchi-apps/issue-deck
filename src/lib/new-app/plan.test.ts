import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { buildManualStepRunPlan } from "@/lib/manual-step-autorun";
import { parseManualStepGuide } from "@/lib/manual-step-guide";
import {
  buildBrowserManualIssueBody,
  buildInitIssueBody,
  buildNewAppPlan,
  buildParentIssueBody,
  buildPortBandPullRequestBody,
  buildPortBandPullRequestTitle,
  buildSubpcManualIssueBody,
  buildVpsIssueBody,
  buildVpsManualIssueBody,
  portBandBranchName,
  repositoryFullName,
  type NewAppIssueRefs,
} from "@/lib/new-app/plan";
import { emptyNewAppSpec, type NewAppSpec } from "@/lib/new-app/spec";

function spec(overrides: Partial<NewAppSpec> = {}): NewAppSpec {
  return {
    ...emptyNewAppSpec(),
    displayName: "家計レポート",
    repositoryName: "kakei-report",
    summary: "家計の月次推移をZaimのデータから作る",
    subdomain: "kakei-report",
    port: 3112,
    databaseName: "app_kakei_report",
    auth: "supabase-google",
    ...overrides,
  };
}

const REFS: NewAppIssueRefs = {
  parent: "guchi-apps/issue-deck#2201",
  vps: "guchi-apps/vps#91",
  subpc: "guchi-apps/issue-deck#2203",
  localPortBase: 25000,
  portBandPullRequest: "guchi-apps/issue-deck#2204",
};

const READY_HOST: Pick<DispatchHostView, "online" | "manualStepCapable"> = {
  online: true,
  manualStepCapable: true,
};

describe("buildNewAppPlan", () => {
  it("実行順に8件を並べる", () => {
    const artifacts = buildNewAppPlan(spec());
    expect(artifacts.map((a) => a.kind)).toEqual([
      "repository",
      "port-band",
      "parent-issue",
      "init-issue",
      "vps-issue",
      "manual-vps",
      "manual-subpc",
      "manual-browser",
    ]);
  });

  it("自動で作れるものと手作業を色分けできる形で返す", () => {
    const byKind = Object.fromEntries(buildNewAppPlan(spec()).map((a) => [a.kind, a.automation]));
    expect(byKind["repository"]).toBe("auto");
    expect(byKind["vps-issue"]).toBe("auto");
    // サブPCだけが代行実行できる
    expect(byKind["manual-subpc"]).toBe("proxy");
    expect(byKind["manual-vps"]).toBe("manual");
    expect(byKind["manual-browser"]).toBe("manual");
    // ポート帯はissue-deckへのPRとして自動で作る（#2225）
    expect(byKind["port-band"]).toBe("auto");
  });

  it("払い出す帯が分かっていれば見出しに出し、分からなければ出さない", () => {
    const withBase = buildNewAppPlan(spec(), { localPortBase: 25000 }).find(
      (a) => a.kind === "port-band",
    );
    expect(withBase?.title).toContain("25000");
    const withoutBase = buildNewAppPlan(spec()).find((a) => a.kind === "port-band");
    expect(withoutBase?.title).not.toMatch(/\d/);
  });
});

describe("ポート帯のPull Request（#2225）", () => {
  it("Issue用のブランチ名（issue-<番号>）と紛れない名前にする", () => {
    expect(portBandBranchName(spec())).toBe("new-app-port-band/kakei-report");
  });

  it("PR本文はテンプレートの見出しを持ち、closesを使わない", () => {
    const body = buildPortBandPullRequestBody(spec(), 25000, REFS);
    expect(body).toContain("## 対応Issue");
    expect(body).toContain("## 実装内容");
    expect(body).toContain("## テスト内容");
    expect(body).toContain("## 確認方法");
    expect(body).toContain("## 注意点");
    expect(body).toContain(REFS.parent);
    expect(body).not.toContain("closes #");
    expect(body).not.toContain("fixes #");
  });

  it("タイトルと本文に払い出す帯を書く", () => {
    expect(buildPortBandPullRequestTitle(spec(), 25000)).toContain("25000");
    expect(buildPortBandPullRequestBody(spec(), 25000, REFS)).toContain("`25000`");
  });
});

describe("buildParentIssueBody", () => {
  const body = buildParentIssueBody(spec());

  it("決めごとの表を載せる", () => {
    expect(body).toContain("`guchi-apps/kakei-report`（private）");
    expect(body).toContain("https://kakei-report.gucchii.com/");
    expect(body).toContain("`3112`");
    expect(body).toContain("`app_kakei_report`");
  });

  it("どのサブIssueにも属さない2か所の一覧登録を持つ", () => {
    expect(body).toContain("docs/supported-repositories.md");
    expect(body).toContain("standards/tech-stack.md");
  });

  it("ポート帯はマージだけでは効かないことを書く（#2225）", () => {
    const withBase = buildParentIssueBody(spec(), { localPortBase: 25000 });
    expect(withBase).toContain("scripts/local-repo-ports.conf");
    expect(withBase).toContain("guchi-apps/kakei-report 25000");
    expect(withBase).toContain("更新して再起動");
  });
});

describe("buildInitIssueBody", () => {
  it("サブPCのローカルセッションで実装する前提と、その依存を書く", () => {
    const body = buildInitIssueBody(spec(), REFS);
    expect(body).toContain("## 前提条件");
    expect(body).toContain(REFS.subpc!);
    expect(body).toContain(REFS.portBandPullRequest!);
    expect(body).toContain("local-repos.conf");
    expect(body).toContain("盤面にも載りません");
  });

  it("種別に応じた共有ワークフローの入力を書く", () => {
    expect(buildInitIssueBody(spec(), REFS)).toContain("`runtime-setup: node-db`");
    expect(buildInitIssueBody(spec({ kind: "static" }), REFS)).toContain("`runtime-setup: minimal`");
  });

  it("DBを使う種別だけ db:migrate:deploy / db:seed:ci を求める", () => {
    expect(buildInitIssueBody(spec(), REFS)).toContain("db:seed:ci");
    expect(buildInitIssueBody(spec({ kind: "next", databaseName: null }), REFS)).not.toContain(
      "db:seed:ci",
    );
  });

  it("マルチエージェント運用に対応させないときは導入の節を出さない", () => {
    expect(buildInitIssueBody(spec({ multiAgent: false }), REFS)).not.toContain(
      "claude-issue-dispatch.yml を置く",
    );
  });
});

describe("buildVpsIssueBody", () => {
  it("サブドメインでは :80 のvhostを作り、-le-ssl.conf は作らない", () => {
    const body = buildVpsIssueBody(spec(), REFS);
    expect(body).toContain("apache/sites-available/kakei-report.gucchii.com.conf");
    expect(body).toContain("ProxyPass / http://127.0.0.1:3112/");
    expect(body).toContain("ここでは作りません");
  });

  it("certbot後の -le-ssl.conf の取り込みを2段目として残す", () => {
    const body = buildVpsIssueBody(spec(), REFS);
    expect(body).toContain("kakei-report.gucchii.com-le-ssl.conf");
    expect(body).toContain("新規（未取り込み）");
  });

  it("READMEのアプリ一覧に足す行を出す", () => {
    expect(buildVpsIssueBody(spec(), REFS)).toContain(
      "| kakei-report | 家計の月次推移をZaimのデータから作る | kakei-report.gucchii.com / 3112 | PM2 |",
    );
  });

  it("パス配置では既存vhostへの追記として書く", () => {
    const body = buildVpsIssueBody(spec({ urlMode: "path", basePath: "kakei-report" }), REFS);
    expect(body).toContain("既存の `gucchii.com` のVirtualHostへ");
    expect(body).toContain("ProxyPass /kakei-report http://127.0.0.1:3112/kakei-report");
  });

  it("実機を直接編集しないことと、マージが2回であることを書く", () => {
    const body = buildVpsIssueBody(spec(), REFS);
    expect(body).toContain("実機を直接編集しないでください");
    expect(body).toContain("マージは2回");
  });
});

describe("buildSubpcManualIssueBody", () => {
  const body = buildSubpcManualIssueBody(spec(), REFS);

  it("テンプレートの見出しをこの順で持つ", () => {
    const headings = body.match(/^## .+$/gm);
    expect(headings).toEqual([
      "## この作業でできるようになること",
      "## 前提条件",
      "## やること",
      "## 完了の確認方法",
      "## なぜエージェントが実施しないか",
      "## 関連",
    ]);
  });

  it("実行するデバイスがサブPCひとつに決まる", () => {
    const guide = parseManualStepGuide(body);
    expect(guide?.where.defaultDevice).toBe("サブPC");
  });

  it("すべての手順を手作業アシスタントが代行実行できる", () => {
    const plan = buildManualStepRunPlan(body, undefined, {
      host: READY_HOST,
      isManualStepIssue: true,
    });
    expect(plan.entries.every((entry) => entry.rejection === null)).toBe(true);
    expect(plan.blocked).toBe(0);
    expect(plan.runnable).toBeGreaterThanOrEqual(3);
  });

  it("値を埋め終えており、プレースホルダを残さない（残すと代行の対象から外れる）", () => {
    expect(body).not.toMatch(/<[^>]+>/);
    expect(body).toContain("guchi-apps/kakei-report /home/guchi/apps/kakei-report");
  });
});

describe("buildVpsManualIssueBody", () => {
  const body = buildVpsManualIssueBody(spec(), REFS);

  it("Gitで配れない実機の操作だけを書き、VirtualHostは書かない", () => {
    expect(body).toContain("sudo mkdir -p /apps/kakei-report");
    expect(body).toContain("CREATE DATABASE IF NOT EXISTS app_kakei_report");
    expect(body).toContain("pm2 save");
    expect(body).toContain("certbot --apache -d kakei-report.gucchii.com");
    expect(body).not.toContain("<VirtualHost");
  });

  it("certbotが作る設定ファイルをvpsのIssueへ戻す手順を持つ", () => {
    expect(body).toContain("kakei-report.gucchii.com-le-ssl.conf");
    expect(body).toContain(REFS.vps!);
  });

  it("実行するデバイスはVPSで、代行実行の対象にはしない", () => {
    expect(parseManualStepGuide(body)?.where.defaultDevice).toBe("VPS");
    const plan = buildManualStepRunPlan(body, undefined, {
      host: READY_HOST,
      isManualStepIssue: true,
    });
    expect(plan.runnable).toBe(0);
    expect(plan.entries.every((entry) => entry.rejection === "device_not_subpc")).toBe(true);
  });

  it("DBもポートも無い種別では、その手順を出さない", () => {
    const staticBody = buildVpsManualIssueBody(
      spec({ kind: "static", port: null, databaseName: null }),
      REFS,
    );
    expect(staticBody).not.toContain("CREATE DATABASE");
    expect(staticBody).not.toContain("pm2 save");
  });
});

describe("buildBrowserManualIssueBody", () => {
  const body = buildBrowserManualIssueBody(spec(), REFS);

  it("AレコードとGitHub App、そして2つの再同期を書く", () => {
    expect(body).toContain("Aレコード");
    expect(body).toContain("GitHub Appのインストール対象");
    expect(body).toContain("「リポジトリを再同期」→「Issueを再同期」");
  });

  it("マルチエージェント運用に対応させるときだけWORKFLOW_PATを求める", () => {
    expect(body).toContain("WORKFLOW_PAT");
    expect(buildBrowserManualIssueBody(spec({ multiAgent: false }), REFS)).not.toContain(
      "WORKFLOW_PAT",
    );
  });

  it("パス配置ではAレコードの手順を出さない", () => {
    const pathBody = buildBrowserManualIssueBody(
      spec({ urlMode: "path", basePath: "kakei-report" }),
      REFS,
    );
    expect(pathBody).not.toContain("Aレコードを追加");
  });

  it("実行するデバイスはブラウザ", () => {
    expect(parseManualStepGuide(body)?.where.defaultDevice).toBe("ブラウザ");
  });
});

describe("repositoryFullName", () => {
  it("organizationを前に付ける", () => {
    expect(repositoryFullName({ repositoryName: "kakei-report" })).toBe("guchi-apps/kakei-report");
  });
});
