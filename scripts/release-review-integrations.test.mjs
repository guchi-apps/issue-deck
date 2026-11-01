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
// #5037: RC-8（aide #698 → yoteiflow#1354）。依存参照はRCのコミット/追加行ではなく実装PR本文にだけある
function rcWithPull(subject) {
  git("commit", "-q", "--amend", "-m", subject);
  head = git("rev-parse", "HEAD");
  return head;
}
const pullRoutes = (merge, body) => ({
  "repos/guchi-apps/aide/pulls/698": { merged_at: "2026-10-20", merge_commit_sha: merge, body },
  "repos/guchi-apps/yoteiflow/issues/1354": { title: "DaySpan", state: "closed", closed_at: "2026-10-18", body: "endDate" },
  "repos/guchi-apps/yoteiflow/pulls?state=all": [{ number: 1357 }],
  "repos/guchi-apps/yoteiflow/pulls/1357/files": [],
  "repos/guchi-apps/yoteiflow/pulls/1357": { merged_at: "2026-10-18", merge_commit_sha: SHA, base: { ref: "main" }, head: { ref: "issue-1354" } },
  "repos/guchi-apps/yoteiflow/compare/": { status: "behind" },
  "repos/guchi-apps/yoteiflow/actions/runs": { workflow_runs: [] },
});
it("RCの実装PR本文にある依存参照を発見元付きで解決する", () => {
  const sha = rcWithPull("Merge pull request #698 from guchi-apps/issue-696");
  writeFake(pullRoutes(sha, "依存: guchi-apps/yoteiflow#1354\n無関係: https://evil.example/a/b/issues/1 と other-org/z#3"));
  run();
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  const r = m.resolved.find((x) => x.repository === "guchi-apps/yoteiflow");
  expect(r.number).toBe(1354);
  expect(r.discoveredFrom).toContain("guchi-apps/aide#698");
  expect(r.pulls[0].number).toBe(1357);
  expect(m.rcPulls[0].mergeSha).toBe(sha);
  expect(m.resolved.find((x) => x.repository === "other-org/z").classification).toBe("資料未取得");
  expect(readFileSync(path.join(dir, "calls.log"), "utf8")).not.toContain("evil");
});
it("RCの範囲に無いマージSHAを持つPR（コミット件名の番号違い）の本文は採用しない", () => {
  rcWithPull("Merge pull request #698 from guchi-apps/issue-696");
  writeFake(pullRoutes("d".repeat(40), "依存: guchi-apps/yoteiflow#1354"));
  expect(run()).toBe("");
});
it("PR本文の参照も上限と許可リストに従い、変更のない再実行は同じ指紋", () => {
  const sha = rcWithPull("feat (#698)");
  const many = Array.from({ length: 12 }, (_, i) => `guchi-apps/yoteiflow#${2000 + i}`).join(" ");
  writeFake(pullRoutes(sha, many));
  run();
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  expect(m.resolved.length).toBe(8);
  expect(m.omittedRefs).toBe(4);
  const fp = readFileSync(path.join(out, "fingerprint"), "utf8");
  run();
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).toBe(fp);
});
// #5192: RC-11（work-relay PR #388）。AIDEの既存受信口への明示参照は無く、呼び出しコードとマニフェストだけが根拠になる
const AIDE = "repos/guchi-apps/aide";
const LIVE5192 = "1".repeat(40);
const IMPL5192 = "2".repeat(40);
const FIRST5192 = "3".repeat(40);
const CALLER = `const url = (process.env.AIDE_NEWS_MAIL_URL ?? "").trim();
export async function POST() {
  return fetch(\`\${url}/api/news-mail/send\`, { method: "POST", body: JSON.stringify({ articleCount: 1 }) });
}
`;
const MANIFEST = "# コメント\nAIDE_NEWS_MAIL_URL\trepo\tvar\tAIDE_NEWS_MAIL_URL\top://apps/aide/base-url\nAIDE_NEWS_MAIL_TOKEN\trepo\tsecret\tAIDE_NEWS_MAIL_TOKEN\top://apps/aide/news-mail-token\nOTHER_URL\trepo\tvar\tOTHER_URL\top://apps/kurashio/base-url\nHOOK_URL\trepo\tsecret\tHOOK_URL\top://apps/Notify/alert-webhook-url\n";
function candidate(files, message = "機能追加") {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), body);
  }
  git("add", ".");
  git("commit", "-q", "--amend", "-m", message);
  head = git("rev-parse", "HEAD");
}
const runAs = (fullName = "guchi-apps/work-relay") => execFileSync("python3", ["scripts/release-review-integrations.py", repo, fullName, base, head, out],
  { encoding: "utf8", env: { ...process.env, RELEASE_REVIEW_GH: fake } });
const blobs = (names) => ({ tree: names.map((p) => ({ path: p, type: "blob" })) });
const SERVER = `import { handleNewsMailSend } from "./api/news-mail.ts";
import { handleOther } from "./api/other.ts";
if (path === "/api/other") { await handleOther(req, res); return; }
if (path === "/api/news-mail/send") {
  await handleNewsMailSend(req, res);
  return;
}
`;
const HANDLER = (extra = "") => `import { sendNewsMail, type SendNewsMailInput } from "../core/connectors/news-mail/send.ts";
import type { Unused } from "../types.ts";
${extra}
export async function handleNewsMailSend() { const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"; }
`;
const provider = (handlerExtra = "") => ({
  [`${AIDE}/actions/runs`]: { workflow_runs: [{ name: "iOS TestFlight", path: ".github/workflows/ios-testflight.yml", head_sha: "9".repeat(40) }, { name: "Deploy to Production", path: ".github/workflows/deploy.yml", head_sha: LIVE5192 }] },
  [`${AIDE}/git/trees/${LIVE5192}`]: blobs(["src/server.ts", "src/api/news-mail.ts", "src/api/other.ts", "src/types.ts", "src/core/connectors/news-mail/send.ts", "README.md"]),
  [`${AIDE}/git/trees/${IMPL5192}`]: blobs(["src/server.ts", "src/api/news-mail.ts", "src/core/connectors/news-mail/send.ts"]),
  [`${AIDE}/contents/src/server.ts?ref=`]: SERVER,
  [`${AIDE}/contents/src/api/news-mail.ts?ref=${LIVE5192}`]: `${HANDLER(handlerExtra)}// 後続変更\n`,
  [`${AIDE}/contents/src/api/news-mail.ts?ref=`]: HANDLER(handlerExtra),
  [`${AIDE}/contents/src/core/connectors/news-mail/send.ts?ref=`]: "export const sendNewsMail = () => 1;\n",
  [`${AIDE}/commits?sha=${LIVE5192}`]: [{ sha: "8".repeat(40) }, { sha: FIRST5192 }],
  [`${AIDE}/commits/${FIRST5192}/pulls`]: [{ number: 258, merged_at: "2026-09-06", merge_commit_sha: IMPL5192 }],
});
it("明示参照が無くても、呼び出しとマニフェストから受信口と送信処理を実装時点・デプロイ候補時点の固定SHAで取得する", () => {
  candidate({ "src/app/api/news-mail/send/route.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  writeFake(provider());
  const prompt = runAs();
  const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  expect(m.resolved).toEqual([]);
  expect(m.apiContracts).toHaveLength(1);
  const c = m.apiContracts[0];
  expect(c).toMatchObject({ provider: "guchi-apps/aide", path: "/api/news-mail/send" });
  expect(c.classification).toBeUndefined();
  expect(c.discoveredFrom).toMatchObject({ file: "src/app/api/news-mail/send/route.ts", line: 3, headSha: head, envVar: "AIDE_NEWS_MAIL_URL", manifestSource: "op://apps/aide/base-url" });
  const cur = c.codeAtDeployCandidate;
  expect(cur.sha).toBe(LIVE5192);
  expect(c.deployCandidate.kind).toContain("稼働SHAは未確認");
  expect(cur).toMatchObject({ found: true, entry: "src/server.ts", handler: "src/api/news-mail.ts", routeLine: 4, handlerResolved: true });
  // 無関係なパス（/api/other）の処理と、型だけのimportは載せない
  expect(cur.files.map((f) => f.path)).toEqual(["src/server.ts", "src/api/news-mail.ts", "src/core/connectors/news-mail/send.ts"]);
  const local = (p) => readFileSync(cur.files.find((f) => f.path === p).local, "utf8");
  expect(local("src/api/news-mail.ts")).toContain("後続変更");
  expect(local("src/api/news-mail.ts")).not.toContain("ghp_");
  // 実装時点（#257のPR #258）は別のSHAで別に取得する
  expect(c.codeAtImplementation).toMatchObject({ pull: 258, commit: FIRST5192, sha: IMPL5192, found: true });
  expect(readFileSync(c.codeAtImplementation.files.find((f) => f.path === "src/api/news-mail.ts").local, "utf8")).not.toContain("後続変更");
  // 取得は適合の証拠ではなく、実送信・稼働SHAを確認済みにしない
  expect(c.unverified).toContain("未確認のまま");
  expect(prompt).toContain("実送信と稼働SHAは別の証拠が無ければ未確認");
  expect(prompt).toContain("実行も巡回もしません");
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).not.toBe("");
  // 判定器の版が上がっているので、#5192より前に保存された結果の指紋とは一致しない
  expect(m.judgeVersion).toBe(3);
});
it("本文・コメント・ドキュメントの記述や、別ファイルに分かれた環境変数とパスからは受信口を発見しない", () => {
  candidate({
    "docs/a.md": "`${process.env.AIDE_NEWS_MAIL_URL}/api/news-mail/send` を呼ぶ https://evil.example/api/x",
    "src/env.ts": "export const url = process.env.AIDE_NEWS_MAIL_URL;\n",
    "src/call.ts": "fetch(`${base}/api/news-mail/send`);\n",
    "src/call.test.ts": "const u = process.env.AIDE_NEWS_MAIL_URL; fetch(`${u}/api/news-mail/send`);\n",
    "src/hook.ts": "const u = process.env.HOOK_URL; fetch(`${u}/api/hook`);\n",
    "src/dyn.ts": "const u = process.env.AIDE_NEWS_MAIL_URL; fetch(`${u}/api/items/${id}`);\n",
    ".github/secrets-manifest.tsv": MANIFEST,
  }, "AIDEの /api/news-mail/send を使う");
  writeFake({});
  expect(runAs()).toBe("");
  expect(existsSync(path.join(dir, "calls.log"))).toBe(false);
});
it("マニフェストが無い候補・許可外のowner・自分自身を指す行では取得しない", () => {
  candidate({ "src/a.ts": CALLER });
  writeFake({});
  expect(runAs()).toBe("");
  candidate({ "src/a.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  expect(runAs("other-org/work-relay")).toBe("");
  expect(runAs("guchi-apps/aide")).toBe("");
  expect(existsSync(path.join(dir, "calls.log"))).toBe(false);
});
it("1ファイルが複数の提供側を読むときは、呼び先を決めつけず取得もしない", () => {
  candidate({ "src/a.ts": `${CALLER}const o = process.env.OTHER_URL;\n`, ".github/secrets-manifest.tsv": MANIFEST });
  writeFake(provider());
  runAs();
  const c = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0];
  expect(c.classification).toBe("資料未取得");
  expect(c.providers).toEqual(["guchi-apps/aide", "guchi-apps/kurashio"]);
  expect(existsSync(path.join(dir, "calls.log"))).toBe(false);
});
it("受信口が無いパスは前方一致で別の処理を載せず、資料未取得として残す", () => {
  candidate({ "src/a.ts": CALLER.replace("/api/news-mail/send", "/api/news-mail"), ".github/secrets-manifest.tsv": MANIFEST });
  writeFake(provider());
  runAs();
  const c = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0];
  expect(c.classification).toBe("資料未取得");
  expect(c.error).toContain("受信口が見つからない");
  expect(c.codeAtDeployCandidate.files).toBeUndefined();
  expect(c.unverified).toBeUndefined();
});
it("ファイルベースのルートは完全一致のパスだけを受信口にする", () => {
  candidate({ "src/a.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  writeFake({
    ...provider(),
    [`${AIDE}/git/trees/${LIVE5192}`]: blobs(["src/app/(app)/api/news-mail/send/route.ts", "src/app/api/news-mail/route.ts", "src/lib/mail.ts"]),
    [`${AIDE}/contents/src/app/(app)/api/news-mail/send/route.ts`]: 'import { send } from "@/lib/mail";\n',
    [`${AIDE}/contents/src/lib/mail.ts`]: "export const send = 1;\n",
  });
  runAs();
  const cur = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0].codeAtDeployCandidate;
  expect(cur.handler).toBe("src/app/(app)/api/news-mail/send/route.ts");
  expect(cur.files.map((f) => f.path)).toEqual(["src/app/(app)/api/news-mail/send/route.ts", "src/lib/mail.ts"]);
});
it("権限不足は分類して資料を作らず、回復すると指紋が変わって保存済みの未確認だけが再評価される", () => {
  candidate({ "src/a.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  writeFake({});
  runAs();
  const c = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0];
  expect(c.classification).toBe("権限不足");
  expect(c.codeAtDeployCandidate).toBeUndefined();
  const failed = readFileSync(path.join(out, "fingerprint"), "utf8");
  expect(failed).not.toBe("");
  writeFake(provider());
  runAs();
  const recovered = readFileSync(path.join(out, "fingerprint"), "utf8");
  expect(recovered).not.toBe(failed);
  runAs();
  expect(readFileSync(path.join(out, "fingerprint"), "utf8")).toBe(recovered);
  // 正規の再評価経路: 指紋が違えば指摘0件でも未確認は捨て、確認済みは再利用する。同じ指紋なら未確認も保つ
  const batch = path.join(dir, "batch");
  const prepare = () => {
    rmSync(batch, { recursive: true, force: true });
    mkdirSync(batch);
    writeFileSync(path.join(batch, "r1.json"), JSON.stringify({ findings: [], checks: [{ status: "unconfirmed", evidence: "受信routeのコードが未取得" }] }));
    writeFileSync(path.join(batch, "r2.json"), JSON.stringify({ findings: [], checks: [{ status: "confirmed" }] }));
    writeFileSync(path.join(batch, "r1.fp"), `x:integ-${failed}`);
    writeFileSync(path.join(batch, "r2.fp"), `x:integ-${failed}`);
  };
  const sweep = (fp) => execFileSync("bash", ["-c", `source scripts/run-release-review.sh; batch_dir="${batch}"; INTEGRATION_EVIDENCE_ACTIVE=1; invalidate_stale_batches "${fp}"; echo "$reuse_note"`], { encoding: "utf8" });
  prepare();
  expect(sweep(`x:integ-${recovered}`)).toContain("1件を再評価");
  expect(existsSync(path.join(batch, "r1.json"))).toBe(false);
  expect(existsSync(path.join(batch, "r2.json"))).toBe(true);
  prepare();
  sweep(`x:integ-${failed}`);
  expect(existsSync(path.join(batch, "r1.json"))).toBe(true);
});
it("追跡するファイル数は上限で止め、省略したファイルを記録する", () => {
  const many = Array.from({ length: 20 }, (_, i) => `f${i}`);
  candidate({ "src/a.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  const routes5192 = provider(many.map((n) => `import { ${n} } from "../api/${n}.ts";`).join("\n"));
  routes5192[`${AIDE}/git/trees/${LIVE5192}`] = blobs(["src/server.ts", "src/api/news-mail.ts", "src/core/connectors/news-mail/send.ts", ...many.map((n) => `src/api/${n}.ts`)]);
  routes5192[`${AIDE}/contents/src/api/f`] = "export const f = 1;\n";
  writeFake(routes5192);
  runAs();
  const cur = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0].codeAtDeployCandidate;
  expect(cur.files.length).toBe(14);
  expect(cur.omittedFiles.length).toBeGreaterThan(0);
});
it("入口ファイルで処理本体を特定できないときは、入口のimportを広げず入口だけを載せる", () => {
  candidate({ "src/a.ts": CALLER, ".github/secrets-manifest.tsv": MANIFEST });
  writeFake({ ...provider(), [`${AIDE}/contents/src/server.ts?ref=`]: 'import { unrelated } from "./api/other.ts";\nroutes["/api/news-mail/send"] = table.send;\n' });
  runAs();
  const cur = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")).apiContracts[0].codeAtDeployCandidate;
  expect(cur.handlerResolved).toBe(false);
  expect(cur.files.map((f) => f.path)).toEqual(["src/server.ts"]);
});
