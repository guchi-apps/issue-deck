import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// タグの書き換えは `.github/scripts/propagate-workflow-tag.sh` が sed で行う（#1173）。
// GitHub API を伴う部分（Issue作成・PR作成）は切り離せないため、**書き換えと判定のロジックだけ**を
// 同じコマンド列で再現して確認する。
//
// 実際に踏んだ事故ではないが、ここを間違えると他リポジトリのワークフローを壊すため、
// `ci.yml` のような共有ワークフローと無関係なファイルを触らないことを含めて固定する。
const SCRIPT = join(process.cwd(), ".github", "scripts", "propagate-workflow-tag.sh");

let workspace: string | null = null;

function setup(files: Record<string, string>): string {
  workspace = mkdtempSync(join(tmpdir(), "propagate-"));
  mkdirSync(join(workspace, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(workspace, ".github", "workflows", name), body);
  }
  return workspace;
}

/** スクリプト本体から書き換え部分だけを取り出して実行する */
function rewrite(dir: string, tag: string): void {
  execFileSync(
    "bash",
    [
      "-c",
      `cd "${dir}" && for FILE in .github/workflows/*.yml; do grep -q '@workflows/v' "$FILE" || continue; sed -i -e "s|@workflows/v[0-9]\\+|@${tag}|g" -e "s|prompts-ref: workflows/v[0-9]\\+|prompts-ref: ${tag}|g" "$FILE"; done`,
    ],
    { encoding: "utf8" },
  );
}

/** 「既に目的のタグか」の判定。真なら更新が必要 */
function needsUpdate(dir: string, tag: string): boolean {
  const result = execFileSync(
    "bash",
    [
      "-c",
      `cd "${dir}" && grep -rhoE "@workflows/v[0-9]+|prompts-ref: workflows/v[0-9]+" .github/workflows/ | grep -qv "${tag.replace("workflows/", "")}\\$" && echo yes || echo no`,
    ],
    { encoding: "utf8" },
  );
  return result.trim() === "yes";
}

const DISPATCH = `jobs:
  dispatch:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-dispatch.yml@workflows/v11
    with:
      prompts-ref: workflows/v11
`;

const LABELS = `jobs:
  labels:
    uses: guchi-apps/issue-deck/.github/workflows/reusable-issue-labels.yml@workflows/v11
`;

const CI = `jobs:
  test:
    steps:
      - uses: actions/checkout@v4
`;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe("propagate-workflow-tag.sh の書き換え", () => {
  it("スクリプトの構文が正しい", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("uses と prompts-ref を同時に書き換える", () => {
    // **片方だけ上げると、新しいワークフローで古いプロンプトが使われる**
    const dir = setup({ "claude-issue-dispatch.yml": DISPATCH });

    rewrite(dir, "workflows/v12");

    const body = readFileSync(join(dir, ".github/workflows/claude-issue-dispatch.yml"), "utf8");
    expect(body).toContain("@workflows/v12");
    expect(body).toContain("prompts-ref: workflows/v12");
    expect(body).not.toContain("v11");
  });

  it("共有ワークフローと無関係なファイルは触らない", () => {
    const dir = setup({ "claude-issue-dispatch.yml": DISPATCH, "ci.yml": CI });

    rewrite(dir, "workflows/v12");

    // actions/checkout@v4 を @workflows/v12 に置き換えてしまうと、CIが壊れる
    expect(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8")).toBe(CI);
  });

  it("複数ファイルをまとめて書き換える", () => {
    const dir = setup({ "claude-issue-dispatch.yml": DISPATCH, "issue-labels.yml": LABELS });

    rewrite(dir, "workflows/v12");

    for (const name of ["claude-issue-dispatch.yml", "issue-labels.yml"]) {
      expect(readFileSync(join(dir, ".github/workflows", name), "utf8"), name).toContain(
        "@workflows/v12",
      );
    }
  });

  it("古いタグがあれば更新が必要と判定する", () => {
    const dir = setup({ "claude-issue-dispatch.yml": DISPATCH });

    expect(needsUpdate(dir, "workflows/v12")).toBe(true);
  });

  it("書き換え後は更新不要と判定する（空のPRを作らない）", () => {
    const dir = setup({ "claude-issue-dispatch.yml": DISPATCH, "issue-labels.yml": LABELS });

    rewrite(dir, "workflows/v12");

    expect(needsUpdate(dir, "workflows/v12")).toBe(false);
  });

  it("uses だけ新しく prompts-ref が古い場合も更新が必要と判定する", () => {
    // 最新タグと同じでも、prompts-ref がずれていれば配り直す必要がある
    const dir = setup({
      "claude-issue-dispatch.yml": DISPATCH.replace(
        "reusable-issue-dispatch.yml@workflows/v11",
        "reusable-issue-dispatch.yml@workflows/v12",
      ),
    });

    expect(needsUpdate(dir, "workflows/v12")).toBe(true);
  });
});

/**
 * 自動マージの分岐（#1602）。GitHub API を伴うため実行はできないので、**分岐の構造と
 * 順序**を固定する。ここが崩れると、Issueだけが14件残る・PRが二重に作られる・
 * 1件の失敗で残りの配布が止まる、のいずれかになる。
 */
describe("propagate-workflow-tag.sh の自動マージ", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("既定は自動マージしない（単体で叩いたときにマージまで進めない）", () => {
    expect(source).toContain('AUTO_MERGE="${AUTO_MERGE:-false}"');
  });

  it("自動マージのときはIssueを作らず workflow-tag/ のブランチを使う", () => {
    // マージ後に人が閉じるだけのIssueが、配布のたびにリポジトリ数ぶん残るのを避ける
    const autoMergeBranch = source.indexOf('BRANCH="workflow-tag/${TAG#workflows/}"');
    const issueCreate = source.indexOf("gh issue create");

    expect(autoMergeBranch).toBeGreaterThan(-1);
    // Issue作成は else 側（自動マージしない場合）にだけある
    expect(issueCreate).toBeGreaterThan(autoMergeBranch);
    expect(source.match(/gh issue create/g)).toHaveLength(1);
  });

  it("ブランチ名はタグから作られる", () => {
    const branch = execFileSync(
      "bash",
      ["-c", 'TAG="workflows/v19"; printf %s "workflow-tag/${TAG#workflows/}"'],
      { encoding: "utf8" },
    );

    expect(branch).toBe("workflow-tag/v19");
  });

  it("自動マージは予約（--auto）を先に試し、駄目ならその場でマージする", () => {
    // 必須チェックを持つリポジトリではCIの成功を待たせたい。予約が使えないリポジトリだけ
    // その場でマージする
    const auto = source.indexOf("gh pr merge \"$PR_URL\" --squash --delete-branch --auto");
    const direct = source.indexOf('elif gh pr merge "$PR_URL" --squash --delete-branch');

    expect(auto).toBeGreaterThan(-1);
    expect(direct).toBeGreaterThan(auto);
  });

  it("残骸ブランチの上書きは期待値を明示した --force-with-lease で行う", () => {
    // 素の`--force-with-lease`は追跡refを比較対象にするが、単一ブランチcloneはこのブランチの
    // 追跡refを持たないため`stale info`で断られる（下の実測テスト）
    expect(source).toContain('--force-with-lease="$BRANCH:$REMOTE_SHA"');
    expect(source).toContain('git fetch --quiet --depth 1 origin "+refs/heads/$BRANCH:');
  });

  it("残骸ブランチが残っていても上書きできる（実際にpushして確かめる）", () => {
    // スクリプトと同じ手順を、ローカルのbareリポジトリ相手に再現する。
    // **素の --force-with-lease では stale info になる**ため、ここが通ることが復旧の条件
    const dir = mkdtempSync(join(tmpdir(), "propagate-push-"));
    workspace = dir;
    const sh = (script: string, cwd: string) =>
      execFileSync("bash", ["-c", script], { cwd, encoding: "utf8" });

    sh(
      [
        "git init -q --bare remote.git",
        "git init -q seed",
        'cd seed && git config user.email a@b.c && git config user.name t',
        "echo base > f && git add -A && git commit -qm base && git branch -M develop",
        "git push -q ../remote.git develop",
        // 前回の配布で残ったブランチ（PRが閉じられただけでブランチは残っている状態）
        "git checkout -q -b workflow-tag/v19 && echo stale > f && git commit -qam stale",
        "git push -q ../remote.git workflow-tag/v19",
      ].join(" && "),
      dir,
    );
    sh("git clone -q --branch develop remote.git work", dir);

    const work = join(dir, "work");
    sh(
      [
        "git config user.email a@b.c && git config user.name t",
        "git checkout -q -b workflow-tag/v19 && echo new > f && git commit -qam new",
        // ここからがスクリプトのpush部分と同じ流れ
        'if ! git push --quiet -u origin workflow-tag/v19 2>/dev/null; then',
        '  git fetch --quiet --depth 1 origin "+refs/heads/workflow-tag/v19:refs/remotes/origin/workflow-tag/v19"',
        '  REMOTE_SHA="$(git rev-parse refs/remotes/origin/workflow-tag/v19)"',
        '  git push --quiet --force-with-lease="workflow-tag/v19:$REMOTE_SHA" -u origin workflow-tag/v19',
        "fi",
      ].join("\n"),
      work,
    );

    const pushed = sh("git show workflow-tag/v19:f", join(dir, "remote.git"));
    expect(pushed.trim()).toBe("new");
  });

  it("マージできなくてもPRを残して警告にとどめる（配布全体を止めない）", () => {
    expect(source).toContain("::warning::$REPO: 自動マージできませんでした");
    // fail() を呼ぶと非0で返り、呼び出し元が失敗件数に数えて全体をエラーにしてしまう
    const warningBlock = source.slice(source.indexOf("gh pr merge"));
    expect(warningBlock).not.toContain("fail ");
  });
});
