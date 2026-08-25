import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * ローカルセッションのトークン使用量の集計（`scripts/lib/session-usage.sh`・#2350）のテスト。
 *
 * **シェルをそのまま起こして叩く**（`src/lib/fleet-status.test.ts` と同じ形）。入口
 * （`scripts/session-usage.sh`）は引数の解釈と期間の計算だけなのでテストから実行せず、
 * **転記のfixtureを書いて集計関数へ食わせる**。
 *
 * ここで一番効くのは「`message.id`の重複除去が効いているか」。転記は同じ`message.id`を持つ
 * 全content行にusageを重複して書くため、除去を外すと応答数もトークンも金額も水増しされる
 * （`guchi-apps/question#34`の調査は最初これを踏んで約2.5倍に見積もった）。次に効くのが
 * キャッシュ書き込みの単価で、TTLの内訳（5分1.25倍・1時間2.0倍）を無視して一律1.25倍に
 * すると2割ほど低く出る。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/session-usage.sh");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function callShell(fn: string, input: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `source "$0"; ${fn} "$@"`, SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    input,
  });
}

/** 転記のfixtureを書き、そのパスを返す */
function writeTranscript(name: string, lines: unknown[]): string {
  if (!tempDirs.length) {
    tempDirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-")));
  }
  const file = path.join(tempDirs[0], name);
  fs.writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

type UsageOverrides = {
  input?: number;
  cache5m?: number;
  cache1h?: number;
  cacheFlat?: number | null;
  cacheRead?: number;
  output?: number;
};

/** 転記のassistant行。`cacheFlat` を渡すと `cache_creation` の内訳を持たない古い形になる */
function assistantLine(
  id: string,
  options: UsageOverrides & { cwd?: string; model?: string; timestamp?: string } = {},
) {
  const usage: Record<string, unknown> = {
    input_tokens: options.input ?? 0,
    cache_read_input_tokens: options.cacheRead ?? 0,
    output_tokens: options.output ?? 0,
  };
  if (options.cacheFlat != null) {
    usage.cache_creation_input_tokens = options.cacheFlat;
  } else {
    usage.cache_creation_input_tokens = (options.cache5m ?? 0) + (options.cache1h ?? 0);
    usage.cache_creation = {
      ephemeral_5m_input_tokens: options.cache5m ?? 0,
      ephemeral_1h_input_tokens: options.cache1h ?? 0,
    };
  }
  return {
    type: "assistant",
    cwd: options.cwd ?? "/home/u/apps/issue-deck-worktrees/issue-2350",
    timestamp: options.timestamp ?? "2026-08-25T03:00:00.000Z",
    message: { id, model: options.model ?? "claude-opus-5", usage },
  };
}

function aggregate(paths: string[], ...args: string[]) {
  return JSON.parse(callShell("session_usage_aggregate", paths.join("\n") + "\n", ...args));
}

describe("session_usage_aggregate", () => {
  it("同じmessage.idの行を1応答として数える（usageは全content行に重複して書かれる）", () => {
    // 同じ応答が3行に分かれて書かれている転記。除去しないと3応答・3倍のトークンになる。
    const file = writeTranscript("dup.jsonl", [
      assistantLine("msg_1", { input: 10, cacheRead: 1000, output: 100 }),
      assistantLine("msg_1", { input: 10, cacheRead: 1000, output: 100 }),
      assistantLine("msg_1", { input: 10, cacheRead: 1000, output: 100 }),
      assistantLine("msg_2", { input: 20, cacheRead: 2000, output: 200 }),
    ]);

    const result = aggregate([file]);
    expect(result.totals.responses).toBe(2);
    expect(result.totals.duplicateRows).toBe(2);
    expect(result.totals.output).toBe(300);
    expect(result.totals.cacheRead).toBe(3000);
  });

  it("複数の転記に同じmessage.idがあるとき、先に渡されたほうへ計上する", () => {
    // セッションを枝分かれさせると、それまでのやり取りごと新しいファイルへ写される。
    // 入口は最終更新の古い順で渡すので、写しではなく元のセッションに付く。
    const original = writeTranscript("original.jsonl", [assistantLine("msg_1", { output: 100 })]);
    const forked = writeTranscript("forked.jsonl", [
      assistantLine("msg_1", { output: 100, cwd: "/home/u/apps/issue-deck-worktrees/issue-9999" }),
      assistantLine("msg_2", { output: 50, cwd: "/home/u/apps/issue-deck-worktrees/issue-9999" }),
    ]);

    const result = aggregate([original, forked]);
    expect(result.totals.responses).toBe(2);
    const byIssue = Object.fromEntries(result.sessions.map((s: { issue: number; output: number }) => [s.issue, s.output]));
    expect(byIssue).toEqual({ 2350: 100, 9999: 50 });
  });

  it("キャッシュ書き込みはTTLごとの単価で計算する（5分1.25倍・1時間2.0倍）", () => {
    // Opus 5 は入力 $5/1M。1Mトークンぶんずつ書いたときの差が単価差そのものになる。
    const fiveMinutes = writeTranscript("5m.jsonl", [assistantLine("msg_1", { cache5m: 1_000_000 })]);
    const oneHour = writeTranscript("1h.jsonl", [assistantLine("msg_2", { cache1h: 1_000_000 })]);

    expect(aggregate([fiveMinutes]).totals.costUsd).toBeCloseTo(6.25, 4);
    expect(aggregate([oneHour]).totals.costUsd).toBeCloseTo(10.0, 4);
  });

  it("cache_creationの内訳が無い転記は、すべて5分TTL（安いほう）として扱う", () => {
    const file = writeTranscript("flat.jsonl", [assistantLine("msg_1", { cacheFlat: 1_000_000 })]);
    const result = aggregate([file]);
    expect(result.totals.costUsd).toBeCloseTo(6.25, 4);
    expect(result.totals.cacheCreate1h).toBe(0);
  });

  it("入力・キャッシュ読み出し・出力をそれぞれの単価で足し合わせる", () => {
    // 入力 $5 + キャッシュ読み出し $0.5(0.1倍) + 出力 $25 = $30.5
    const file = writeTranscript("mix.jsonl", [
      assistantLine("msg_1", { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }),
    ]);
    expect(aggregate([file]).totals.costUsd).toBeCloseTo(30.5, 4);
  });

  it("作業ディレクトリから種別・リポジトリ・Issue番号を決める", () => {
    const implementation = writeTranscript("impl.jsonl", [
      assistantLine("msg_1", { cwd: "/home/u/apps/dayspan-worktrees/issue-222", output: 1 }),
    ]);
    const other = writeTranscript("other.jsonl", [
      assistantLine("msg_2", { cwd: "/home/u/apps/issue-deck", output: 1 }),
    ]);

    const result = aggregate([implementation, other]);
    const rows = Object.fromEntries(
      result.sessions.map((s: { transcript: string }) => [path.basename(s.transcript), s]),
    );
    expect(rows["impl.jsonl"]).toMatchObject({ kind: "implementation", repository: "dayspan", issue: 222 });
    expect(rows["other.jsonl"]).toMatchObject({ kind: "other", repository: "issue-deck", issue: null });
  });

  it("計画レビュー・横断質問はパスに番号が無いので、最初のユーザー発言から拾う", () => {
    // 作業場は対象リポジトリごとに使い回されるため、番号は起動プロンプトにしか出てこない。
    const planReview = writeTranscript("plan.jsonl", [
      {
        type: "user",
        cwd: "/home/u/apps/issue-deck-worktrees/.plan-reviews/_refs/guchi-apps-dayspan",
        message: { content: [{ type: "text", text: "あなたは計画の関門です。Issue #222 に投稿された計画を…" }] },
      },
      assistantLine("msg_1", {
        cwd: "/home/u/apps/issue-deck-worktrees/.plan-reviews/_refs/guchi-apps-dayspan",
        output: 1,
      }),
    ]);

    const [row] = aggregate([planReview]).sessions;
    // ownerの前置きは落として、実装セッションと同じリポジトリ名へ揃える。
    expect(row).toMatchObject({ kind: "plan-review", repository: "dayspan", issue: 222 });
  });

  it("しきい値より古い行は数えず、1行も残らない転記は行にしない", () => {
    // 2026-08-25T00:00:00Z = 1787616000
    const file = writeTranscript("old.jsonl", [
      assistantLine("msg_old", { timestamp: "2026-08-24T23:00:00.000Z", output: 100 }),
      assistantLine("msg_new", { timestamp: "2026-08-25T01:00:00.000Z", output: 7 }),
    ]);
    const onlyOld = writeTranscript("only-old.jsonl", [
      assistantLine("msg_older", { timestamp: "2026-01-01T00:00:00.000Z", output: 100 }),
    ]);

    const result = aggregate([file, onlyOld], "1787616000");
    expect(result.totals.responses).toBe(1);
    expect(result.totals.output).toBe(7);
    expect(result.sessions).toHaveLength(1);
  });

  it("Issue番号・リポジトリで絞り込む", () => {
    const mine = writeTranscript("mine.jsonl", [
      assistantLine("msg_1", { cwd: "/home/u/apps/dayspan-worktrees/issue-222", output: 1 }),
    ]);
    const others = writeTranscript("others.jsonl", [
      assistantLine("msg_2", { cwd: "/home/u/apps/issue-deck-worktrees/issue-222", output: 1 }),
    ]);

    expect(aggregate([mine, others], "0", "222").sessions).toHaveLength(2);
    expect(aggregate([mine, others], "0", "222", "dayspan").sessions).toHaveLength(1);
    expect(aggregate([mine, others], "0", "999").sessions).toHaveLength(0);
  });

  it("単価表に無いモデルはAPI換算に含めず、名前を残す", () => {
    const file = writeTranscript("unknown.jsonl", [
      assistantLine("msg_1", { model: "claude-future-9", output: 1_000_000 }),
      // Claude Codeが自分で差し込む行は課金対象ではないので、警告にも出さない。
      assistantLine("msg_2", { model: "<synthetic>", output: 1_000_000 }),
    ]);

    const result = aggregate([file]);
    expect(result.totals.costUsd).toBe(0);
    expect(result.unknownModels).toEqual(["claude-future-9"]);
  });

  it("日付サフィックス付きのモデルIDは前方一致で単価を引く", () => {
    const file = writeTranscript("dated.jsonl", [
      assistantLine("msg_1", { model: "claude-haiku-4-5-20251001", output: 1_000_000 }),
    ]);
    const result = aggregate([file]);
    expect(result.totals.costUsd).toBeCloseTo(5.0, 4);
    expect(result.unknownModels).toEqual([]);
  });

  it("壊れた行・usageを持たない行・読めないファイルがあっても落ちない", () => {
    const file = writeTranscript("broken.jsonl", [
      "{壊れたJSON",
      { type: "user", cwd: "/home/u/apps/issue-deck-worktrees/issue-2350", message: { content: "こんにちは" } },
      '{"type":"assistant","message":{"id":"msg_no_usage","model":"claude-opus-5"}}',
      assistantLine("msg_1", { output: 42 }),
    ]);

    const result = aggregate([file, path.join(path.dirname(file), "存在しない.jsonl")]);
    expect(result.totals.responses).toBe(1);
    expect(result.totals.output).toBe(42);
    expect(result.totals.unreadableTranscripts).toBe(1);
  });
});

describe("session_usage_render_table", () => {
  const sample = JSON.stringify({
    totals: {
      responses: 120,
      output: 66_000,
      cacheRead: 14_500_000,
      costUsd: 11.85,
      sessions: 2,
      transcripts: 2,
      duplicateRows: 45,
    },
    sessions: [
      {
        kind: "implementation",
        kindLabel: "実装",
        repository: "issue-deck",
        issue: 2345,
        responses: 88,
        output: 50_000,
        cacheRead: 12_400_000,
        contextTokens: 12_672_000,
        avgContext: 144_000,
        costUsd: 9.72,
      },
      {
        kind: "plan-review",
        kindLabel: "計画レビュー",
        repository: "issue-deck",
        issue: 2345,
        responses: 32,
        output: 16_000,
        cacheRead: 2_100_000,
        contextTokens: 2_144_000,
        avgContext: 67_000,
        costUsd: 2.14,
      },
    ],
    byDay: [{ date: "2026-08-25", responses: 120, output: 66_000, cacheRead: 14_500_000, contextTokens: 14_816_000, costUsd: 11.85 }],
    byModel: [{ model: "claude-opus-5", responses: 120, output: 66_000, cacheRead: 14_500_000, contextTokens: 14_816_000, costUsd: 11.85 }],
    unknownModels: [],
  });

  it("セッション別の表を出し、合計と重複除去した行数を添える", () => {
    const table = callShell("session_usage_render_table", sample, "session", "20");
    expect(table).toMatch(/実装\s+issue-deck#2345/);
    expect(table).toContain("計画レビュー");
    expect(table).toContain("$9.72");
    expect(table).toContain("合計: 2セッション / 120応答");
    // 重複除去が効いていることを出力から確かめられるようにしてある。
    expect(table).toContain("重複除去した行 45件");
  });

  it("種別でまとめる", () => {
    const table = callShell("session_usage_render_table", sample, "kind", "20");
    expect(table).toContain("種別別（2件）");
    expect(table).toContain("実装");
  });

  it("--limit で表の行数を絞り、隠した件数を出す", () => {
    const table = callShell("session_usage_render_table", sample, "session", "1");
    expect(table).toContain("…他1件");
  });

  it("onelineは合計だけを1行で出す（inspect-session.shの見出し用）", () => {
    const line = callShell("session_usage_render_table", sample, "oneline").trim();
    expect(line).toBe("120応答 / 出力 66k / キャッシュ読出 14.5M / API換算 $11.85");
  });

  it("単価表に無いモデルがあれば警告を添える", () => {
    const withUnknown = JSON.stringify({ ...JSON.parse(sample), unknownModels: ["claude-future-9"] });
    expect(callShell("session_usage_render_table", withUnknown, "session", "20")).toContain("claude-future-9");
  });

  it("JSONが壊れていても落ちない", () => {
    expect(callShell("session_usage_render_table", "壊れている", "session", "20")).toContain(
      "使用量を集計できませんでした",
    );
  });
});
