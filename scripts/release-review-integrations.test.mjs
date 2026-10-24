import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir, repo, out, fake, base, head;
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
const SHA = "a".repeat(40);
// 偽のghは、環境変数FAKE_STATEのJSON（パス前方一致→応答）を返す。未登録は404
function writeFake(routes) {
  writeFileSync(path.join(dir, "routes.json"), JSON.stringify(routes));
  writeFileSync(fake, `#!/usr/bin/env python3
import json,sys,os
routes=json.load(open(${JSON.stringify(path.join(dir, "routes.json"))}))
p=sys.argv[2]
open(${JSON.stringify(path.join(dir, "calls.log"))},"a").write(p+"\\n")
for k,v in routes.items():
    if p.startswith(k):
        print(v if isinstance(v,str) else json.dumps(v)); sys.exit(0)
sys.stderr.write("gh: Not Found (HTTP 404)"); sys.exit(1)
`);
  chmodSync(fake, 0o755);
}
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "integ-test-"));
  repo = path.join(dir, "repo"); out = path.join(dir, "out"); fake = path.join(dir, "gh");
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.name", "t"); git("config", "user.email", "t@e.com");
  writeFileSync(path.join(repo, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base"); base = git("rev-parse", "HEAD");
  writeFileSync(path.join(repo, "a"), "2\n");
  git("commit", "-qam", "連携: guchi-apps/kurashio#814 を使う。#5 は自repo。https://evil.example/x/y#9 と other-org/z#3 は対象外");
  head = git("rev-parse", "HEAD");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = () => execFileSync("python3", ["scripts/release-review-integrations.py", repo, "guchi-apps/aide", base, head, out],
  { encoding: "utf8", env: { ...process.env, RELEASE_REVIEW_GH: fake } });
const routes = {
  "repos/guchi-apps/kurashio/issues/814": { title: "連携", state: "closed", closed_at: "2026-10-01", body: "token=abcdefghijklmnop1234 を設定" },
  "repos/guchi-apps/kurashio/pulls?state=all": [{ number: 900 }],
  "repos/guchi-apps/kurashio/pulls/900/files": [{ filename: "src/api.ts" }, { filename: ".env.production" }],
  "repos/guchi-apps/kurashio/pulls/900": { merged_at: "2026-10-02", merge_commit_sha: SHA, base: { ref: "develop" }, head: { ref: "issue-814" } },
  "repos/guchi-apps/kurashio/compare/develop": { status: "behind" },
  "repos/guchi-apps/kurashio/compare/main": { status: "ahead" },
  "repos/guchi-apps/kurashio/actions/runs": { workflow_runs: [] },
  "repos/guchi-apps/kurashio/contents/src/api.ts": "export const x = 1;\nconst k = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\n",
};
it("repo付き参照だけを解決し、固定SHAのコードを取得、秘密値と秘密ファイルは入れない", () => {
  writeFake(routes);
  const prompt = run();
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  // 許可外のowner（other-org・URL断片のx）は取得せず「資料未取得」として残るだけ
  const r = m.resolved.find((x) => x.repository === "guchi-apps/kurashio");
  expect(m.resolved.filter((x) => x.repository !== "guchi-apps/kurashio").every((x) => x.classification === "資料未取得" && !x.pulls)).toBe(true);
  expect(r.repository).toBe("guchi-apps/kurashio");
  expect(r.pulls[0].integrated).toEqual({ develop: true, main: false });
  expect(r.pulls[0].deploy.state).toContain("見つからない");
  expect(r.body).not.toContain("abcdefghijklmnop1234");
  const saved = readFileSync(r.pulls[0].files[0].local, "utf8");
  expect(saved).not.toContain("ghp_");
  expect(r.pulls[0].skipped[0].path).toBe(".env.production");
  expect(prompt).toContain("実行も巡回もしません");
  expect(readFileSync(path.join(dir, "calls.log"), "utf8")).not.toContain("evil");
});
it("取得失敗は分類して残し、回復すると指紋が変わる", () => {
  writeFake({});
  run();
  const failed = readFileSync(path.join(out, "fingerprint"), "utf8");
  expect(JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).resolved.find((x) => x.repository === "guchi-apps/kurashio").classification).toBe("権限不足");
  writeFake(routes);
  run();
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).not.toBe(failed);
  // 無変更の再実行は同じ指紋（無限再実行しない）
  const same = readFileSync(path.join(out, "fingerprint"), "utf8");
  run();
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).toBe(same);
});
it("参照が無い候補は何も出力せず指紋も空", () => {
  git("commit", "-q", "--amend", "-m", "plain");
  head = git("rev-parse", "HEAD");
  writeFake({});
  expect(run()).toBe("");
  expect(existsSync(path.join(out, "fingerprint"))).toBe(true);
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).toBe("");
});
