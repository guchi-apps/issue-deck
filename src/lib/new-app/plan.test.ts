import { describe, expect, it } from "vitest";

import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";
import { buildManualStepRunPlan } from "@/lib/manual-step-autorun";
import { extractVerificationCommands } from "@/lib/manual-step-command";
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

const READY_HOST: Pick<DispatchHostView, "online" | "manualStepCapable" | "manualStepValuesCapable"> = {
  online: true,
  manualStepCapable: true,
  manualStepValuesCapable: true,
};

describe("buildNewAppPlan", () => {
  it("実行順に8件を並べ、ブラウザの手作業は要るときだけ足す（#2246）", () => {
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
    ]);
    expect(
      buildNewAppPlan(spec(), { githubAppNeedsRepositoryAdd: true }).map((a) => a.kind),
    ).toContain("manual-browser");
  });

  it("自動で作れるものと手作業を色分けできる形で返す", () => {
    const byKind = Object.fromEntries(buildNewAppPlan(spec()).map((a) => [a.kind, a.automation]));
    expect(byKind["repository"]).toBe("auto");
    expect(byKind["vps-issue"]).toBe("auto");
    expect(byKind["deploy-check-issue"]).toBe("auto");
    // サブPCだけが代行実行できる
    expect(byKind["manual-subpc"]).toBe("proxy");
    // VPSの受け入れもワークフローを流すだけになったので代行実行できる（#2246）
    expect(byKind["manual-vps"]).toBe("proxy");
    // ポート帯はissue-deckへのPRとして自動で作る（#2225）
    expect(byKind["port-band"]).toBe("auto");
  });

  // #2246。`app_port`が必須なので、ポートを持たない種別だけは実機の手順が残る
  it("常駐プロセスを持たない種別では、VPSの受け入れが代行実行できないまま残る", () => {
    const artifacts = buildNewAppPlan(spec({ kind: "static", port: null }));
    const vps = artifacts.find((a) => a.kind === "manual-vps");
    expect(vps?.automation).toBe("manual");
    expect(vps?.title).toContain("[手作業] VPS:");
  });

  it("払い出す帯が分かっていれば見出しに出し、分からなければ出さない", () => {
    const withBase = buildNewAppPlan(spec(), { localPortBase: 25000 }).find(
      (a) => a.kind === "port-band",
    );
    expect(withBase?.title).toContain("25000");
    const withoutBase = buildNewAppPlan(spec()).find((a) => a.kind === "port-band");
    expect(withoutBase?.title).not.toMatch(/\d/);
  });

  // #2248・#2246。押す前の一覧でも、空振りする手順を予告しない。中身が空振りだけになる
  // ときは、そもそも一覧に出さない
  it("ブラウザの手作業は、インストール対象への追加が要るときだけ一覧に出る", () => {
    const browser = (options?: Parameters<typeof buildNewAppPlan>[1]) =>
      buildNewAppPlan(spec(), options).find((a) => a.kind === "manual-browser");
    expect(browser()).toBeUndefined();
    expect(browser({ githubAppNeedsRepositoryAdd: true })?.description).toContain("GitHub App");
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

  it("typecheckにnext typegenを含めることを、npm scriptsごと書く（#2378）", () => {
    // `next build`は内部で型生成するため、ビルドは通るのに`typecheck`だけが落ちる
    const body = buildInitIssueBody(spec(), REFS, SCAFFOLD);
    expect(body).toContain('"typecheck": "next typegen && tsc --noEmit"');
    expect(body).toContain("Cannot find name 'LayoutProps'");
    // DBを使う種別だけ build:ci に prisma generate が要る
    expect(body).toContain('"build:ci": "prisma generate && next build"');
    expect(
      buildInitIssueBody(spec({ kind: "next", databaseName: null }), REFS, SCAFFOLD),
    ).toContain('"build:ci": "next build"');
  });

  it("packageManagerでpnpmの版を固定させる（#2378）", () => {
    // ci.yml・deploy.ymlのpnpm/action-setupもVPSのcorepackも、ここを見て版を決める
    const body = buildInitIssueBody(spec(), REFS, SCAFFOLD);
    expect(body).toContain('`"packageManager"`');
    expect(body).toContain("corepack use pnpm@latest");
  });

  it("pnpm-workspace.yamlを置けたときは、作り直さず承認し直す形で書く（#2378）", () => {
    const body = buildInitIssueBody(spec(), REFS, {
      ...SCAFFOLD,
      paths: [...SCAFFOLD.paths, "pnpm-workspace.yaml"],
    });
    expect(body).toContain("pnpm approve-builds");
    expect(body).toContain("このファイルを作り直さない");
    expect(body).toContain("終了コード0で素通りする");
    // 置けなかった回に、あるはずのファイルの話を書かない
    expect(buildInitIssueBody(spec(), REFS, SCAFFOLD)).not.toContain("pnpm approve-builds");
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

  it("リリースPRはrelease-develop-to-main.yml経由で作らせ、2回目にバンプが要ることを書く（#2378）", () => {
    // 初回デプロイの時点で`v<version>`のタグが切られるため、上げずに次を出すと
    // `Tag v0.1.0 already exists`でデプロイが止まる
    expect(body).toContain("`release-develop-to-main.yml` から作る");
    expect(body).toContain("gh workflow run release-develop-to-main.yml --repo guchi-apps/kakei-report");
    expect(body).toContain("2回目以降も同じ経路");
    expect(body).toContain("Tag v0.1.0 already exists");
    expect(body).toContain("version-tag-check.yml");
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

  // #2256。散文の確認では「登録されたか」を確かめられず、aide-botでは未実施のままcloseされた
  it("完了の確認方法を、手順ごとの検証コマンドにする（#2256）", () => {
    const commands = extractVerificationCommands(body).map((entry) => entry.command);
    // 手順の3つに加えて、#2246で手順を外した2つ（共通secret・ホスト名）の確認だけを引き取る
    expect(commands).toHaveLength(5);
    expect(commands[0]).toContain("test -d /home/guchi/apps/kakei-report/.git");
    expect(commands[1]).toContain("grep -F 'guchi-apps/kakei-report /home/guchi/apps/kakei-report'");
    // 投入と同じ引数に`--check`を足しただけの形。ずれると確かめていないフィールドが生まれる
    expect(commands[2]).toContain("--check");
    expect(commands[2]).toContain("--db-name app_kakei_report");
    expect(commands[2]).toContain("--copy-allowed-emails");
  });

  // #2246。登録の手順は外したが、`visibility`が`selected`へ戻されたときに黙って壊れないよう
  // 確認だけは残し、定期巡回が拾えるようにする
  it("登録を求めずに、共通secretとホスト名の確認だけを引き取る", () => {
    const commands = extractVerificationCommands(body).map((entry) => entry.command);
    expect(commands[3]).toContain("actions/organization-secrets");
    expect(commands[3]).toContain(
      "grep -cE '^(CLAUDE_CODE_OAUTH_TOKEN|OP_SERVICE_ACCOUNT_TOKEN|WORKFLOW_PAT)$'",
    );
    expect(commands[4]).toContain("dig +short kakei-report.gucchii.com A");
    // リポジトリごとの登録画面は案内しない（organizationの設定だけ、足りないときの逃げ道に残す）
    expect(body).not.toContain("github.com/guchi-apps/kakei-report/settings/secrets");
    expect(body).not.toContain("Aレコードを追加");
  });

  it("マルチエージェント運用に対応させないと、数える共通secretも減る", () => {
    const single = buildSubpcManualIssueBody(spec({ multiAgent: false }), REFS);
    const commands = extractVerificationCommands(single).map((entry) => entry.command);
    expect(commands[3]).toContain("grep -cE '^(OP_SERVICE_ACCOUNT_TOKEN)$'");
    expect(single).toContain("**`1` が出れば完了です。**");
  });

  it("パス配置ではホスト名の確認を出さない", () => {
    const pathBody = buildSubpcManualIssueBody(
      spec({ urlMode: "path", basePath: "kakei-report" }),
      REFS,
    );
    expect(extractVerificationCommands(pathBody)).toHaveLength(4);
  });

  it("確認コマンドまで手作業アシスタントが代行実行できる（#2256）", () => {
    const plan = buildManualStepRunPlan(body, undefined, {
      host: READY_HOST,
      isManualStepIssue: true,
    });
    const verifications = plan.entries.filter((entry) => entry.kind === "verification");
    expect(verifications).toHaveLength(5);
    expect(verifications.every((entry) => entry.rejection === null)).toBe(true);
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

describe("buildVpsManualIssueBody（ワークフローへ流す形・#2246）", () => {
  const body = buildVpsManualIssueBody(spec(), REFS);

  it("実機のコマンドではなく、vpsのプロビジョニングを流す手順にする", () => {
    expect(body).toContain("gh workflow run provision-app.yml --repo guchi-apps/vps");
    expect(body).toContain("-f app_name=kakei-report");
    expect(body).toContain("-f app_host=kakei-report.gucchii.com");
    expect(body).toContain("-f app_port=3112");
    expect(body).toContain("-f db_name=app_kakei_report");
    // 実機を直接叩く手順はもう出さない
    expect(body).not.toContain("sudo mkdir -p");
    expect(body).not.toContain("CREATE DATABASE");
    expect(body).not.toContain("certbot --apache");
    expect(body).not.toContain("<VirtualHost");
  });

  it("初回デプロイの前と後で2回流すことを書く（PM2の登録は後でしか進まない）", () => {
    const command = "gh workflow run provision-app.yml";
    const first = body.indexOf(command);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(body.indexOf(command, first + 1)).toBeGreaterThan(first);
    expect(body).toContain("初回デプロイの後");
  });

  it("certbotが作る設定ファイルをvpsのIssueへ戻す手順を持つ", () => {
    expect(body).toContain("リポジトリへ取り込む差分");
    expect(body).toContain("kakei-report.gucchii.com-le-ssl.conf");
    expect(body).toContain(REFS.vps!);
  });

  it("DNSのAレコードの登録を前提にしない（ワイルドカードで引ける）", () => {
    expect(body).toContain("guchi-apps/vps#131");
    expect(body).not.toContain("Aレコードを追加");
  });

  it("実行するデバイスはサブPCで、代行実行の対象になる", () => {
    expect(parseManualStepGuide(body)?.where.defaultDevice).toBe("サブPC");
    const plan = buildManualStepRunPlan(body, undefined, {
      host: READY_HOST,
      isManualStepIssue: true,
    });
    expect(plan.runnable).toBe(plan.entries.length);
    expect(plan.entries.every((entry) => entry.rejection === null)).toBe(true);
  });

  it("完了の確認方法を、手順ごとの検証コマンドにする（#2256）", () => {
    const commands = extractVerificationCommands(body).map((entry) => entry.command);
    // 直近の実行の成否・公開URLの疎通
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("gh run list --repo guchi-apps/vps");
    expect(commands[0]).toContain("grep -x success");
    expect(commands[1]).toContain("curl -fsS");
  });

  it("DBを持たない種別では db_name を渡さない", () => {
    const noDb = buildVpsManualIssueBody(spec({ kind: "next", databaseName: null }), REFS);
    expect(noDb).toContain("-f app_name=kakei-report");
    expect(noDb).not.toContain("-f db_name=");
  });
});

describe("buildVpsManualIssueBody（実機の手順が残る形・#2246）", () => {
  // `app_port`が必須なので、ポートを持たない種別だけはワークフローを使えない
  const staticBody = buildVpsManualIssueBody(
    spec({ kind: "static", port: null, databaseName: null }),
    REFS,
  );

  it("実機の手順を出し、デバイスはVPSのままにする", () => {
    expect(staticBody).toContain("sudo mkdir -p /home/github-user/apps/kakei-report");
    expect(staticBody).toContain("certbot --apache -d kakei-report.gucchii.com");
    expect(parseManualStepGuide(staticBody)?.where.defaultDevice).toBe("VPS");
  });

  it("控える前に :443 の X-Forwarded-Proto を https へ直す手順を持つ", () => {
    expect(staticBody).toContain(
      "sudo sed -i 's/X-Forwarded-Proto \"http\"/X-Forwarded-Proto \"https\"/'",
    );
    expect(staticBody).toContain("sudo apachectl configtest && sudo systemctl reload apache2");
    // 控えた内容がそのまま取り込まれるため、直す手順はcatより前に無いと意味がない
    expect(staticBody.indexOf("X-Forwarded-Proto")).toBeLessThan(staticBody.indexOf("sudo cat"));
  });

  it("DBもポートも無いので、その手順と確認を出さない（#2256）", () => {
    expect(staticBody).not.toContain("CREATE DATABASE");
    expect(staticBody).not.toContain("pm2 save");
    const commands = extractVerificationCommands(staticBody).map((entry) => entry.command);
    expect(commands).toHaveLength(3);
    expect(commands.some((command) => command.includes("SHOW DATABASES"))).toBe(false);
    expect(commands.some((command) => command.includes("pm2 describe"))).toBe(false);
  });
});

describe("buildBrowserManualIssueBody（GitHub Appの追加だけ・#2246）", () => {
  const body = buildBrowserManualIssueBody(spec(), {
    ...REFS,
    githubAppNeedsRepositoryAdd: true,
  });

  it("インストール対象への追加だけを書く", () => {
    expect(body).toContain("GitHub Appのインストール対象");
    expect(body).toContain("settings/installations");
    expect(parseManualStepGuide(body)?.steps.length).toBe(1);
  });

  // #2246。`*.gucchii.com`のワイルドカードで引けるため、アプリごとの登録は空振りになる
  it("DNSのAレコードの登録を書かない", () => {
    expect(body).not.toContain("Aレコードを追加");
    expect(body).not.toContain("VPS管理画面");
    // 「要らない」ことは残す（読んだ人が別のIssueを立て直さないように）
    expect(body).toContain("登録は要りません");
  });

  // #2246。organizationに`visibility=all`で入っているため、リポジトリごとの登録は空振りになる
  it("Actions secretsの登録を書かない", () => {
    expect(body).not.toContain("settings/secrets/actions");
    expect(body).not.toContain("WORKFLOW_PAT");
  });

  // #2248。立ち上げ自身が取り込むようになったので、人が押す手順にはしない
  it("2つの再同期は書かない", () => {
    expect(body).not.toContain("リポジトリを再同期");
    expect(body).not.toContain("Issueを再同期");
  });

  it("SignalyのWebhook URLはorganization secretから来るため、チャンネル作成・登録を求めない（#2255）", () => {
    expect(body).not.toContain("Signaly");
    expect(body).not.toContain("provision-app-secrets.sh");
    expect(body).not.toContain("--ci-webhook-url");
  });

  it("完了の確認方法を、手順ごとの検証コマンドにする（#2256）", () => {
    const commands = extractVerificationCommands(body).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("gh api repos/guchi-apps/kakei-report/installation");
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

describe("体裁と運用の決めごと（#2254）", () => {
  it("親Issueと初期化Issueの表に体裁の行が並ぶ", () => {
    const body = buildParentIssueBody(spec());
    expect(body).toContain("| 表示名 | 家計レポート（`title` / `applicationName` / `appleWebApp.title`） |");
    expect(body).toContain("| PWA | 対応する（オフラインは対応しない） |");
    expect(body).toContain("| 更新履歴 | 持つ |");
    expect(body).toContain("| CI撮影の認証バイパス | 用意する |");
    expect(buildInitIssueBody(spec(), REFS)).toContain("| アイコン・テーマカラー | 暫定で始める（`#0f172a`） |");
  });

  it("VirtualHostと疎通確認のIssueには体裁の行を出さない", () => {
    expect(buildVpsIssueBody(spec(), REFS)).not.toContain("| PWA |");
    expect(buildDeployCheckIssueBody(spec(), REFS)).not.toContain("| 更新履歴 |");
  });

  it("認証が無ければ撮影バイパスは「不要」になり、初期化Issueにも項目が出ない", () => {
    const noAuth = spec({ auth: "none" });
    expect(buildParentIssueBody(noAuth)).toContain("| CI撮影の認証バイパス | 不要（認証なし） |");
    expect(buildInitIssueBody(noAuth, REFS)).not.toContain("CI撮影の認証バイパスを用意する");
  });

  it("初期化Issueの「やること」に体裁の項目が入る", () => {
    const body = buildInitIssueBody(spec(), REFS);
    expect(body).toContain("- [ ] 表示名を `家計レポート` にする");
    expect(body).toContain("**オフライン対応（Service Worker）は入れない**");
    expect(body).toContain("- [ ] アイコンは暫定（テーマカラー1色）で置いて始める");
    expect(body).toContain("`RELEASE_CHANGELOG`");
    expect(body).toContain("- [ ] CI撮影の認証バイパスを用意する");
  });

  it("やらないと決めたものは「やること」に並べない", () => {
    const body = buildInitIssueBody(
      spec({ pwa: false, changelog: false, screenshotBypass: false }),
      REFS,
    );
    expect(body).not.toContain("PWA対応の一式を置く");
    expect(body).not.toContain("更新履歴（changelog）を持たせる");
    expect(body).not.toContain("CI撮影の認証バイパスを用意する");
    // 決めた事実そのものは表に残る
    expect(body).toContain("| PWA | 対応しない |");
    expect(body).toContain("| 更新履歴 | 持たない（バージョンだけが上がる） |");
  });

  it("アイコンを暫定にしたときだけ、親Issueに「後で決めること」が出る", () => {
    expect(buildParentIssueBody(spec())).toContain("## 後で決めること");
    expect(buildParentIssueBody(spec())).toContain(
      "- [ ] アイコンとテーマカラー（暫定で `#0f172a` の1色で始めています）を決めて差し替える",
    );
    expect(buildParentIssueBody(spec({ iconPlan: "prepared" }))).not.toContain("## 後で決めること");
    expect(buildParentIssueBody(spec({ pwa: false }))).not.toContain("## 後で決めること");
  });

  it("暫定のアイコンは完了条件に混ぜない（暫定でも公開はできる）", () => {
    const body = buildParentIssueBody(spec());
    const conditions = body.slice(body.indexOf("## 完了条件"), body.indexOf("## 後で決めること"));
    expect(conditions).not.toContain("アイコン");
  });

  it("`runtime-setup: minimal` では無人撮影が成立しないことを断って書く", () => {
    const fastapi = spec({ kind: "fastapi", port: 8003, auth: "fastapi-google" });
    expect(buildParentIssueBody(fastapi)).toContain(
      "| CI撮影の認証バイパス | 用意する（`runtime-setup: minimal` のため無人撮影は成立せず、ローカル実行専用） |",
    );
    const init = buildInitIssueBody(fastapi, REFS);
    expect(init).toContain("`24.screenshot-required` は無人実行では成立しない");
    // Next.js（`node-db`）ではこれまでどおり成立する
    expect(buildInitIssueBody(spec(), REFS)).toContain(
      "**これが無いと `24.screenshot-required` が成立しない**",
    );
  });

  it("Python系では npm の lifecycle ではなく bump_version.py を案内する", () => {
    const body = buildInitIssueBody(spec({ kind: "fastapi", port: 8003 }), REFS);
    expect(body).toContain("scripts/bump_version.py");
    expect(body).not.toContain("`\"version\"` lifecycleスクリプト");
  });
});
