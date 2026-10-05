import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * サブPCのPRレビュー使用量の送信待ち置き場（`scripts/lib/review-usage.sh`・#3995）のテスト。
 * `curl`は偽物をPATHの先頭に置き、受け口の応答（200・404・400）を切り替えて確かめる。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/review-usage.sh");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function setup(status = "200") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-usage-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // 受け取った本文を記録し、指定のステータスだけを返す偽のcurl
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do case "$1" in --data-binary) printf '%s\\n' "$2" >>"${dir}/sent.log"; shift 2;; *) shift;; esac; done\nprintf '%s' "${status}"\n`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ISSUE_DECK_REVIEW_USAGE_OUTBOX: path.join(dir, "outbox"),
    ISSUE_DECK_DISPATCH_ENV: path.join(dir, "missing.env"),
    APP_BASE_URL: "https://deck.example.test",
    DISPATCH_SECRET: "secret",
    DISPATCH_HOST_NAME: "subpc",
    CODEX_HOME: path.join(dir, "codex"),
  };
  const run = (script: string) =>
    execFileSync("bash", ["-c", `source "$0"; ${script}`, SCRIPT_PATH], { encoding: "utf-8", env });
  const outbox = () => (fs.existsSync(env.ISSUE_DECK_REVIEW_USAGE_OUTBOX) ? fs.readdirSync(env.ISSUE_DECK_REVIEW_USAGE_OUTBOX) : []);
  const sent = () => (fs.existsSync(path.join(dir, "sent.log")) ? fs.readFileSync(path.join(dir, "sent.log"), "utf-8").trim().split("\n") : []);
  return { dir, env, run, outbox, sent };
}

const RECORD = (summary: string, status = "completed") =>
  `review_usage_record codex codex-pr-review guchi-apps/issue-deck 4010 0123456789abcdef0123456789abcdef01234567 3995 ${status} 2026-10-05T01:00:00Z 2026-10-05T01:05:00Z gpt-5.6-terra https://github.com/x '${summary}'`;

describe("review_usage_record / review_usage_flush", () => {
  it("報告を置き場へ書き、200を受けたら消す", () => {
    const { run, outbox, sent } = setup("200");
    run(RECORD('{"threadId":"t-1","usage":{"responses":1,"inputTokens":1,"cacheCreateTokens":0,"cacheReadTokens":2,"outputTokens":3,"costUsd":0.1,"inputCostUsd":0.05,"outputCostUsd":0.05}}'));
    expect(outbox()).toHaveLength(1);
    run("review_usage_flush");
    expect(outbox()).toHaveLength(0);
    const body = JSON.parse(sent()[0]);
    expect(body.host).toBe("subpc");
    expect(body.reports[0]).toMatchObject({ agent: "codex", attemptId: "t-1", prNumber: 4010, issueNumber: 3995, models: ["gpt-5.6-terra"] });
  });

  it("受け口が未デプロイ（404）なら残して、次の巡回で同じ試行IDのまま送り直す", () => {
    const { run, outbox, sent } = setup("404");
    run(RECORD('{"threadId":"t-2","usage":null}', "timeout"));
    run("review_usage_flush");
    run("review_usage_flush");
    expect(outbox()).toHaveLength(1);
    const attempts = sent().map((line) => JSON.parse(line).reports[0]);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((item) => item.attemptId === "t-2" && item.usage === null && item.status === "timeout")).toBe(true);
  });

  it("受け付けられない形（400）は残さない", () => {
    const { run, outbox } = setup("400");
    run(RECORD('{"threadId":"t-3","usage":null}'));
    run("review_usage_flush 2>/dev/null");
    expect(outbox()).toHaveLength(0);
  });

  it("スレッドが立たず使用量も無い試行（起動前の失敗）は、消費が無いので記録しない", () => {
    const { run, outbox } = setup("404");
    run(RECORD('{"threadId":null,"usage":null}', "failed"));
    run(RECORD("not-json", "failed"));
    expect(outbox()).toHaveLength(0);
  });

  it("使用量があってthreadIdが無ければ、試行ごとに別の識別子を作る", () => {
    const { run, outbox } = setup("404");
    run(RECORD('{"usage":{"responses":1,"inputTokens":1,"cacheCreateTokens":0,"cacheReadTokens":0,"outputTokens":1,"costUsd":null}}'));
    const [name] = outbox();
    expect(name).toMatch(/^codex-pr-review-guchi-apps-issue-deck-4010-\d+-\d+\.json$/);
  });
});

describe("review_usage_backfill_logs（報告を入れる前の実行の補完）", () => {
  it("旧形式のログは実行の事実だけを「使用量の記録なし」で送り、tokens usedの合計から金額を推測しない", () => {
    const { dir, run, outbox } = setup("404");
    fs.writeFileSync(path.join(dir, "bin", "gh"), "#!/usr/bin/env bash\nprintf 'issue-3951'\n", { mode: 0o755 });
    const work = path.join(dir, "work");
    fs.mkdirSync(work);
    const base = path.join(work, "issue-deck-3955-b3199aad50d8");
    fs.writeFileSync(`${base}.md`, "prompt");
    fs.writeFileSync(
      `${base}.log`,
      "OpenAI Codex v0.160.0\n--------\nmodel: gpt-6.1-sol\nsession id: 01a102be-0ca3-7070-80ac-1ade1b1dff83\n--------\ntokens used\n30,793\n",
    );
    fs.writeFileSync(`${base}.out`, "<!-- issue-deck-codex-review-verdict:lgtm sha=b3199aad50d8 -->");
    // 新形式（--json）のログは見出しが無いので補完しない
    fs.writeFileSync(path.join(work, "issue-deck-4010-0123456789ab.log"), "Reading prompt from stdin...\n");
    // 別リポジトリのログは対象外
    fs.writeFileSync(path.join(work, "car-care-231-cb630a3e8ebd.log"), "session id: x\n");

    run(`review_usage_backfill_logs ${work} guchi-apps issue-deck`);
    run(`review_usage_backfill_logs ${work} guchi-apps issue-deck`);
    const files = outbox();
    expect(files).toHaveLength(1);
    const reported = JSON.parse(fs.readFileSync(path.join(dir, "outbox", files[0]), "utf-8"));
    expect(reported).toMatchObject({
      agent: "codex",
      attemptId: "01a102be-0ca3-7070-80ac-1ade1b1dff83",
      repository: "guchi-apps/issue-deck",
      prNumber: 3955,
      issueNumber: 3951,
      headSha: "b3199aad50d8",
      status: "completed",
      usage: null,
      models: ["gpt-6.1-sol"],
    });
    expect(fs.existsSync(path.join(work, "car-care-231-cb630a3e8ebd.log.usage-backfilled"))).toBe(false);
  });
});

describe("review_usage_codex_model", () => {
  it("明示したモデルはそのまま、autoはconfig.tomlの先頭のmodelを使う", () => {
    const { run, env } = setup();
    expect(run("review_usage_codex_model gpt-6-sol")).toBe("gpt-6-sol");
    expect(run("review_usage_codex_model auto")).toBe("");
    fs.mkdirSync(env.CODEX_HOME);
    fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), 'model = "gpt-6-luna"\n[profiles.x]\nmodel = "other"\n');
    expect(run("review_usage_codex_model auto")).toBe("gpt-6-luna");
  });
});
