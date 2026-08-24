import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SHARED_FILE_SPECS } from "@/lib/workflow-tags";

// ワークフロー以外の配布物は `.github/scripts/propagate-shared-files.sh` が配る（#2240）。
// GitHub API を伴う部分（clone・PR作成）は切り離せないため、**配るかどうかの判定と、
// 上書きで消える記述の抽出**を同じコマンド列で再現して確認する。
//
// ここを間違えると、他リポジトリの独自の変更を黙って消すか、毎回同じPRを作り続けることになる。
const SCRIPT = join(process.cwd(), ".github", "scripts", "propagate-shared-files.sh");
const WORKFLOW = join(process.cwd(), ".github", "workflows", "propagate-shared-files.yml");

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

describe("propagate-shared-files.sh", () => {
  it("スクリプトの構文が正しい", () => {
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("配れるパスの許可リストが SHARED_FILE_SPECS と一致している", () => {
    // ずれると、画面から配ろうとしたファイルがスクリプト側で黙ってスキップされる
    const script = readFileSync(SCRIPT, "utf8");
    const allowed = /^ALLOWED_FILES="(.*)"$/m.exec(script)?.[1]?.split(" ") ?? [];

    expect(allowed).toEqual(SHARED_FILE_SPECS.map((spec) => spec.path));
  });

  it("ワークフローの許可リストが SHARED_FILE_SPECS と一致している", () => {
    // こちらがずれると、起動そのものが「配布対象外のパス」で弾かれる
    const workflow = readFileSync(WORKFLOW, "utf8");
    for (const spec of SHARED_FILE_SPECS) {
      expect(workflow, spec.path).toContain(`. == "${spec.path}"`);
    }
  });

  it("配布元のファイルが実在し、実行ビットが立っている", () => {
    // **配布元は`.github/templates/`の雛形ではなく issue-deck 自身の実物。**
    // 実行ビットは配布先へそのまま写すため、ここが落ちていると配布先も落ちる
    for (const spec of SHARED_FILE_SPECS) {
      const stats = statSync(join(process.cwd(), spec.path));
      expect(stats.isFile(), spec.path).toBe(true);
      expect(stats.mode & 0o111, spec.path).not.toBe(0);
    }
  });

  it("配布ワークフローは配布処理と同じファイル名を起動する", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");

    expect(workflow).toContain(".github/scripts/propagate-shared-files.sh");
  });
});

/**
 * スクリプト本体から判定部分だけを取り出して実行する。
 * 置かれているか → 中身が同じか → 消える記述の抽出、の3段。
 *
 * 抽出のawkは**スクリプト本体から読み出して**使う。ここに書き写すと、片方を直したときに
 * もう片方が古いまま通ってしまう。
 */
function decide(source: string, target: string | null): { action: string; lost: string } {
  workspace = mkdtempSync(join(tmpdir(), "shared-files-"));
  const sourcePath = join(workspace, "source.sh");
  const targetPath = join(workspace, "target.sh");
  writeFileSync(sourcePath, source);
  if (target !== null) writeFileSync(targetPath, target);

  const out = execFileSync(
    "bash",
    [
      "-c",
      `set -uo pipefail
if [ ! -f "${targetPath}" ]; then
  echo "ACTION=skip-missing"
elif cmp -s "${sourcePath}" "${targetPath}"; then
  echo "ACTION=skip-same"
else
  echo "ACTION=update"
  SOURCE="${sourcePath}"
  FILE="${targetPath}"
  ${lostLinesSnippet()}
  printf 'LOST<<EOF\\n%s\\nEOF\\n' "$LOST_LINES"
fi`,
    ],
    { encoding: "utf8" },
  );

  const action = /^ACTION=(.*)$/m.exec(out)?.[1] ?? "";
  const lost = /^LOST<<EOF\n([\s\S]*)\nEOF$/m.exec(out)?.[1] ?? "";
  return { action, lost };
}

/** スクリプト本体から `LOST_LINES=...` の代入（awkを含む複数行）を切り出す */
function lostLinesSnippet(): string {
  const script = readFileSync(SCRIPT, "utf8");
  const snippet = /^ {2}(LOST_LINES="\$\(awk '[\s\S]*?' "\$SOURCE" "\$FILE"\)")$/m.exec(script)?.[1];
  if (!snippet) throw new Error("propagate-shared-files.sh から LOST_LINES の抽出処理を読めません");
  return snippet;
}

describe("配布の判定", () => {
  it("置かれていなければ配らない", () => {
    // 呼び出し側のステップが無いリポジトリへスクリプトだけ置いても誰も呼ばない
    expect(decide("new\n", null).action).toBe("skip-missing");
  });

  it("中身が同じならスキップする（毎回PRを作らない）", () => {
    expect(decide("same\n", "same\n").action).toBe("skip-same");
  });

  it("中身が違えば更新する", () => {
    expect(decide("new\n", "old\n").action).toBe("update");
  });

  it("配布元に無い語を含む行を、消える記述として書き出す", () => {
    // 実例: guchi-apps/subpc のコピーにある NOTIFY_NOTE
    const { lost } = decide("alpha\nbeta\n", 'alpha\nbeta\nexport NOTIFY_NOTE="x"\n');

    expect(lost).toBe('export NOTIFY_NOTE="x"');
  });

  it("書き換わっただけの行は書き出さない", () => {
    // **語ではなく行で比べていたときの取りこぼしの本体**（実測で16件中16件が該当した）
    const { lost } = decide(
      'run_url="${NOTIFY_RUN_URL:-${GITHUB_SERVER_URL}/${GITHUB_RUN_ID}}"\n',
      'run_url="${GITHUB_SERVER_URL}/${GITHUB_RUN_ID}"\n',
    );

    expect(lost).toBe("");
  });

  it("配布元の側にだけある語は書き出さない", () => {
    const { lost } = decide("alpha\nbeta\ngamma\n", "alpha\ngamma\n");

    expect(lost).toBe("");
  });
});
