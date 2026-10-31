// `PostToolUse`でアーティファクトのHTMLの原本をissue-deckへ送る取り込み（#2154）が、
// 組み込みの`Artifact`だけでなく、Claude Code本体が差し替えたMCPサーバー`claude-artifacts`の
// 公開ツールでも働くことを固定する（#5144）。
//
// 差し替えはissue-deckの設定ではなくClaude Code本体がセッションの途中で行う。`Artifact`しか
// 見ていなかったあいだ、差し替わったセッションでは「アーティファクト」カードが黙って出なかった。

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/session-notify.sh");

let workDir;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "session-notify-artifact-"));
  mkdirSync(path.join(workDir, "scratch"), { recursive: true });
  writeFileSync(path.join(workDir, "notify.env"), "");
  writeFileSync(
    path.join(workDir, "dispatch.env"),
    "APP_BASE_URL=https://deck.example.test\nDISPATCH_SECRET=dummy\nDISPATCH_HOST_NAME=h\n",
  );
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function runHook(toolName, toolInput, toolResponse) {
  const hook = {
    hook_event_name: "PostToolUse",
    session_id: "s",
    transcript_path: path.join(workDir, "t.jsonl"),
    cwd: workDir,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  };
  let stdout = "";
  const child = execFile("bash", [script, "5144", "issue-deck", "guchi-apps/issue-deck"], {
    encoding: "utf8",
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: workDir,
      TMUX: "",
      SESSION_NOTIFY_TMUX_SESSION: "",
      SESSION_NOTIFY_DRY_RUN: "1",
      DISPATCH_HOST_NAME: "h",
      ISSUE_DECK_DISPATCH_ENV: path.join(workDir, "dispatch.env"),
      ISSUE_DECK_NOTIFY_ENV: path.join(workDir, "notify.env"),
    },
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  child.stdin.end(JSON.stringify(hook));
  return done;
}

/** dry-runの出力から、取り込みAPIへ送る行（先頭300文字）を取り出す */
function artifactLine(stdout) {
  return stdout.split("\n").find((line) => line.startsWith("/api/dispatch/sessions/artifact ")) ?? null;
}

const URL_ID = "XxWDfT8h7LawipKxDoz8nd";

describe("アーティファクトの原本の取り込み（#2154・#5144）", () => {
  it("組み込みのArtifactは従来どおりfile_pathの原本を送る", async () => {
    const file = path.join(workDir, "scratch", "design.html");
    writeFileSync(file, "<!DOCTYPE html><title>案</title>");
    const line = artifactLine(
      await runHook("Artifact", { file_path: file }, `Published: https://claude.ai/artifact/${URL_ID}`),
    );
    expect(line).toContain(`"sourcePath": "${file}"`);
    expect(line).toContain(URL_ID);
  });

  it("publish_filesはindex.htmlのエントリの原本を送る", async () => {
    const file = path.join(workDir, "scratch", "page.html");
    writeFileSync(file, "<!DOCTYPE html><title>案</title>");
    const line = artifactLine(
      await runHook(
        "mcp__claude-artifacts__publish_files",
        {
          title: "画面案",
          files: [
            { as: "css/site.css", path: path.join(workDir, "scratch", "site.css") },
            { as: "index.html", path: file },
          ],
        },
        [{ type: "text", text: `{"url":"https://claude.ai/artifact/${URL_ID}"}` }],
      ),
    );
    expect(line).toContain(`"sourcePath": "${file}"`);
    expect(line).toContain('"title": "画面案"');
    expect(line).toContain(URL_ID);
  });

  it("publish_filesでindex.htmlを含まない更新は送らない", async () => {
    const stdout = await runHook(
      "mcp__claude-artifacts__publish_files",
      { slug: "s", base_version: "v", files: [{ as: "css/site.css", path: path.join(workDir, "scratch", "site.css") }] },
      "ok",
    );
    expect(artifactLine(stdout)).toBeNull();
  });

  // `sourcePath`は受け側で上書き先を決めるので、別々のアーティファクトが1枚に潰れないよう
  // 公開先のIDを含める（応答のURL→`slug`の順）
  it("publish_versionは本文をそのまま送り、sourcePathには公開先のIDを含む合成値を入れる", async () => {
    const line = artifactLine(
      await runHook(
        "mcp__claude-artifacts__publish_version",
        { title: "画面案", content: "<!DOCTYPE html><p>本文</p>" },
        `Published https://claude.ai/artifact/${URL_ID}`,
      ),
    );
    expect(line).toContain(`"sourcePath": "mcp:publish_version:${URL_ID}"`);
    expect(line).toContain('"title": "画面案"');

    const bySlug = artifactLine(
      await runHook(
        "mcp__claude-artifacts__publish_version",
        { slug: "slug-1", base_version: "v", content: "<!DOCTYPE html><p>本文</p>" },
        "published",
      ),
    );
    expect(bySlug).toContain('"sourcePath": "mcp:publish_version:slug-1"');
  });

  it("公開以外のclaude-artifactsのツールは送らない", async () => {
    const stdout = await runHook("mcp__claude-artifacts__read_artifact", { slug: "s" }, "<!DOCTYPE html>");
    expect(artifactLine(stdout)).toBeNull();
  });
});
