import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { buildManualStepRunPlan } from "@/lib/manual-step-autorun";
import { parseManualStepGuide } from "@/lib/manual-step-guide";
import {
  buildBrowserManualIssueBody,
  buildDeployCheckIssueBody,
  buildDeployCheckIssueTitle,
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
  vpsManual: "guchi-apps/issue-deck#2205",
  init: "guchi-apps/kakei-report#1",
  localPortBase: 25000,
  portBandPullRequest: "guchi-apps/issue-deck#2204",
};

const READY_HOST: Pick<DispatchHostView, "online" | "manualStepCapable"> = {
  online: true,
  manualStepCapable: true,
};

describe("buildNewAppPlan", () => {
  it("実行順に9件を並べる", () => {
    const artifacts = buildNewAppPlan(spec());
    expect(artifacts.map((a) => a.kind)).toEqual([
      "repository",
      "port-band",
      "parent-issue",
      "init-issue",
      "deploy-check-issue",
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
    expect(byKind["deploy-check-issue"]).toBe("auto");
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

  // #2248。押す前の一覧でも、空振りする手順を予告しない
  it("ブラウザの手作業の説明は、インストール対象への追加が要るときだけGitHub Appに触れる", () => {
    const description = (options?: Parameters<typeof buildNewAppPlan>[1]) =>
      buildNewAppPlan(spec(), options).find((a) => a.kind === "manual-browser")?.description ?? "";
    expect(description()).not.toContain("GitHub App");
    expect(description({ githubAppNeedsRepositoryAdd: true })).toContain("GitHub App");
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

  it("完了条件を公開URLのcurlで判定する（#2252）", () => {
    expect(body).toContain("## 完了条件");
    expect(body).toContain("`curl -I https://kakei-report.gucchii.com/` が 200 か 3xx を返す");
    expect(body).toContain("公開できたことにはなりません");
    expect(body).toContain("http://127.0.0.1:<ポート>/");
  });

  it("どのサブIssueにも属さない2か所の一覧登録を持つ", () => {
    expect(body).toContain("docs/supported-repositories.md");
    expect(body).toContain("standards/tech-stack.md");
  });

  it("初期化は盤面から無人実行で始められると書く（#2247）", () => {
    const body = buildParentIssueBody(spec());
    expect(body).toContain("盤面から無人実行で始められます");
    expect(body).toContain("初期化Issueは待ちません");
  });

  it("ポート帯はマージだけでは効かないことを書く（#2225）", () => {
    const withBase = buildParentIssueBody(spec(), { localPortBase: 25000 });
    expect(withBase).toContain("scripts/local-repo-ports.conf");
    expect(withBase).toContain("guchi-apps/kakei-report 25000");
    expect(withBase).toContain("更新して再起動");
  });
});

describe("buildInitIssueBody", () => {
  const SCAFFOLD = {
    paths: [
      ".env.example",
      ".github/scripts/signaly-notify.sh",
      ".github/secrets-manifest.tsv",
      ".github/workflows/ci.yml",
      ".github/workflows/claude-issue-dispatch.yml",
      ".github/workflows/deploy.yml",
      "deploy/ecosystem.config.js",
      "prisma.config.ts",
      "src/app/manifest.ts",
    ],
    workflowTag: "workflows/v25",
  };

  it("雛形が置けていれば、盤面から無人実行で回せると書く（#2247）", () => {
    const body = buildInitIssueBody(spec(), REFS, SCAFFOLD);
    expect(body).toContain("## 前提条件");
    expect(body).toContain("先に完了している必要があるIssue・PR: なし");
    expect(body).toContain("無人実行で実装できます");
    expect(body).toContain("## すでに置かれているもの");
    expect(body).toContain("`.github/workflows/claude-issue-dispatch.yml`");
    expect(body).toContain("workflows/v25");
    // 置いてあるものを作り直させない
    expect(body).not.toContain("`.github/workflows/ci.yml` を作る");
    expect(body).not.toContain("`deploy/ecosystem.config.js` を作る");
    expect(body).not.toContain("`.github/secrets-manifest.tsv` を作る");
  });

  it("callerだけ置けなかったときは、その理由を書いてローカルセッション前提に切り替える", () => {
    const body = buildInitIssueBody(spec(), REFS, {
      paths: [".github/workflows/ci.yml", "CLAUDE.md"],
      workflowTag: null,
    });
    expect(body).toContain("無人実行のcaller（`claude-issue-dispatch.yml`）を置けなかったため");
    expect(body).toContain("## すでに置かれているもの");
    expect(body).not.toContain("`.github/workflows/ci.yml` を作る");
  });

  it("マルチエージェント運用に対応させないときは、そのことを理由として書く", () => {
    const body = buildInitIssueBody(spec({ multiAgent: false }), REFS, {
      paths: [".github/workflows/ci.yml"],
      workflowTag: null,
    });
    expect(body).toContain("マルチエージェント運用に対応させない選択のため");
  });

  it("雛形を置けなかったときは、従来どおりサブPCのローカルセッション前提で書く", () => {
    const body = buildInitIssueBody(spec(), REFS);
    expect(body).toContain("## 前提条件");
    expect(body).toContain(REFS.subpc!);
    expect(body).toContain(REFS.portBandPullRequest!);
    expect(body).toContain("local-repos.conf");
    expect(body).toContain("盤面にも載りません");
    expect(body).toContain("`.github/workflows/ci.yml` を作る");
    expect(body).not.toContain("## すでに置かれているもの");
  });

  it("種別に応じた共有ワークフローの入力を書く（雛形を置けなかった場合）", () => {
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

  it("Next.js系ではPWAと更新履歴の残りだけを人へ渡す（#2254の受け皿）", () => {
    const body = buildInitIssueBody(spec(), REFS, SCAFFOLD);
    expect(body).toContain("viewport.themeColor");
    expect(body).toContain("apple-icon.png");
    expect(body).toContain("version-changelog.mjs");
  });
});

describe("buildDeployCheckIssueBody（#2252）", () => {
  const body = buildDeployCheckIssueBody(spec(), REFS);

  it("deployジョブの成功では公開を確かめられないことを書く", () => {
    expect(body).toContain("公開できたことにはなりません");
    expect(body).toContain("http://127.0.0.1:3112/");
    expect(body).toContain("guchi-apps/vps#128");
  });

  it("初期化・VirtualHost・VPSの手作業を前提条件に並べる", () => {
    expect(body).toContain("## 前提条件");
    expect(body).toContain(REFS.init!);
    expect(body).toContain(REFS.vps!);
    expect(body).toContain(REFS.vpsManual!);
  });

  it("サブPCのローカルセッションで実装する理由を書く", () => {
    expect(body).toContain("initial-deploy-check");
    expect(body).toContain("無人実行からは読めません");
  });

  it("完了の確認方法を公開URLのcurlにする", () => {
    expect(body).toContain("## 完了の確認方法");
    expect(body).toContain("curl -I https://kakei-report.gucchii.com/");
    expect(body).toContain("200 か 3xx");
  });

  it("種別に応じてDBとプロセスの確認を出し分ける", () => {
    expect(body).toContain("`app_kakei_report` のデータベース");
    expect(body).toContain("PM2に `kakei-report` が登録され");
    const staticBody = buildDeployCheckIssueBody(
      spec({ kind: "static", port: null, databaseName: null }),
      REFS,
    );
    expect(staticBody).not.toContain("のデータベース");
    expect(staticBody).not.toContain("PM2に");
    expect(staticBody).toContain("http://127.0.0.1:<ポート>/");
  });

  it("タイトルにアプリ名を出す", () => {
    expect(buildDeployCheckIssueTitle(spec())).toBe("家計レポートの初回デプロイ前チェックと公開確認");
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

  it("2段目に :443 の X-Forwarded-Proto を確かめてから取り込む旨を書く", () => {
    const body = buildVpsIssueBody(spec(), REFS);
    expect(body).toContain("X-Forwarded-Proto");
    expect(body).toContain('`"https"` になっていること');
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

  it("無人実行の妨げにはならないこと、同期がこの時点で終わることを書く（#2247）", () => {
    expect(body).toContain("無人実行は雛形のcallerで動くため");
    expect(body).toContain("GitHubのsecretへの同期もこの時点で終わります");
    expect(body).not.toContain("初期化Issueでこのマニフェストを作ってマージした後");
  });

  it("機械的に定まる値を、そのまま貼れる1コマンドで投入する（#2249）", () => {
    expect(body).toContain("provision-app-secrets.sh");
    expect(body).toContain("--repo guchi-apps/kakei-report");
    expect(body).toContain("--db-name app_kakei_report");
    expect(body).toContain("--copy-allowed-emails");
    // フィールド名の羅列に戻さない（aide-botの立ち上げで未登録のまま本番デプロイが失敗した）
    expect(body).not.toContain("db-name = app_kakei_report");
  });

  it("DBも認証も無いアプリでは、そのオプションを渡さない", () => {
    const plain = buildSubpcManualIssueBody(
      spec({ kind: "static", port: null, databaseName: null, auth: "none" }),
      REFS,
    );
    expect(plain).toContain("provision-app-secrets.sh");
    expect(plain).not.toContain("--db-name");
    expect(plain).not.toContain("--copy-allowed-emails");
  });
});

describe("buildVpsManualIssueBody", () => {
  const body = buildVpsManualIssueBody(spec(), REFS);

  it("Gitで配れない実機の操作だけを書き、VirtualHostは書かない", () => {
    // 実機の配置先は `/apps/<name>` ではない（#2246・#2249。target-dirと同じパスにする）
    expect(body).toContain("sudo mkdir -p /home/github-user/apps/kakei-report");
    expect(body).toContain("CREATE DATABASE IF NOT EXISTS app_kakei_report");
    expect(body).toContain("pm2 save");
    expect(body).toContain("certbot --apache -d kakei-report.gucchii.com");
    expect(body).not.toContain("<VirtualHost");
  });

  it("certbotが作る設定ファイルをvpsのIssueへ戻す手順を持つ", () => {
    expect(body).toContain("kakei-report.gucchii.com-le-ssl.conf");
    expect(body).toContain(REFS.vps!);
  });

  it("控える前に :443 の X-Forwarded-Proto を https へ直す手順を持つ", () => {
    expect(body).toContain(
      "sudo sed -i 's/X-Forwarded-Proto \"http\"/X-Forwarded-Proto \"https\"/'",
    );
    expect(body).toContain("sudo apachectl configtest && sudo systemctl reload apache2");
    // 控えた内容がそのまま取り込まれるため、直す手順はcatより前に無いと意味がない
    expect(body.indexOf("X-Forwarded-Proto")).toBeLessThan(body.indexOf("sudo cat"));
  });

  it("認証を持たない種別でも X-Forwarded-Proto の手順を出す", () => {
    const staticBody = buildVpsManualIssueBody(
      spec({ kind: "static", port: null, databaseName: null }),
      REFS,
    );
    expect(staticBody).toContain("X-Forwarded-Proto");
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

  it("Aレコードを書く", () => {
    expect(body).toContain("Aレコード");
  });

  // #2248。立ち上げ自身が取り込むようになったので、人が押す手順にはしない
  it("2つの再同期は書かない", () => {
    expect(body).not.toContain("リポジトリを再同期");
    expect(body).not.toContain("Issueを再同期");
  });

  // #2248。`repository_selection=all`では新しいリポジトリが自動で対象に入る
  it("インストール対象への追加は、selectedのときだけ書く", () => {
    expect(body).not.toContain("GitHub Appのインストール対象");
    const selected = buildBrowserManualIssueBody(spec(), {
      ...REFS,
      githubAppNeedsRepositoryAdd: true,
    });
    expect(selected).toContain("GitHub Appのインストール対象");
    expect(selected).toContain("settings/installations");
  });

  it("SignalyのWebhook URLはorganization secretから来るため、チャンネル作成・登録を求めない（#2255）", () => {
    expect(body).not.toContain("Signaly");
    expect(body).not.toContain("provision-app-secrets.sh");
    expect(body).not.toContain("--ci-webhook-url");
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

  // 手順の並びが崩れると、画面の手作業アシスタントが手順を読み落とす
  it("どちらの形でも手順として読める（selectedのときは1つ増える）", () => {
    const steps = (refs: NewAppIssueRefs) =>
      parseManualStepGuide(buildBrowserManualIssueBody(spec(), refs))?.steps.length ?? 0;
    // DNS・Actions secrets（#2255でSignalyのチャンネル作成・webhook投入を削除）
    expect(steps(REFS)).toBe(2);
    expect(steps({ ...REFS, githubAppNeedsRepositoryAdd: true })).toBe(3);
  });
});

describe("repositoryFullName", () => {
  it("organizationを前に付ける", () => {
    expect(repositoryFullName({ repositoryName: "kakei-report" })).toBe("guchi-apps/kakei-report");
  });
});
