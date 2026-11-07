import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const script = join(repoRoot, "scripts/lib/issue-artifact.sh");
const legacyScript = join(repoRoot, "scripts/lib/codex-artifact.sh");

/**
 * `curl`を差し替えた作業場を作る。偽の`curl`は受け取った引数と標準入力（送った本文）を残し、
 * 決まった応答を返す。**実際のIssueDeckへは届かない。**
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "issue-deck-issue-artifact-"));
  const html = join(dir, "design.html");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(html, "<!doctype html><title>Design</title><p>Hello</p>", "utf8");
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${dir}/curl-args"`,
      `cat > "${dir}/curl-body"`,
      "printf '%s' '{\"artifact\":{\"id\":\"artifact-123\"}}'",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(bin, "curl"), 0o755);
  // 既定の`~/.config/issue-deck/dispatch.env`を読ませない（このホストの実設定に当たらないように）
  const config = join(dir, "dispatch.env");
  writeFileSync(
    config,
    "APP_BASE_URL=https://issuedeck.example.com\nDISPATCH_SECRET=file-secret\nDISPATCH_HOST_NAME=subpc\n",
    "utf8",
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ISSUE_DECK_DISPATCH_ENV: config,
    ISSUE_DECK_ARTIFACT_API_URL: "",
    ISSUE_DECK_ARTIFACT_SECRET: "",
    ISSUE_DECK_REPO_SLUG: "",
    ISSUE_DECK_ISSUE_NUMBER: "",
    ISSUE_DECK_HOST_NAME: "",
    // セッションの環境に残っている値も読ませない（dispatch.envの読み出しは継承した環境を引き継ぐ）
    APP_BASE_URL: "",
    DISPATCH_SECRET: "",
    DISPATCH_HOST_NAME: "",
  };
  return { dir, html, config, env };
}

function sentBody(dir) {
  return JSON.parse(readFileSync(join(dir, "curl-body"), "utf8"));
}

describe("issue-artifact.sh", () => {
  it("鍵をdispatch.envから読み、HTMLをIssueDeckへ登録してURLを返す（#5237）", () => {
    const { dir, html, env } = setup();

    const output = execFileSync("bash", [script, html, "--repo", "guchi-apps/morrow", "--issue", "42"], {
      cwd: dir,
      env,
    });

    expect(output.toString()).toBe("https://issuedeck.example.com/artifacts/artifact-123\n");
    const args = readFileSync(join(dir, "curl-args"), "utf8");
    expect(args).toContain("Authorization: Bearer file-secret");
    expect(args).toContain("https://issuedeck.example.com/api/dispatch/sessions/artifact");
    // 本文は標準入力で渡す（引数に載せると128KiBで`execve`が落ちる）
    expect(args).not.toContain("<p>Hello</p>");
    expect(sentBody(dir)).toMatchObject({
      repository: "guchi-apps/morrow",
      issue: 42,
      hostName: "subpc",
      sourcePath: html,
      html: "<!doctype html><title>Design</title><p>Hello</p>",
    });
  });

  it("指定が無ければ、cwdのブランチissue-<番号>とremoteから登録先を決める", () => {
    const { dir, html, env } = setup();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    git("init", "-q", "-b", "issue-77");
    git("remote", "add", "origin", "git@github.com:guchi-apps/asset-manager.git");

    execFileSync("bash", [script, html], { cwd: repo, env });

    expect(sentBody(dir)).toMatchObject({ repository: "guchi-apps/asset-manager", issue: 77 });
  });

  it("Codex向けの環境変数があればそちらを優先する（旧名のラッパーからも呼べる）", () => {
    const { dir, html, env } = setup();

    const output = execFileSync("bash", [legacyScript, html], {
      cwd: dir,
      env: {
        ...env,
        ISSUE_DECK_ARTIFACT_API_URL: "https://issuedeck.gucchii.com/api/dispatch/sessions/artifact",
        ISSUE_DECK_ARTIFACT_SECRET: "env-secret",
        ISSUE_DECK_REPO_SLUG: "guchi-apps/issue-deck",
        ISSUE_DECK_ISSUE_NUMBER: "2597",
      },
    });

    expect(output.toString()).toBe("https://issuedeck.gucchii.com/artifacts/artifact-123\n");
    expect(readFileSync(join(dir, "curl-args"), "utf8")).toContain("Authorization: Bearer env-secret");
    expect(sentBody(dir)).toMatchObject({ repository: "guchi-apps/issue-deck", issue: 2597 });
  });

  it("登録先のIssueが決まらなければ送らない", () => {
    const { dir, html, env } = setup();

    expect(() => execFileSync("bash", [script, html], { cwd: dir, env, stdio: "pipe" })).toThrow();
    expect(() => readFileSync(join(dir, "curl-args"))).toThrow();
  });

  it("鍵が無ければ送らない", () => {
    const { dir, html, env, config } = setup();
    writeFileSync(config, "APP_BASE_URL=https://issuedeck.example.com\n", "utf8");

    expect(() =>
      execFileSync("bash", [script, html, "--repo", "a/b", "--issue", "1"], { cwd: dir, env, stdio: "pipe" }),
    ).toThrow();
    expect(() => readFileSync(join(dir, "curl-args"))).toThrow();
  });

  it(".html以外は送らない", () => {
    const { dir, env } = setup();
    const json = join(dir, "canvas.json");
    writeFileSync(json, "{}", "utf8");

    expect(() =>
      execFileSync("bash", [script, json, "--repo", "a/b", "--issue", "1"], { cwd: dir, env, stdio: "pipe" }),
    ).toThrow();
  });
});
