import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { extractWorkflowTagRef } from "@/lib/workflow-tags";
import {
  buildScaffoldFiles,
  scaffoldCopies,
  scaffoldPathList,
  type ScaffoldFile,
} from "@/lib/new-app/scaffold";
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

const TAG = "workflows/v25";

function filesOf(target: NewAppSpec, workflowTag: string | null = TAG): Map<string, ScaffoldFile> {
  return new Map(buildScaffoldFiles(target, { workflowTag }).map((file) => [file.path, file]));
}

function content(target: NewAppSpec, path: string, workflowTag: string | null = TAG): string {
  const file = filesOf(target, workflowTag).get(path);
  if (!file) throw new Error(`${path} が雛形にありません`);
  return file.content;
}

describe("buildScaffoldFiles", () => {
  it("盤面へ載る条件（claude-issue-dispatch.yml）を最初のコミットに含める", () => {
    expect(filesOf(spec()).has(".github/workflows/claude-issue-dispatch.yml")).toBe(true);
  });

  it("参照タグを決められなければcallerを1枚も置かない（存在しないタグを指すと全イベントが失敗する）", () => {
    const paths = [...filesOf(spec(), null).keys()];
    expect(paths.filter((path) => path.startsWith(".github/workflows/"))).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
    ]);
  });

  it("マルチエージェント運用に対応させないときは、進捗・無人実行のcallerを置かない", () => {
    const paths = [...filesOf(spec({ multiAgent: false })).keys()];
    expect(paths).not.toContain(".github/workflows/claude-issue-dispatch.yml");
    expect(paths).not.toContain(".github/workflows/issue-labels.yml");
    // シークレット同期は運用形態に依存しないので残す
    expect(paths).toContain(".github/workflows/sync-secrets.yml");
  });

  it("すべてのcallerで uses: のタグと prompts-ref が一致する", () => {
    const callers = [...filesOf(spec()).entries()].filter(([path]) =>
      path.startsWith(".github/workflows/"),
    );
    const refs = callers
      .map(([path, file]) => extractWorkflowTagRef(path, file.content))
      .filter((ref) => ref !== null);
    // ci.yml・deploy.yml は共有ワークフローを参照しないので出てこない
    expect(refs.length).toBe(5);
    for (const ref of refs) {
      expect(ref!.uses).toBe(TAG);
      if (ref!.promptsRef !== null) expect(ref!.promptsRef).toBe(TAG);
    }
    expect(
      refs.find((ref) => ref!.file === ".github/workflows/claude-issue-dispatch.yml")!.promptsRef,
    ).toBe(TAG);
  });

  it("テンプレートリテラルの補間が文字列として漏れない", () => {
    // YAMLの`${{ }}`とシェルの`${VAR}`は正しい出力なので、TS側の識別子だけを見張る
    for (const file of buildScaffoldFiles(spec(), { workflowTag: TAG })) {
      expect(file.content, file.path).not.toMatch(/\$\{(?:spec|target|profile|options)\b/);
    }
  });
});

describe("deploy.yml（#2247。aide-botで踏んだ2件を雛形の側で潰す）", () => {
  it("待受ポートを vars.PORT ではなく平文で持つ（guchi-apps/aide-bot#5）", () => {
    const deploy = content(spec(), ".github/workflows/deploy.yml");
    expect(deploy).not.toContain("vars.PORT");
    expect(deploy).toContain("PORT=3112");
  });

  it("配布物とクリーンアップの対象が食い違わない", () => {
    const deploy = content(spec(), ".github/workflows/deploy.yml");
    const archive = /tar -czf deploy\.tar\.gz \\\n([\s\S]*?)\n\n/.exec(deploy)?.[1] ?? "";
    const packed = archive
      .split("\n")
      .map((line) => line.replace(/\s|\\/g, ""))
      .filter((line) => line !== "" && !line.startsWith("scripts/"));
    const cleanup = /rm -rf (.+)/.exec(deploy)?.[1]?.split(" ") ?? [];
    expect(cleanup.sort()).toEqual(packed.sort());
  });

  it("DBを使う種別だけマイグレーションとDATABASE_URLの組み立てを持つ", () => {
    const withDb = content(spec(), ".github/workflows/deploy.yml");
    expect(withDb).toContain("prisma migrate deploy");
    expect(withDb).toContain("scripts/construct-database-url.sh");

    const withoutDb = content(
      spec({ kind: "next", databaseName: null }),
      ".github/workflows/deploy.yml",
    );
    expect(withoutDb).not.toContain("prisma migrate deploy");
    expect(withoutDb).not.toContain("scripts/construct-database-url.sh");
    expect(withoutDb).not.toContain("SHARED_DB_HOST");
  });

  it("公開URLの疎通を確認するが、deployジョブの成否にはしない（#2252から引き継ぎ）", () => {
    const deploy = content(spec(), ".github/workflows/deploy.yml");
    expect(deploy).toContain("https://kakei-report.gucchii.com/");
    expect(deploy).toContain("::warning::");
    const step = /- name: 公開URLの疎通を確認する（警告のみ）\n([\s\S]*?)\n\n/.exec(deploy)?.[1] ?? "";
    expect(step).toContain("continue-on-error: true");
  });

  it("SSH先へ渡す envs: と env: の名前がそろっている（ここに無い変数はSSH先に存在しない）", () => {
    const deploy = content(spec(), ".github/workflows/deploy.yml");
    const block = /- name: Deploy and restart\n([\s\S]*?)\n          script: \|/.exec(deploy)?.[1] ?? "";
    const declared = [...block.matchAll(/^ {10}([A-Z_]+): \$\{\{ env\./gm)].map((m) => m[1]);
    const passed = (/envs: (.+)/.exec(block)?.[1] ?? "").split(",");
    expect(passed.sort()).toEqual(declared.sort());
  });
});

describe("prisma.config.ts（guchi-apps/aide-bot#9）", () => {
  it("loadEnv に quiet: true を必ず含める", () => {
    expect(content(spec(), "prisma.config.ts")).toContain("quiet: true");
  });

  it("DBを使わない種別と、Prismaを使わない種別（FastAPI）では置かない", () => {
    expect(filesOf(spec({ kind: "next", databaseName: null })).has("prisma.config.ts")).toBe(false);
    expect(filesOf(spec({ kind: "fastapi" })).has("prisma.config.ts")).toBe(false);
  });
});

describe("deploy/ecosystem.config.js", () => {
  it("既定の env も本番と同じ値にする（PM2の resurrect で 503 になるのを防ぐ。#2259）", () => {
    const config = content(spec(), "deploy/ecosystem.config.js");
    expect(config).not.toContain('NODE_ENV: "development"');
    expect([...config.matchAll(/PORT: process\.env\.PORT \|\| 3112/g)]).toHaveLength(2);
  });
});

describe(".github/secrets-manifest.tsv", () => {
  const rows = (target: NewAppSpec) =>
    content(target, ".github/secrets-manifest.tsv")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => line.split("\t"));

  it("列は5つで、scopeがrepoの行はSOURCEを必ず持つ（guchi-apps/aide-bot#5）", () => {
    for (const row of rows(spec())) {
      expect(row).toHaveLength(5);
      if (row[1] === "repo") expect(row[4]).not.toBe("-");
      if (row[1] === "inherit") expect(row[4]).toBe("-");
    }
  });

  it("1Passwordの参照先はアプリ名のアイテムに揃える", () => {
    const repoRows = rows(spec()).filter((row) => row[1] === "repo");
    expect(repoRows.length).toBeGreaterThan(0);
    for (const row of repoRows) expect(row[4]).toMatch(/^op:\/\/apps\/kakei-report\//);
  });

  it("DBも認証も無い種別では、その行を出さない", () => {
    const keys = rows(spec({ kind: "static", port: null, databaseName: null, auth: "none" })).map(
      (row) => row[0],
    );
    expect(keys).not.toContain("DB_NAME");
    expect(keys).not.toContain("ALLOWED_GOOGLE_EMAILS");
    expect(keys).toContain("SIGNALY_WEBHOOK_URL");
  });
});

describe("PWA・更新履歴の受け皿（#2254）", () => {
  it("Next.js系では manifest・アイコン・changelog を置く", () => {
    const paths = [...filesOf(spec()).keys()];
    expect(paths).toContain("src/app/manifest.ts");
    expect(paths).toContain("public/icon.svg");
    expect(paths).toContain("src/lib/changelog.ts");
  });

  it("Next.js以外では置かない（src/ を持たないため）", () => {
    const paths = [...filesOf(spec({ kind: "static", port: null, databaseName: null })).keys()];
    expect(paths).not.toContain("src/app/manifest.ts");
    expect(paths).not.toContain("src/lib/changelog.ts");
  });

  it("更新履歴は空で始め、追記の仕組み（scripts/version-changelog.mjs）を指す", () => {
    expect(content(spec(), "src/lib/changelog.ts")).toContain(
      "export const APP_CHANGELOG: ChangelogEntry[] = [];",
    );
    expect(content(spec(), "src/lib/changelog.ts")).toContain("scripts/version-changelog.mjs");
    expect(scaffoldPathList(spec(), { workflowTag: TAG })).toContain(
      "scripts/version-changelog.mjs",
    );
  });
});

describe("scaffoldCopies（issue-deckの実物をそのまま配る）", () => {
  const targets = [
    spec(),
    spec({ kind: "next", databaseName: null }),
    spec({ kind: "static", port: null, databaseName: null, auth: "none" }),
    spec({ kind: "fastapi" }),
  ];

  it("配布元がissue-deckに実在する", () => {
    for (const target of targets) {
      for (const copy of scaffoldCopies(target)) {
        expect(existsSync(join(process.cwd(), copy.source)), copy.source).toBe(true);
      }
    }
  });

  it("実行ビットの指定が配布元と一致する", () => {
    for (const copy of scaffoldCopies(spec())) {
      const executable = (statSync(join(process.cwd(), copy.source)).mode & 0o111) !== 0;
      expect(Boolean(copy.executable), copy.source).toBe(executable);
    }
  });

  it("書き換えの目印が配布元に実在する（消えたら写しが黙って壊れる）", () => {
    for (const copy of scaffoldCopies(spec())) {
      if (!copy.rewrite) continue;
      const source = readFileSync(join(process.cwd(), copy.source), "utf8");
      expect(source, copy.source).toContain(copy.rewrite.anchor);
      expect(copy.rewrite.replacement(spec())).toContain("guchi-apps/kakei-report");
    }
  });

  it("deploy.ymlが実行時に読むスクリプトを必ず配る（無いと初回デプロイがその場で落ちる）", () => {
    const paths = scaffoldCopies(spec()).map((copy) => copy.path);
    expect(paths).toContain("scripts/update-env-file.sh");
    expect(paths).toContain("scripts/construct-database-url.sh");
    expect(paths).toContain(".github/scripts/signaly-notify.sh");
  });

  it("sync-secrets.yml が読むスクリプトと対応表がそろう", () => {
    const paths = scaffoldPathList(spec(), { workflowTag: TAG });
    expect(paths).toContain(".github/workflows/sync-secrets.yml");
    expect(paths).toContain("scripts/sync-github-secrets.sh");
    expect(paths).toContain(".github/secrets-manifest.tsv");
  });
});

describe("生成したワークフローが「Invalid workflow file」にならないこと", () => {
  // 式として解釈できない `${{ ... }}` が1つでもあると、そのファイルはpushのたびに失敗runを
  // 積み、トリガーが一切発火しなくなる（#2181）。issue-deck自身のワークフローに使っている
  // 検査スクリプトを、生成したcallerにもそのまま通す。
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const kinds: NewAppSpec["kind"][] = ["next-db", "next", "fastapi", "static"];

  it.each(kinds)("%s の雛形が式の構文検査を通る", (kind) => {
    const target = spec(
      kind === "next-db"
        ? {}
        : kind === "next"
          ? { kind, databaseName: null, auth: "none" }
          : kind === "fastapi"
            ? { kind, port: 8004 }
            : { kind, port: null, databaseName: null, auth: "none" },
    );
    const dir = mkdtempSync(join(tmpdir(), `scaffold-${kind}-`));
    dirs.push(dir);
    let written = 0;
    for (const file of buildScaffoldFiles(target, { workflowTag: TAG })) {
      if (!file.path.startsWith(".github/workflows/")) continue;
      writeFileSync(join(dir, file.path.slice(".github/workflows/".length)), file.content);
      written += 1;
    }
    expect(written).toBeGreaterThan(0);

    expect(() =>
      execFileSync("node", [join(process.cwd(), "scripts/check-workflow-expression-syntax.mjs"), dir], {
        encoding: "utf-8",
      }),
    ).not.toThrow();
  });
});
