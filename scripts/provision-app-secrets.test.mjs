// 立ち上げのシークレット投入（`scripts/provision-app-secrets.sh`）の振る舞いを固定する（#2249）。
//
// 実物の1PasswordとGitHubは叩けないので、`op`・`gh` をPATHの先頭に置いた替え玉に差し替える。
// 替え玉は呼ばれた引数を記録し、`op item create` / `op item edit` で書かれた値を
// ディレクトリへ保存する——**書いた値を読み直して突き合わせる**本体の確認手順が、
// 実物と同じ経路で動くことまで見るため。
//
// 見るのは4つ。
//   1. アイテムが無ければ複数フィールドを一度に作る（フィールド名の羅列にしない）
//   2. 既に値があるフィールドは触らない（順序を選ばず何度実行してもよい）
//   3. マニフェストがまだ無いときは、1Passwordへ入れたうえで同期だけを見送る
//   4. 値そのものを出力しない

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts/provision-app-secrets.sh");

const MANIFEST = [
  "# コメント行は読み飛ばす",
  "HOST\tinherit\tsecret\tSERVER_HOST\t-",
  "TARGET_DIR\trepo\tsecret\tTARGET_DIR\top://apps/kakei-report/target-dir",
  "DB_NAME\trepo\tsecret\tDB_NAME\top://apps/kakei-report/db-name",
  "ALLOWED_GOOGLE_EMAILS\trepo\tsecret\tALLOWED_GOOGLE_EMAILS\top://apps/kakei-report/allowed-google-emails",
  "SIGNALY_WEBHOOK_URL\trepo\tsecret\tSIGNALY_WEBHOOK_URL\top://apps/kakei-report/ci-webhook-url",
  "",
].join("\n");

let work;
/** 替え玉が値を保存する場所（1Passwordのアイテムに見立てる） */
let store;
/** 替え玉が呼ばれた引数を1行ずつ記録する場所 */
let calls;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "provision-app-secrets-test-"));
  store = path.join(work, "store");
  calls = path.join(work, "calls.log");
  fs.mkdirSync(store);
  fs.mkdirSync(path.join(work, "bin"));
  fs.writeFileSync(path.join(work, "op-writer.env"), "OP_SERVICE_ACCOUNT_TOKEN=dummy-writer-token\n");
  fs.writeFileSync(path.join(work, "manifest.tsv"), MANIFEST);
  writeStub("op", OP_STUB);
  writeStub("gh", GH_STUB);
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function writeStub(name, body) {
  const file = path.join(work, "bin", name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

/** アイテムに既に入っている値を用意する（`op read` が返すようになる） */
function seed(field, value) {
  fs.writeFileSync(path.join(store, field), value);
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [script, ...args],
      {
        env: {
          ...process.env,
          PATH: `${path.join(work, "bin")}:${process.env.PATH}`,
          OP_WRITER_ENV: path.join(work, "op-writer.env"),
          STUB_STORE: store,
          STUB_CALLS: calls,
          STUB_MANIFEST: path.join(work, "manifest.tsv"),
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

function recorded() {
  return fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
}

// `op read op://vault/item/field` は STUB_STORE のファイルを返す。`op item create` /
// `op item edit` は `section.field[type]=value` を解釈してそこへ書く。
const OP_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'op %s\\n' "$*" >> "$STUB_CALLS"
case "\${1:-}" in
  whoami) exit 0 ;;
  read)
    field="\${2##*/}"
    [[ -f "$STUB_STORE/$field" ]] || exit 1
    cat "$STUB_STORE/$field"
    ;;
  item)
    case "\${2:-}" in
      get)
        [[ "\${STUB_ITEM_EXISTS:-}" == "1" ]] || exit 1
        echo '{"title":"kakei-report"}'
        ;;
      create|edit)
        for arg in "\$@"; do
          case "$arg" in
            *\\[*\\]=*)
              assignment="\${arg%%=*}"
              value="\${arg#*=}"
              field="\${assignment%%[*}"
              field="\${field##*.}"
              printf '%s' "$value" > "$STUB_STORE/$field"
              ;;
          esac
        done
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`;

// `gh api .../contents/...` はマニフェストを返す（STUB_NO_MANIFEST=1 で「まだ無い」を作る）。
// `gh secret set` は標準入力を捨てて名前だけ記録する。件数の確認は実物と同じ `--jq` を通す。
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$STUB_CALLS"
case "\${1:-}" in
  api)
    case "\${2:-}" in
      *contents/.github/secrets-manifest.tsv*)
        [[ "\${STUB_NO_MANIFEST:-}" == "1" ]] && exit 1
        cat "$STUB_MANIFEST"
        ;;
      *actions/secrets*)
        expr=""
        while [[ $# -gt 0 ]]; do
          if [[ "$1" == "--jq" ]]; then expr="$2"; fi
          shift
        done
        printf '%s' '{"total_count":2,"secrets":[{"name":"TARGET_DIR"},{"name":"DB_NAME"}]}' | jq -r "$expr"
        ;;
      *) exit 1 ;;
    esac
    ;;
  secret)
    cat >/dev/null
    ;;
  *) exit 1 ;;
esac
`;

describe("provision-app-secrets.sh", () => {
  it("アイテムが無ければ、複数フィールドを一度に作る", async () => {
    const result = await run([
      "--repo",
      "guchi-apps/kakei-report",
      "--db-name",
      "app_kakei_report",
      "--allowed-emails",
      "me@example.com",
    ]);

    expect(result.code).toBe(0);
    const create = recorded().find((line) => line.startsWith("op item create"));
    expect(create).toBeDefined();
    expect(create).toContain("--vault apps");
    expect(create).toContain("--title kakei-report");
    // 実機の配置先は `/apps/<name>` ではない（#2246）
    expect(create).toContain("デプロイ.target-dir[text]=/home/github-user/apps/kakei-report");
    expect(create).toContain("DB.db-name[text]=app_kakei_report");
    expect(create).toContain("認証.allowed-google-emails[text]=me@example.com");
    expect(recorded().some((line) => line.startsWith("op item edit"))).toBe(false);
  });

  it("マニフェストが読む行だけをGitHubへ同期し、件数で確かめる", async () => {
    const result = await run([
      "--repo",
      "guchi-apps/kakei-report",
      "--db-name",
      "app_kakei_report",
    ]);

    expect(result.code).toBe(0);
    const secrets = recorded().filter((line) => line.startsWith("gh secret set"));
    expect(secrets).toHaveLength(2);
    expect(secrets.join("\n")).toContain("TARGET_DIR --repo guchi-apps/kakei-report");
    expect(secrets.join("\n")).toContain("DB_NAME --repo guchi-apps/kakei-report");
    // 値を入れていない ALLOWED_GOOGLE_EMAILS / SIGNALY_WEBHOOK_URL は送らない
    // （空のまま送ると同期がFAILで返り、入った値まで失敗に見える）
    expect(secrets.join("\n")).not.toContain("ALLOWED_GOOGLE_EMAILS");
    expect(secrets.join("\n")).not.toContain("SIGNALY_WEBHOOK_URL");
    expect(result.stdout).toContain("総数: 2件");
  });

  it("既に値があるフィールドは触らず、足りないぶんだけ足す", async () => {
    seed("target-dir", "/home/github-user/apps/kakei-report");
    seed("db-name", "app_kakei_report");

    const result = await run(
      [
        "--repo",
        "guchi-apps/kakei-report",
        "--db-name",
        "app_kakei_report",
        "--ci-webhook-url",
        "https://signaly.gucchii.com/webhook/xxxx",
      ],
      { STUB_ITEM_EXISTS: "1" },
    );

    expect(result.code).toBe(0);
    const edit = recorded().find((line) => line.startsWith("op item edit"));
    expect(edit).toBeDefined();
    expect(edit).toContain("通知.ci-webhook-url[url]=");
    expect(edit).not.toContain("target-dir");
    expect(edit).not.toContain("db-name");
    // 既に入っている値も同期の対象には残す（GitHub側だけ欠けている場合に埋まる）
    const secrets = recorded().filter((line) => line.startsWith("gh secret set"));
    expect(secrets.join("\n")).toContain("SIGNALY_WEBHOOK_URL");
    expect(secrets.join("\n")).toContain("TARGET_DIR");
  });

  it("--force を付けたときだけ入っている値を上書きする", async () => {
    seed("target-dir", "/home/github-user/apps/kakei-report");

    const result = await run(
      ["--repo", "guchi-apps/kakei-report", "--force"],
      { STUB_ITEM_EXISTS: "1" },
    );

    expect(result.code).toBe(0);
    expect(recorded().find((line) => line.startsWith("op item edit"))).toContain("target-dir");
  });

  it("マニフェストがまだ無いときは、1Passwordへ入れたうえで同期を見送る", async () => {
    const result = await run(
      ["--repo", "guchi-apps/kakei-report", "--db-name", "app_kakei_report"],
      { STUB_NO_MANIFEST: "1" },
    );

    expect(result.code).toBe(0);
    expect(recorded().some((line) => line.startsWith("op item create"))).toBe(true);
    expect(recorded().some((line) => line.startsWith("gh secret set"))).toBe(false);
    expect(result.stdout).toContain("1Passwordへの登録は済んでいます");
  });

  it("--no-sync では1Passwordだけで終える", async () => {
    const result = await run(["--repo", "guchi-apps/kakei-report", "--no-sync"]);

    expect(result.code).toBe(0);
    expect(recorded().some((line) => line.startsWith("gh "))).toBe(false);
  });

  it("--dry-run では何も書かない", async () => {
    const result = await run(["--repo", "guchi-apps/kakei-report", "--db-name", "x", "--dry-run"]);

    expect(result.code).toBe(0);
    expect(recorded().some((line) => line.startsWith("op item create"))).toBe(false);
    expect(recorded().some((line) => line.startsWith("gh secret set"))).toBe(false);
  });

  it("値そのものを出力しない（長さだけ）", async () => {
    const result = await run([
      "--repo",
      "guchi-apps/kakei-report",
      "--allowed-emails",
      "secret-person@example.com",
      "--ci-webhook-url",
      "https://signaly.gucchii.com/webhook/secret-token",
    ]);

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("secret-person@example.com");
    expect(output).not.toContain("secret-token");
    expect(output).toContain("allowed-google-emails（text）: 25文字");
  });

  it("コピー元から許可メールを写す", async () => {
    fs.writeFileSync(path.join(store, "allowed-google-emails"), "copied@example.com");

    const result = await run([
      "--repo",
      "guchi-apps/kakei-report",
      "--allowed-emails-from",
      "op://apps/dayspan/allowed-google-emails",
    ]);

    expect(result.code).toBe(0);
    expect(recorded().find((line) => line.startsWith("op item create"))).toContain(
      "認証.allowed-google-emails[text]=copied@example.com",
    );
  });

  it("--repo が無ければ何もしない", async () => {
    const result = await run(["--db-name", "app_kakei_report"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--repo は必須です");
  });
});
