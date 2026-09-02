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

/**
 * 転記のassistant行。`cacheFlat` を渡すと `cache_creation` の内訳を持たない古い形になる。
 * `exitPlanMode: true` で、計画/実装の境界（#2646）に使う`ExitPlanMode`のtool_use呼び出しを
 * 同じ行に載せる（実物のtranscriptでも同じ行にusageとtool_useが同居している）。
 * `editTool: true` / `bash: "..."` は、調査/実装/仕上げの境界（#2779）に使うtool_use呼び出し。
 */
function assistantLine(
  id: string,
  options: UsageOverrides & {
    cwd?: string;
    model?: string;
    timestamp?: string;
    exitPlanMode?: boolean;
    editTool?: boolean;
    bash?: string;
  } = {},
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
  const message: Record<string, unknown> = { id, model: options.model ?? "claude-opus-5", usage };
  const content: unknown[] = [];
  if (options.exitPlanMode) content.push({ type: "tool_use", name: "ExitPlanMode", input: {} });
  if (options.editTool) {
    content.push({ type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } });
  }
  if (options.bash) content.push({ type: "tool_use", name: "Bash", input: { command: options.bash } });
  if (content.length) message.content = content;
  return {
    type: "assistant",
    cwd: options.cwd ?? "/home/u/apps/issue-deck-worktrees/issue-2350",
    timestamp: options.timestamp ?? "2026-08-25T03:00:00.000Z",
    message,
  };
}

function aggregate(paths: string[], ...args: string[]) {
  return JSON.parse(callShell("session_usage_aggregate", paths.join("\n") + "\n", ...args));
}

function aggregateCodex(paths: string[]) {
  return JSON.parse(callShell("codex_session_usage_aggregate", paths.join("\n") + "\n"));
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

  it("入力側・出力側の内訳を単価から割って出す（トークン比ではない・#2626）", () => {
    // Opus 5。入力20k($0.1) + キャッシュ書き込み1h 1M($10) + キャッシュ読み出し20M($10) = $20.1、
    // 出力200k = $5.0。トークン比で按分すると入力$24.86 / 出力$0.24になってしまう組み合わせ。
    const file = writeTranscript("split.jsonl", [
      assistantLine("msg_1", { input: 20_000, cache1h: 1_000_000, cacheRead: 20_000_000, output: 200_000 }),
    ]);

    const result = aggregate([file]);
    expect(result.totals.inputCostUsd).toBeCloseTo(20.1, 4);
    expect(result.totals.outputCostUsd).toBeCloseTo(5.0, 4);
    // 内訳の合計は料金と一致する（画面が「料金＝入力＋出力」として読める）。
    expect(result.totals.inputCostUsd + result.totals.outputCostUsd).toBeCloseTo(
      result.totals.costUsd,
      4,
    );
    expect(result.sessions[0]).toMatchObject({ inputCostUsd: 20.1, outputCostUsd: 5.0 });
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

  describe("計画/実装のコスト内訳（#2646）", () => {
    it("ExitPlanModeが無いセッションは区分なし（null）を返す", () => {
      const file = writeTranscript("no-plan.jsonl", [
        assistantLine("msg_1", { output: 1000, timestamp: "2026-08-25T03:00:00.000Z" }),
        assistantLine("msg_2", { output: 1000, timestamp: "2026-08-25T03:05:00.000Z" }),
      ]);
      const result = aggregate([file]);
      expect(result.sessions[0].planCostUsd).toBeNull();
      expect(result.sessions[0].implementationCostUsd).toBeNull();
    });

    it("最後のExitPlanMode呼び出しを境に、計画と実装へ振り分ける", () => {
      const file = writeTranscript("plan.jsonl", [
        // 計画（承認前のやり取り）。ExitPlanMode自体もここに含める。
        assistantLine("msg_1", { output: 1000, timestamp: "2026-08-25T03:00:00.000Z" }),
        assistantLine("msg_2", {
          output: 1000,
          timestamp: "2026-08-25T03:05:00.000Z",
          exitPlanMode: true,
        }),
        // 実装（承認後）。
        assistantLine("msg_3", { output: 2000, timestamp: "2026-08-25T03:10:00.000Z" }),
        assistantLine("msg_4", { output: 2000, timestamp: "2026-08-25T03:15:00.000Z" }),
      ]);
      const result = aggregate([file]);
      const session = result.sessions[0];
      expect(session.planCostUsd).toBeGreaterThan(0);
      expect(session.implementationCostUsd).toBeGreaterThan(0);
      // 出力トークンが実装側で2倍なので、金額もおおむね2倍になるはず。
      expect(session.implementationCostUsd).toBeCloseTo(session.planCostUsd * 2, 3);
      expect(session.planCostUsd + session.implementationCostUsd).toBeCloseTo(session.costUsd, 3);
    });

    it("計画の修正でExitPlanModeが複数回呼ばれても、最後の1回だけを境に使う", () => {
      const file = writeTranscript("replan.jsonl", [
        assistantLine("msg_1", {
          output: 500,
          timestamp: "2026-08-25T03:00:00.000Z",
          exitPlanMode: true,
        }),
        // 修正を求められて計画をやり直す区間。ここも「計画」に含まれるべき。
        assistantLine("msg_2", { output: 500, timestamp: "2026-08-25T03:05:00.000Z" }),
        assistantLine("msg_3", {
          output: 500,
          timestamp: "2026-08-25T03:10:00.000Z",
          exitPlanMode: true,
        }),
        // 最終承認後の実装。
        assistantLine("msg_4", { output: 500, timestamp: "2026-08-25T03:15:00.000Z" }),
      ]);
      const result = aggregate([file]);
      const session = result.sessions[0];
      // 計画3応答・実装1応答ぶんの出力トークンなので、計画側が実装側の3倍になるはず。
      expect(session.planCostUsd).toBeCloseTo(session.implementationCostUsd * 3, 3);
    });
  });

  describe("実装の4区分（#2779）", () => {
    it("書き込みもコミットも無いセッションは、3つともnull（フェーズ未集計）にする", () => {
      // 全額が「調査」へ寄ると、実際には実装していたセッションまで調査として数えてしまう。
      const file = writeTranscript("no-phase.jsonl", [
        assistantLine("msg_1", { output: 1000, timestamp: "2026-08-25T03:00:00.000Z" }),
        assistantLine("msg_2", { output: 1000, timestamp: "2026-08-25T03:05:00.000Z" }),
      ]);
      const session = aggregate([file]).sessions[0];
      expect(session.researchCostUsd).toBeNull();
      expect(session.codingCostUsd).toBeNull();
      expect(session.wrapupCostUsd).toBeNull();
    });

    it("最初のファイル編集・最初のコミットを境に、調査・実装・仕上げへ振り分ける", () => {
      const file = writeTranscript("phases.jsonl", [
        // 調査（最初の編集より前）。
        assistantLine("msg_1", { output: 1000, timestamp: "2026-08-25T03:00:00.000Z" }),
        // 実装（最初の編集から最初のコミットまで）。編集した応答自体は実装に入る。
        assistantLine("msg_2", {
          output: 2000,
          timestamp: "2026-08-25T03:05:00.000Z",
          editTool: true,
        }),
        // 仕上げ（コミット以降）。コミットした応答自体は仕上げに入る。
        assistantLine("msg_3", {
          output: 3000,
          timestamp: "2026-08-25T03:10:00.000Z",
          bash: 'git add -A && git commit -m "x"',
        }),
      ]);
      const session = aggregate([file]).sessions[0];
      // 出力トークンが1:2:3なので、金額もその比になる。
      expect(session.codingCostUsd).toBeCloseTo(session.researchCostUsd * 2, 3);
      expect(session.wrapupCostUsd).toBeCloseTo(session.researchCostUsd * 3, 3);
      // 計画を使っていないセッションなので、3つの合計がそのまま全額になる。
      expect(
        session.researchCostUsd + session.codingCostUsd + session.wrapupCostUsd,
      ).toBeCloseTo(session.costUsd, 3);
    });

    it("`git -c user.name=\"Claude Code\" ... commit`のように値に空白が入っても境界として拾う", () => {
      // このフリートのコミットはこの形で、「`-`で始まる語の繰り返し」では拾えない。
      const file = writeTranscript("commit-with-config.jsonl", [
        assistantLine("msg_1", {
          output: 1000,
          timestamp: "2026-08-25T03:00:00.000Z",
          editTool: true,
        }),
        assistantLine("msg_2", {
          output: 1000,
          timestamp: "2026-08-25T03:05:00.000Z",
          bash: 'git add -A && git -c user.name="Claude Code" -c user.email="c@example.com" commit -q -m "x"',
        }),
      ]);
      const session = aggregate([file]).sessions[0];
      expect(session.wrapupCostUsd).toBeGreaterThan(0);
      expect(session.wrapupCostUsd).toBeCloseTo(session.codingCostUsd, 3);
    });

    it("ヒアドキュメントの本文に出てくる「commit」は境界にしない", () => {
      const file = writeTranscript("heredoc.jsonl", [
        assistantLine("msg_1", {
          output: 1000,
          timestamp: "2026-08-25T03:00:00.000Z",
          editTool: true,
        }),
        assistantLine("msg_2", {
          output: 1000,
          timestamp: "2026-08-25T03:05:00.000Z",
          bash: "python3 - <<'PY'\nprint('git history and commit messages')\nPY",
        }),
      ]);
      const session = aggregate([file]).sessions[0];
      expect(session.wrapupCostUsd).toBe(0);
      expect(session.codingCostUsd).toBeCloseTo(session.costUsd, 3);
    });
  });
});

describe("codex_session_usage_aggregate", () => {
  it("最後の累積値を使い、キャッシュ入力と通常入力を分ける", () => {
    const file = writeTranscript("codex.jsonl", [
      { type: "session_meta", timestamp: "2026-08-30T01:00:00.000Z", payload: { cwd: "/home/u/apps/issue-deck-worktrees/issue-2544" } },
      { type: "turn_context", timestamp: "2026-08-30T01:00:01.000Z", payload: { model: "gpt-5.6-sol" } },
      { type: "event_msg", timestamp: "2026-08-30T01:01:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50 } } } },
      { type: "event_msg", timestamp: "2026-08-30T01:02:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 2400, cache_write_input_tokens: 100, output_tokens: 200 } } } },
    ]);
    const result = aggregateCodex([file]);
    expect(result.totals).toMatchObject({ responses: 2, input: 500, cacheRead: 2400, cacheCreate5m: 100, output: 200 });
    expect(result.sessions[0]).toMatchObject({ repository: "issue-deck", issue: 2544, models: ["gpt-5.6-sol"] });
    expect(result.totals.costUsd).toBeCloseTo(0.0075, 4);
    // 入力側（非キャッシュ$4/1M・キャッシュ$0.4/1M・書き込み1.25倍）と出力側（$20/1M）を分けて出す。
    expect(result.totals.inputCostUsd).toBeCloseTo(0.0035, 4);
    expect(result.totals.outputCostUsd).toBeCloseTo(0.004, 4);
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

/**
 * issue-deckへの報告に畳む部分（#2504）。**転記のパスからセッションIDを取り、数値だけを送る**
 * ところが要点で、ここが崩れると受け口が行を一意にできず、走っている最中のセッションが
 * 報告のたびに二重に積まれる。
 */
describe("session_usage_report_payload", () => {
  function payloadLines(normalized: unknown, ...args: string[]) {
    return callShell("session_usage_report_payload", JSON.stringify(normalized), ...args)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  function normalizedSession(overrides: Record<string, unknown> = {}) {
    return {
      responses: 3,
      input: 10,
      cacheCreate5m: 20,
      cacheCreate1h: 30,
      cacheRead: 40,
      output: 50,
      costUsd: 1.25,
      inputCostUsd: 1.0,
      outputCostUsd: 0.25,
      kind: "implementation",
      repository: "issue-deck",
      issue: 2504,
      cwd: "/home/u/apps/issue-deck-worktrees/issue-2504",
      transcript: "/home/u/.claude/projects/-slug/abc-123.jsonl",
      models: ["claude-opus-5"],
      firstAt: "2026-08-30T01:00:00.000Z",
      lastAt: "2026-08-30T02:00:00.000Z",
      ...overrides,
    };
  }

  it("転記のファイル名をセッションIDにして、数値と分類だけを送る", () => {
    const [payload] = payloadLines({ sessions: [normalizedSession()] }, "subpc");

    expect(payload.host).toBe("subpc");
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]).toMatchObject({
      agent: "claude",
      sessionId: "abc-123",
      kind: "implementation",
      repository: "issue-deck",
      issue: 2504,
      responses: 3,
      cacheCreate1h: 30,
      costUsd: 1.25,
      inputCostUsd: 1.0,
      outputCostUsd: 0.25,
      startedAt: "2026-08-30T01:00:00.000Z",
      endedAt: "2026-08-30T02:00:00.000Z",
    });
    // やり取りの本文にあたるものを持ち出していないこと（持つのはパスまで）。
    expect(Object.keys(payload.sessions[0]).sort()).toEqual(
      [
        "agent",
        "cacheCreate1h",
        "cacheCreate5m",
        "cacheRead",
        "codingCostUsd",
        "costUsd",
        "endedAt",
        "implementationCostUsd",
        "input",
        "inputCostUsd",
        "issue",
        "kind",
        "models",
        "output",
        "outputCostUsd",
        "planCostUsd",
        "repository",
        "researchCostUsd",
        "responses",
        "sessionId",
        "startedAt",
        "transcript",
        "wrapupCostUsd",
      ].sort(),
    );
  });

  it("指定したエージェントを各セッションへ付ける", () => {
    const [payload] = payloadLines({ sessions: [normalizedSession()] }, "subpc", "200", "codex");
    expect(payload.sessions[0].agent).toBe("codex");
  });

  it("時刻を持たないセッションは送らない（期間で絞れないため）", () => {
    const [payload] = payloadLines(
      { sessions: [normalizedSession({ firstAt: null, lastAt: null })] },
      "subpc",
    );
    expect(payload.sessions).toEqual([]);
  });

  it("件数が多いときは指定した数ごとに分けて出す（1回のPOSTで抱え込まない）", () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      normalizedSession({ transcript: `/home/u/.claude/projects/-slug/id-${n}.jsonl` }),
    );
    const lines = payloadLines({ sessions }, "subpc", "2");

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.sessions.length)).toEqual([2, 2, 1]);
    // 同じ報告として扱えるよう、時刻は全ての行で揃っている。
    expect(new Set(lines.map((line) => line.reportedAt)).size).toBe(1);
  });

  it("送るものが無くても1行は出す（呼び出し側が空と失敗を区別できるように）", () => {
    const lines = payloadLines({ sessions: [] }, "subpc");
    expect(lines).toHaveLength(1);
    expect(lines[0].sessions).toEqual([]);
  });
});
