import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
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
  const saved = readFileSync(r.pulls[0].codeAtMerge.files[0].local, "utf8");
  expect(saved).not.toContain("ghp_");
  expect(r.pulls[0].codeAtMerge.skipped[0].path).toBe(".env.production");
  expect(prompt).toContain("実行も巡回もしません");
  expect(readFileSync(path.join(dir, "calls.log"), "utf8")).not.toContain("evil");
});
it("後続PRが入った稼働中のSHAでも同じファイルを別に取得し、取得時刻は指紋に影響しない", () => {
  const LIVE = "b".repeat(40);
  writeFake({
    [`repos/guchi-apps/kurashio/contents/src/api.ts?ref=${LIVE}`]: "export const x = 2; // 後続PR\n",
    ...routes,
    "repos/guchi-apps/kurashio/compare/main": { status: "behind" },
    ["repos/guchi-apps/kurashio/compare/" + "c".repeat(40)]: { status: "behind" },
    [`repos/guchi-apps/kurashio/compare/${LIVE}`]: { status: "behind" },
    "repos/guchi-apps/kurashio/actions/runs": { workflow_runs: [{ name: "release-sync", path: ".github/workflows/release-sync.yml", head_sha: "c".repeat(40) }, { name: "deploy", path: ".github/workflows/deploy.yml", head_sha: LIVE }] },
  });
  run();
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  const pr = m.resolved.find((x) => x.repository === "guchi-apps/kurashio").pulls[0];
  expect(pr.deploy.headSha).toBe(LIVE); // 新しいrelease-sync成功runではなく、実deployのrunを使う
  expect(pr.deploy.state).toContain("稼働SHAは未確認");
  expect(readFileSync(pr.codeAtMerge.files[0].local, "utf8")).toContain("x = 1");
  expect(readFileSync(pr.codeAtDeployCandidate.files[0].local, "utf8")).toContain("x = 2");
  expect(m.fetchedAt).toMatch(/^\d{4}-/);
  expect(m.judgeVersion).toBeGreaterThan(0);
  expect(m.sharedTokens).toContain("未確認");
});
it("予期しない例外は空資料にせず取得不能として残す", () => {
  writeFake(routes);
  mkdirSync(path.join(out, "manifest.json"), { recursive: true }); // 書き込みを失敗させる
  const prompt = run();
  expect(prompt).toContain("取得不能");
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).toMatch(/^failed-/);
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
it("連携先の証跡があるとき、旧文言の未確認も含め全ての未確認が再評価対象になり、確認済みだけが再利用される", () => {
  const f = path.join(dir, "r1.json");
  writeFileSync(f, JSON.stringify({ checks: [{ status: "unconfirmed", evidence: "別の文言の読み残し" }, { status: "confirmed" }] }));
  const probe = (active) => {
    try {
      execFileSync("bash", ["-c", `source scripts/run-release-review.sh; INTEGRATION_EVIDENCE_ACTIVE=${active}; result_depends_on_evidence "${f}"`]);
      return true;
    } catch { return false; }
  };
  expect(probe(0)).toBe(false);
  expect(probe(1)).toBe(true);
});
it("共有トークンは名前がコードに出るものだけを渡し、取得不能は『未登録』と書かない", () => {
  const ctx = JSON.stringify({ sharedTokens: [
    { name: "MYROOM_INTERNAL_BILLS_WRITE_API_KEY", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null, consumers: [] },
    { name: "UNRELATED_TOKEN", updatedAt: "2026-10-01T00:00:00Z", lastUsedAt: null, consumers: ["x"] },
  ] });
  const sh = (c, prs) => execFileSync("bash", ["-c", `source scripts/run-release-review.sh
WORKTREE="${repo}"; base_sha="${base}"; head_sha="${head}"
m="$(shared_token_matches '${c}' "${dir}" "${prs}")"; echo "$m"; shared_token_prompt_text "$m"`], { encoding: "utf8" });
  const hit = sh(ctx, "MYROOM_INTERNAL_BILLS_WRITE_API_KEY を使う");
  expect(hit).toContain("MYROOM_INTERNAL_BILLS_WRITE_API_KEY");
  expect(hit).not.toContain("UNRELATED_TOKEN");
  const none = sh("{}", "x");
  expect(none).toContain("未確認");
  expect(none).toContain("未登録という意味ではありません");
});
it("共有トークンの照合は巨大な差分・連携先コード（200KiB超）でもargv上限に当たらない", () => {
  const bigDir = path.join(dir, "big");
  mkdirSync(bigDir);
  writeFileSync(path.join(bigDir, "code.ts"), `${"x".repeat(150000)}\nMYROOM_KEY\n`);
  writeFileSync(path.join(bigDir, "code2.ts"), "y".repeat(190000));
  const ctx = JSON.stringify({ sharedTokens: [{ name: "MYROOM_KEY", updatedAt: "t", lastUsedAt: null, consumers: [] }] });
  const out = execFileSync("bash", ["-c", `source scripts/run-release-review.sh
WORKTREE="${repo}"; base_sha="${base}"; head_sha="${head}"
shared_token_matches '${ctx}' "${bigDir}" ""`], { encoding: "utf8" });
  expect(out).toContain("MYROOM_KEY");
});
it("共有トークンの指紋は最終利用日時・並び順では変わらず、更新日時・利用元・取得不能では変わる", () => {
  const gen = (m) => execFileSync("bash", ["-c", `source scripts/run-release-review.sh; shared_token_generation '${m}'`], { encoding: "utf8" });
  const a = { name: "A", updatedAt: "t1", lastUsedAt: "u1", consumers: ["x", "y"] };
  const b = { name: "B", updatedAt: "t2", lastUsedAt: null, consumers: [] };
  const base0 = gen(JSON.stringify([a, b]));
  expect(gen(JSON.stringify([b, { ...a, lastUsedAt: "u2", consumers: ["y", "x"] }]))).toBe(base0);
  expect(gen(JSON.stringify([a, { ...b, updatedAt: "t3" }]))).not.toBe(base0);
  expect(gen(JSON.stringify([a, { ...b, consumers: ["z"] }]))).not.toBe(base0);
  expect(gen("null")).not.toBe(base0);
});
