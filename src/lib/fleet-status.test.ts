import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 並行状況スナップショット（`scripts/lib/fleet-status.sh`・#1215）のテスト。
 *
 * **シェルをそのまま起こして叩く**（`src/lib/prompts/kickoff-prompt.test.ts` と同じ形）。
 * 入口（`scripts/fleet-status.sh`）はtmux・git・ghを叩くのでテストから実行せず、
 * **その出力を固定したfixtureとして純粋関数へ食わせる**。整形と重なりの判定はすべて
 * こちら側にあるので、これで判定ロジックは覆える。
 *
 * ここで一番効くのは「重なりの判定を緩めていないか」。別リポジトリ同士・同じIssueの表と裏を
 * 重なりとして出し始めると、毎回何かしら出る＝誰も読まない表になる。
 */
const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/lib/fleet-status.sh");

function callShell(fn: string, input: string, ...args: string[]): string {
  return execFileSync("bash", ["-c", `source "$0"; ${fn} "$@"`, SCRIPT_PATH, ...args], {
    encoding: "utf-8",
    input,
  });
}

/** 非0で返る関数を、落ちずに判定できる形で呼ぶ */
function callSessionKey(name: string): string {
  return execFileSync(
    "bash",
    ["-c", `source "$0"; fleet_status_session_key "$1" || printf NOMATCH`, SCRIPT_PATH, name],
    { encoding: "utf-8" },
  );
}

/** レコードストリームを組み立てる小道具（テスト側で列を数えなくて済むように） */
function record(...cols: (string | number)[]): string {
  return cols.map(String).join("\t");
}

describe("fleet_status_session_key", () => {
  it("<リポジトリ名>-issue-<番号> を分解する", () => {
    expect(callSessionKey("issue-deck-issue-1215")).toBe("issue-deck\t1215");
  });

  it("リポジトリ名側に -issue- を含んでいても、末尾の区切りで分解する", () => {
    // 先頭から探すと `foo` と `tracker-issue-12` に割れて番号が取れない
    expect(callSessionKey("foo-issue-tracker-issue-12")).toBe("foo-issue-tracker\t12");
  });

  it("Issueに紐づかない名前・0始まりの番号は分解しない", () => {
    expect(callSessionKey("scratch")).toBe("NOMATCH");
    expect(callSessionKey("issue-deck-issue-")).toBe("NOMATCH");
    expect(callSessionKey("issue-deck-issue-012")).toBe("NOMATCH");
  });
});

describe("fleet_status_parse_sessions", () => {
  it("tmuxの一覧からIssueに紐づくセッションだけを拾う", () => {
    const tmux = ["issue-deck-issue-1215", "scratch", "ops-dashboard-issue-72", ""].join("\n");
    expect(callShell("fleet_status_parse_sessions", tmux)).toBe(
      [
        "issue-deck-issue-1215\tissue-deck\t1215",
        "ops-dashboard-issue-72\tops-dashboard\t72",
      ].join("\n") + "\n",
    );
  });

  it("tmuxサーバーが起動していない（出力が空）ときは何も出さずに正常終了する", () => {
    // 入口は `tmux ... || true` で空を渡してくる。0本走っているのと区別する意味は無い
    expect(callShell("fleet_status_parse_sessions", "")).toBe("");
  });
});

describe("fleet_status_parse_worktrees", () => {
  it("`git worktree list --porcelain` からブランチとパスを取り出す", () => {
    const porcelain = [
      "worktree /home/u/apps/issue-deck",
      "HEAD aaaaaaa",
      "branch refs/heads/develop",
      "",
      "worktree /home/u/apps/issue-deck-worktrees/issue-1215",
      "HEAD bbbbbbb",
      "branch refs/heads/issue-1215",
      "",
    ].join("\n");
    expect(callShell("fleet_status_parse_worktrees", porcelain)).toBe(
      [
        "develop\t/home/u/apps/issue-deck",
        "issue-1215\t/home/u/apps/issue-deck-worktrees/issue-1215",
      ].join("\n") + "\n",
    );
  });

  it("detached HEAD のworktree（branch行を持たない）は落とす", () => {
    const porcelain = ["worktree /tmp/detached", "HEAD cccccccc", "detached", ""].join("\n");
    expect(callShell("fleet_status_parse_worktrees", porcelain)).toBe("");
  });
});

describe("fleet_status_parse_prs", () => {
  it("PRと変更ファイルをレコードに分解し、headRefNameからIssue番号を復元する", () => {
    const json = JSON.stringify([
      {
        number: 1594,
        title: "実行キューにセッション一覧を出す",
        headRefName: "issue-1567",
        files: [{ path: "scripts/subpc-dispatch-poller.sh" }, { path: "docs/x.md" }],
      },
    ]);
    expect(callShell("fleet_status_parse_prs", json)).toBe(
      [
        "pr\t1594\t1567\tissue-1567\t2\t0\t実行キューにセッション一覧を出す",
        "prfile\t1594\tscripts/subpc-dispatch-poller.sh",
        "prfile\t1594\tdocs/x.md",
      ].join("\n") + "\n",
    );
  });

  it("issue-<番号> でないブランチのPRはIssue番号を空にする", () => {
    const json = JSON.stringify([{ number: 7, title: "t", headRefName: "release/v1", files: [] }]);
    expect(callShell("fleet_status_parse_prs", json)).toBe("pr\t7\t\trelease/v1\t0\t0\tt\n");
  });

  it("ファイルが100件（APIの1ページぶん）に達したPRは打ち切りとして印を付ける", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const json = JSON.stringify([{ number: 1, title: "big", headRefName: "issue-2", files }]);
    const first = callShell("fleet_status_parse_prs", json).split("\n")[0];
    expect(first).toBe("pr\t1\t2\tissue-2\t100\t1\tbig");
  });

  it("ghが失敗して空・JSONが壊れていても落ちない", () => {
    expect(callShell("fleet_status_parse_prs", "")).toBe("");
    expect(callShell("fleet_status_parse_prs", "not json")).toBe("");
  });
});

describe("fleet_status_build_json", () => {
  const base = record("base", "develop", "abc1234def", "先端のコミット", "guchi-apps/issue-deck");

  function build(lines: string[]): {
    repository: string;
    base: { branch: string; sha: string; subject: string };
    sessions: { name: string; issue: number | null; files: string[] }[];
    pullRequests: { number: number; issue: number | null; files: string[] }[];
    overlaps: { a: { label: string }; b: { label: string }; files: string[] }[];
  } {
    return JSON.parse(callShell("fleet_status_build_json", lines.join("\n") + "\n"));
  }

  it("同じファイルを触っているセッションとPRを重なりとして出す", () => {
    const result = build([
      base,
      record(
        "session",
        "issue-deck-issue-1215",
        "guchi-apps/issue-deck",
        "1215",
        "/w/issue-1215",
        "issue-1215",
        "abc1234",
        "2",
        "1",
        "1",
      ),
      record("sfile", "issue-deck-issue-1215", "scripts/start-issue.sh"),
      record("sfile", "issue-deck-issue-1215", "scripts/lib/fleet-status.sh"),
      record("pr", "1594", "1567", "issue-1567", "2", "0", "別のPR"),
      record("prfile", "1594", "scripts/start-issue.sh"),
      record("prfile", "1594", "docs/x.md"),
    ]);

    expect(result.overlaps).toHaveLength(1);
    expect(result.overlaps[0].a.label).toBe("issue-deck-issue-1215");
    expect(result.overlaps[0].b.label).toBe("#1594");
    expect(result.overlaps[0].files).toEqual(["scripts/start-issue.sh"]);
  });

  it("同じIssueのセッションとPRは重なりにしない（同じ作業の表と裏）", () => {
    const result = build([
      base,
      record(
        "session",
        "issue-deck-issue-1567",
        "guchi-apps/issue-deck",
        "1567",
        "/w/issue-1567",
        "issue-1567",
        "abc1234",
        "0",
        "0",
        "0",
      ),
      record("sfile", "issue-deck-issue-1567", "scripts/poller.sh"),
      record("pr", "1594", "1567", "issue-1567", "1", "0", "同じIssueのPR"),
      record("prfile", "1594", "scripts/poller.sh"),
    ]);
    expect(result.overlaps).toEqual([]);
  });

  it("リポジトリが違う組は、同じパスでも重なりにしない", () => {
    // `docs/README.md` のような名前は別リポジトリ間で偶然一致するが、衝突はしない
    const result = build([
      base,
      record(
        "session",
        "issue-deck-issue-1215",
        "guchi-apps/issue-deck",
        "1215",
        "/w/a",
        "issue-1215",
        "abc1234",
        "0",
        "0",
        "0",
      ),
      record("sfile", "issue-deck-issue-1215", "docs/README.md"),
      record(
        "session",
        "ops-dashboard-issue-72",
        "guchi-apps/ops-dashboard",
        "72",
        "/w/b",
        "issue-72",
        "ffffff1",
        "0",
        "0",
        "0",
      ),
      record("sfile", "ops-dashboard-issue-72", "docs/README.md"),
    ]);
    expect(result.overlaps).toEqual([]);
  });

  it("重なりはファイル数の多い順に並べる", () => {
    const result = build([
      base,
      record("session", "issue-deck-issue-1", "guchi-apps/issue-deck", "1", "/w/1", "issue-1", "abc1234", "0", "0", "0"),
      record("sfile", "issue-deck-issue-1", "a.ts"),
      record("sfile", "issue-deck-issue-1", "b.ts"),
      record("pr", "10", "2", "issue-2", "2", "0", "2ファイル重なる"),
      record("prfile", "10", "a.ts"),
      record("prfile", "10", "b.ts"),
      record("pr", "11", "3", "issue-3", "1", "0", "1ファイル重なる"),
      record("prfile", "11", "a.ts"),
    ]);
    // セッション×#10（a・b）／セッション×#11（a）／#10×#11（a）の3組
    expect(result.overlaps.map((o) => o.files.length)).toEqual([2, 1, 1]);
    expect(result.overlaps[0].b.label).toBe("#10");
  });

  it("セッションもPRも無いとき、空の枠だけを返す", () => {
    const result = build([base]);
    expect(result.repository).toBe("guchi-apps/issue-deck");
    expect(result.base.sha).toBe("abc1234def");
    expect(result.sessions).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.overlaps).toEqual([]);
  });

  it("何も渡されなくても壊れたJSONを吐かない", () => {
    const result = JSON.parse(callShell("fleet_status_build_json", ""));
    expect(result.repository).toBeNull();
    expect(result.sessions).toEqual([]);
  });
});

describe("fleet_status_render_table", () => {
  it("セッションが0本でも表として成立する", () => {
    const json = JSON.stringify({
      repository: "guchi-apps/issue-deck",
      base: { branch: "develop", sha: "abc1234def5678", subject: "先端" },
      sessions: [],
      pullRequests: [],
      overlaps: [],
    });
    const table = callShell("fleet_status_render_table", json);
    expect(table).toContain("develop の先端: abc1234 先端");
    expect(table).toContain("（走っているセッションはありません）");
    expect(table).toContain("（未マージのPRはありません）");
    expect(table).toContain("（同じファイルを触っている組はありません）");
  });

  it("別リポジトリのセッションは変更数を数字で出さない（集めていないため）", () => {
    // 0件と「集めていない」を取り違えると、重なりが無いことの根拠として読まれてしまう
    const json = JSON.stringify({
      repository: "guchi-apps/issue-deck",
      base: { branch: "develop", sha: "abc1234", subject: "先端" },
      sessions: [
        {
          name: "ops-dashboard-issue-72",
          repository: "guchi-apps/ops-dashboard",
          issue: 72,
          worktree: "/w/ops",
          branch: "issue-72",
          baseSha: "fff1111",
          behind: 3,
          dirty: 0,
          self: false,
          files: [],
        },
      ],
      pullRequests: [],
      overlaps: [],
    });
    const line = callShell("fleet_status_render_table", json)
      .split("\n")
      .find((l) => l.includes("ops-dashboard-issue-72"));
    expect(line).toContain("（別リポジトリ）");
    expect(line).toMatch(/-\s+（別リポジトリ）$/);
  });

  it("重なりはファイルを並べて出し、多いときは畳む", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const json = JSON.stringify({
      repository: "guchi-apps/issue-deck",
      base: { branch: "develop", sha: "abc1234", subject: "先端" },
      sessions: [],
      pullRequests: [],
      overlaps: [
        {
          a: { kind: "session", label: "issue-deck-issue-1215", repository: "r", issue: 1215 },
          b: { kind: "pr", label: "#1594", repository: "r", issue: 1567 },
          files,
        },
      ],
    });
    const table = callShell("fleet_status_render_table", json);
    expect(table).toContain("issue-deck-issue-1215 × #1594（12ファイル）");
    expect(table).toContain("src/f0.ts");
    expect(table).toContain("…他2件");
    expect(table).not.toContain("src/f11.ts");
  });

  it("先端が取れなかったときもその旨を出して落ちない", () => {
    const json = JSON.stringify({
      repository: null,
      base: { branch: null, sha: null, subject: null },
      sessions: [],
      pullRequests: [],
      overlaps: [],
    });
    expect(callShell("fleet_status_render_table", json)).toContain("（取得できませんでした）");
  });

  it("JSONが壊れていても落ちない", () => {
    expect(callShell("fleet_status_render_table", "not json")).toContain(
      "並行状況を組み立てられませんでした",
    );
  });
});
