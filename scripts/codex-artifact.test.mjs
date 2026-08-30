import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const script = join(repoRoot, "scripts/lib/codex-artifact.sh");

describe("codex-artifact.sh", () => {
  it("HTMLをIssueDeckへ登録し、IssueDeck配下のURLを返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-deck-codex-artifact-"));
    const html = join(dir, "design.html");
    const bin = join(dir, "bin");
    const curl = join(bin, "curl");
    mkdirSync(bin);
    writeFileSync(html, "<!doctype html><title>Design</title><p>Hello</p>", "utf8");
    writeFileSync(
      curl,
      "#!/usr/bin/env bash\nprintf '%s' '{\"artifact\":{\"id\":\"artifact-123\"}}'\n",
      "utf8",
    );
    chmodSync(curl, 0o755);

    const output = execFileSync("bash", [script, html], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ISSUE_DECK_ARTIFACT_API_URL: "https://issuedeck.gucchii.com/api/dispatch/sessions/artifact",
        ISSUE_DECK_ARTIFACT_SECRET: "test-secret",
        ISSUE_DECK_REPO_SLUG: "guchi-apps/issue-deck",
        ISSUE_DECK_ISSUE_NUMBER: "2597",
        ISSUE_DECK_HOST_NAME: "subpc",
      },
    });

    expect(output.toString()).toBe("https://issuedeck.gucchii.com/artifacts/artifact-123\n");
  });

  it("Issue専用セッションの情報が無ければ登録しない", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-deck-codex-artifact-"));
    const html = join(dir, "design.html");
    writeFileSync(html, "<p>Design</p>", "utf8");

    expect(() =>
      execFileSync("bash", [script, html], {
        cwd: repoRoot,
        env: { ...process.env, ISSUE_DECK_ARTIFACT_API_URL: "" },
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
