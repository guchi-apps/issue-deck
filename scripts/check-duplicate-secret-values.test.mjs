// 値の複製の検査（`scripts/check-duplicate-secret-values.sh`）の振る舞いを固定する（#2624）。
//
// 実物の1PasswordとGitHubは叩けないので、`op`・`gh` をPATHの先頭に置いた替え玉に差し替える。
// 替え玉はボールトのアイテムとリポジトリのマニフェストをファイルから返す。
//
// 見るのは4つ。
//   1. 同じ値が2つのフィールドに入っていれば、両方のパスと参照元を並べて非0で終わる
//   2. マニフェストが指すフィールドが存在しなければ「不在」として報告する
//   3. 短い値（ポート番号など）はたまたま一致していても複製として報告しない
//   4. 値もハッシュも出力しない

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/check-duplicate-secret-values.sh");

/** AIDE側と提供側の双方に入っている、複製された認証値 */
const SHARED = "shared-token-value-1234";

let work;
let vault;
let manifests;
let calls;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "check-duplicate-secret-values-test-"));
  vault = path.join(work, "vault");
  manifests = path.join(work, "manifests");
  calls = path.join(work, "calls.log");
  fs.mkdirSync(vault);
  fs.mkdirSync(manifests);
  fs.mkdirSync(path.join(work, "bin"));
  writeStub("op", OP_STUB);
  writeStub("gh", GH_STUB);

  writeItems({
    aide: {
      "dayspan-token": SHARED,
      "own-secret": "aide-only-secret-9999",
      "db-port": "3306",
    },
    dayspan: {
      "internal-api-key": SHARED,
      "db-port": "3306",
    },
  });
  writeManifest("aide", [
    "HOST\tinherit\tsecret\tSERVER_HOST\t-",
    "AIDE_DAYSPAN_TOKEN\trepo\tsecret\tAIDE_DAYSPAN_TOKEN\top://apps/aide/dayspan-token",
    "AIDE_RESEARCH_DESK_TOKEN\trepo\tsecret\tAIDE_RESEARCH_DESK_TOKEN\top://apps/aide/research-desk-token",
  ]);
  writeManifest("dayspan", [
    "# コメント行は読み飛ばす",
    "INTERNAL_API_KEY\trepo\tsecret\tINTERNAL_API_KEY\top://apps/dayspan/internal-api-key",
  ]);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function writeStub(name, body) {
  const file = path.join(work, "bin", name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

/** ボールトの中身を用意する（`op item list` / `op item get` が返すようになる） */
function writeItems(items) {
  const list = Object.keys(items).map((title) => ({ id: title, title }));
  fs.writeFileSync(path.join(vault, "items.json"), JSON.stringify(list));
  for (const [title, fields] of Object.entries(items)) {
    const body = { fields: Object.entries(fields).map(([label, value]) => ({ label, value })) };
    fs.writeFileSync(path.join(vault, `${title}.json`), JSON.stringify(body));
  }
}

function writeManifest(repo, lines) {
  fs.writeFileSync(path.join(manifests, `${repo}.tsv`), `${lines.join("\n")}\n`);
}

function run(args = []) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script, "--repos", "aide,dayspan", ...args],
      {
        env: {
          ...process.env,
          PATH: `${path.join(work, "bin")}:${process.env.PATH}`,
          STUB_VAULT: vault,
          STUB_MANIFESTS: manifests,
          STUB_CALLS: calls,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

// `op item list` はボールトの一覧、`op item get <id>` はアイテム1件を返す。
// `op read` は不在の最終確認に使われるので、フィールドの有無だけを終了コードで返す。
const OP_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'op %s\\n' "$*" >> "$STUB_CALLS"
case "\${1:-} \${2:-}" in
  "item list") cat "$STUB_VAULT/items.json" ;;
  "item get")
    [[ -f "$STUB_VAULT/\${3}.json" ]] || exit 1
    cat "$STUB_VAULT/\${3}.json"
    ;;
  read*)
    ref="\${2%%\\?*}"
    ref="\${ref#op://apps/}"
    item="\${ref%%/*}"
    field="\${ref#*/}"
    [[ -f "$STUB_VAULT/\${item}.json" ]] || exit 1
    jq -e --arg f "\$field" '.fields[] | select(.label == \$f) | .value' "$STUB_VAULT/\${item}.json" >/dev/null
    ;;
  *) exit 1 ;;
esac
`;

// `gh api .../contents/.github/secrets-manifest.tsv` はリポジトリごとのマニフェストを返す。
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$STUB_CALLS"
case "\${1:-}" in
  api)
    repo="\$(sed -E 's#^repos/[^/]+/([^/]+)/contents/.*#\\1#' <<< "\${2:-}")"
    [[ -f "$STUB_MANIFESTS/\${repo}.tsv" ]] || exit 1
    cat "$STUB_MANIFESTS/\${repo}.tsv"
    ;;
  *) exit 1 ;;
esac
`;

describe("check-duplicate-secret-values.sh", () => {
  it("同じ値が2つのフィールドに入っていれば、参照元つきで報告して非0で終わる", async () => {
    const { code, stdout } = await run();

    expect(stdout).toContain("op://apps/aide/dayspan-token");
    expect(stdout).toContain("op://apps/dayspan/internal-api-key");
    expect(stdout).toContain("guchi-apps/aide（AIDE_DAYSPAN_TOKEN）");
    expect(stdout).toContain("guchi-apps/dayspan（INTERNAL_API_KEY）");
    expect(stdout).toContain("複製=1");
    expect(code).toBe(1);
  });

  it("マニフェストが指すフィールドが無ければ不在として報告する", async () => {
    const { stdout } = await run();

    const missing = stdout.slice(stdout.indexOf("== 参照先が実在しないフィールド"));
    expect(missing).toContain("op://apps/aide/research-desk-token");
    expect(missing).toContain("guchi-apps/aide（AIDE_RESEARCH_DESK_TOKEN）");
    expect(stdout).toContain("不在=1");
  });

  it("短い値がたまたま一致していても複製として報告しない", async () => {
    const { stdout } = await run();

    expect(stdout).not.toContain("db-port");
  });

  it("値もハッシュも出力しない", async () => {
    const { stdout, stderr } = await run();

    expect(stdout + stderr).not.toContain(SHARED);
    expect(stdout + stderr).not.toContain("aide-only-secret-9999");
    expect(stdout + stderr).not.toMatch(/[0-9a-f]{64}/);
  });

  it("許容表に全パスが載っているグループは複製として報告しない", async () => {
    const allowlist = path.join(work, "allowlist.txt");
    fs.writeFileSync(
      allowlist,
      ["# 値の性質上一致するもの", "op://apps/aide/dayspan-token", "op://apps/dayspan/internal-api-key", ""].join("\n"),
    );

    const { stdout } = await run(["--allowlist", allowlist]);

    expect(stdout).toContain("複製=0 許容=1");
    expect(stdout.slice(0, stdout.indexOf("== 参照先"))).not.toContain("op://apps/aide/dayspan-token");
  });

  it("複製も不在も無ければ、なしと出して0で終わる", async () => {
    writeItems({
      aide: { "own-secret": "aide-only-secret-9999" },
      dayspan: { "internal-api-key": "dayspan-only-secret-8888" },
    });
    writeManifest("aide", [
      "AIDE_OWN_SECRET\trepo\tsecret\tAIDE_OWN_SECRET\top://apps/aide/own-secret",
    ]);

    const { code, stdout } = await run();

    expect(stdout).toContain("複製=0 許容=0 不在=0");
    expect(code).toBe(0);
  });
});
