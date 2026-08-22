// `.github/workflows/reusable-version-tag-check.yml` の `deploy-config-check` ジョブを、
// 仮のリポジトリを作って実行する（#2135）。
//
// **このジョブの価値は「本番でしか露見しない設定漏れを、main宛PRで落とす」ことにある。**
// 落ちるべきときに落ちるかは、実際に走らせないと確かめられない。検査本体のPythonは
// 再利用可能ワークフローがcaller側リポジトリをcheckoutする都合でYAMLへ直接書いてあるため、
// ここではYAMLから `run:` 本文を取り出し、Actionsと同じ既定シェル（`bash -e`）で動かす。
//
// **もう一つの目的は誤検知を出さないこと。** 既に14リポジトリへ配ってある
// `version-tag-check.yml` の参照タグを上げた瞬間に効き始めるため、誤検知はそのまま
// 全リポジトリのmain宛PRを止める。実在の `deploy.yml` と同じ形が通ることも確かめる。

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/reusable-version-tag-check.yml");
const workflowYaml = readFileSync(workflowPath, "utf8");

const CHECK_STEP = "デプロイ設定の漏れを確認する";

/**
 * ステップ名から`run: |`の本文を取り出す。YAMLパーサを足さずに済ませるための最小実装で、
 * `- name:`の直後のステップ定義に`run: |`がブロックスカラーで続く書き方だけを想定する
 * （`scripts/reusable-sync-secrets.test.mjs`と同じ実装）。
 */
function extractRunScript(stepName) {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`ステップが見つかりません: ${stepName}`);

  const runIndex = lines.findIndex(
    (line, index) => index > start && line.trim() === "run: |",
  );
  if (runIndex < 0) throw new Error(`run: が見つかりません: ${stepName}`);

  const body = [];
  const indent = lines[runIndex].search(/\S/) + 2;
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** `appleboy/ssh-action` を使う、実在のリポジトリと同じ形の `deploy.yml` を組み立てる */
function deployWorkflow({
  stepEnv = ["DATABASE_URL", "DB_USER", "TARGET_DIR"],
  envs = ["DATABASE_URL", "DB_USER", "TARGET_DIR"],
  written = ["DATABASE_URL", "DB_USER"],
  tarInputs = ["package.json", "public", ".next"],
} = {}) {
  return [
    "name: Deploy to Production",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Create archive",
    "        run: |",
    `          tar -czf deploy.tar.gz \\`,
    ...tarInputs.map((input, index) =>
      index === tarInputs.length - 1 ? `            ${input}` : `            ${input} \\`,
    ),
    "  deploy:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Deploy and restart",
    "        uses: appleboy/ssh-action@v1",
    "        env:",
    ...stepEnv.map((name) => `          ${name}: \${{ secrets.${name} }}`),
    "        with:",
    "          host: example.invalid",
    `          envs: ${envs.join(",")}`,
    "          script: |",
    "            set -euo pipefail",
    '            cd "${TARGET_DIR}"',
    ...written.map((name) => `            update_env ${name} "$${name}"`),
    "",
  ].join("\n");
}

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "deploy-config-check-"));
  // `git check-ignore` でビルド生成物（`.next`など）を除外するため、実際のリポジトリにする
  execFileSync("git", ["init", "-q"], { cwd: workDir });
  writeFileSync(path.join(workDir, ".gitignore"), ".next\nnode_modules\n");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 仮リポジトリにファイルを置く（`dir/file` 形式のパスも作れる） */
function place(relativePath, content) {
  const target = path.join(workDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** `deployWorkflow()` の既定の tar 対象を実在させる（tar以外の検査を確かめるとき用） */
function placeTarInputs() {
  place("package.json", "{}\n");
  place("public/.gitkeep", "");
}

/** ステップを1回実行し、終了コードと出力を返す */
function runCheck(env = {}) {
  const script = path.join(workDir, "step.sh");
  writeFileSync(script, extractRunScript(CHECK_STEP));

  try {
    const stdout = execFileSync("bash", ["-e", script], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: workDir,
        DEPLOY_WORKFLOW: "",
        VERSION_FILE: "",
        PNPM_MAJOR_MAX: "",
        ...env,
      },
    });
    return { status: 0, stdout };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

describe("reusable-version-tag-check の deploy-config-check", () => {
  describe("appleboy/ssh-action の envs: への追記漏れ", () => {
    it("env: とリモートスクリプトにあるのに envs: に無い変数を落とす", () => {
      place(".github/workflows/deploy.yml", deployWorkflow({ envs: ["DATABASE_URL", "TARGET_DIR"] }));

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).toContain("DB_USER");
      expect(result.stdout).toContain("with.envs:");
    });

    it("envs: にあるのに env: の定義が無い変数を落とす（綴り違い・追記漏れ）", () => {
      place(
        ".github/workflows/deploy.yml",
        deployWorkflow({ envs: ["DATABASE_URL", "DB_USER", "DB_USERNAME", "TARGET_DIR"] }),
      );

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("DB_USERNAME");
    });

    it("転送はしているが .env へ書いていない変数は、警告だけで落とさない", () => {
      place(".github/workflows/deploy.yml", deployWorkflow({ written: ["DATABASE_URL"] }));
      placeTarInputs();

      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::warning::");
      expect(result.stdout).toContain("DB_USER");
    });

    it("3箇所が揃っていれば通す", () => {
      place(".github/workflows/deploy.yml", deployWorkflow());
      placeTarInputs();

      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("::error::");
      expect(result.stdout).not.toContain("::warning::");
    });

    it("appleboy/ssh-action を使わないリポジトリ（rsync等）はスキップする", () => {
      place(
        ".github/workflows/deploy.yml",
        ["name: Deploy", "jobs:", "  deploy:", "    steps:", "      - run: rsync -az ./ host:/srv", ""].join("\n"),
      );

      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("appleboy/ssh-action が無いため");
    });
  });

  describe("tar の対象に実在しないパスがある", () => {
    it("追跡されていないディレクトリ（空の public/ など）を落とす", () => {
      place(".github/workflows/deploy.yml", deployWorkflow());
      place("package.json", "{}\n");

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("tar の対象 public がリポジトリにありません");
      expect(result.stdout).toContain("Cannot stat");
    });

    it("`.gitignore` 済みのビルド生成物（.next）は落とさない", () => {
      place(".github/workflows/deploy.yml", deployWorkflow());
      place("package.json", "{}\n");
      place("public/.gitkeep", "");

      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(".next");
    });

    it("展開（tar -xzf）は作成ではないので見ない（リモートスクリプト側の tar）", () => {
      place(
        ".github/workflows/deploy.yml",
        [
          "name: Deploy",
          "jobs:",
          "  deploy:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: Extract",
          "        run: |",
          "          tar -xzf deploy.tar.gz",
          "",
        ].join("\n"),
      );

      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("検査対象の tar コマンドはありませんでした");
    });

    it("変数を含む引数は静的に確かめられないので見送る", () => {
      place(
        ".github/workflows/deploy.yml",
        deployWorkflow({ tarInputs: ["package.json", "${{ env.BUNDLE_DIR }}"] }),
      );
      place("package.json", "{}\n");
      place("public/.gitkeep", "");

      const result = runCheck();

      expect(result.status).toBe(0);
    });
  });

  describe("packageManager の pnpm メジャー", () => {
    it("pnpm 11 を落とす（VPSの Node 20 では node:sqlite で失敗するため）", () => {
      place("package.json", JSON.stringify({ packageManager: "pnpm@11.2.0" }));

      const result = runCheck();

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("node:sqlite");
    });

    it("pnpm 10 は通す", () => {
      place("package.json", JSON.stringify({ packageManager: "pnpm@10.34.5" }));

      const result = runCheck();

      expect(result.status).toBe(0);
    });

    it("上限は pnpm-major-max で変えられる", () => {
      place("package.json", JSON.stringify({ packageManager: "pnpm@11.2.0" }));

      const result = runCheck({ PNPM_MAJOR_MAX: "11" });

      expect(result.status).toBe(0);
    });

    it("version-file がサブディレクトリの package.json でも見る（myroom）", () => {
      place("frontend/package.json", JSON.stringify({ packageManager: "pnpm@11.2.0" }));

      const result = runCheck({ VERSION_FILE: "frontend/package.json" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("frontend/package.json");
    });
  });

  describe("検査できないリポジトリ", () => {
    it("deploy.yml が無ければスキップして通す", () => {
      const result = runCheck();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("検査はスキップしました");
    });

    it("deploy-workflow で別のパスを指定できる", () => {
      place(".github/workflows/deploy-production.yml", deployWorkflow({ envs: ["DATABASE_URL"] }));

      const result = runCheck({ DEPLOY_WORKFLOW: ".github/workflows/deploy-production.yml" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("DB_USER");
    });
  });

  describe("実在の deploy.yml", () => {
    it("issue-deck 自身の deploy.yml を通す（誤検知を出さない）", () => {
      const result = (() => {
        const script = path.join(workDir, "step.sh");
        writeFileSync(script, extractRunScript(CHECK_STEP));
        try {
          return {
            status: 0,
            stdout: execFileSync("bash", ["-e", script], {
              cwd: repoRoot,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              env: { PATH: process.env.PATH, HOME: process.env.HOME },
            }),
          };
        } catch (error) {
          return { status: error.status ?? 1, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}` };
        }
      })();

      expect(result.stdout).not.toContain("::error::");
      expect(result.stdout).not.toContain("::warning::");
      expect(result.status).toBe(0);
    });
  });
});
