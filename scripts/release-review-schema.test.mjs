import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "scripts/prompts/release-review-result.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

it("全オブジェクトで構造化出力の必須キーを宣言し、再レビュー・阻害指摘・未確認を保持する", () => {
  const visit = (s) => {
    if (s.type === "object") {
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(visit);
    }
    if (s.items) visit(s.items);
  };
  visit(schema);
  expect(schema.properties.state.enum).toContain("failed");
  expect(schema.properties.checks.items.properties.status.enum).toContain("unconfirmed");
  expect(schema.properties.findings.items.properties.blocking.type).toBe("boolean");
  expect(schema.properties.previousFindings.items.properties.status.enum).toContain("unresolved");
});

it("Codex起動に実在するschemaを渡し、読み取り専用・モデルを維持する", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-schema-test-"));
  try {
  const result = execFileSync("bash", ["-c", `
source "$1/scripts/run-release-review.sh"
agent=codex; codex_model=test-model; codex_command=fake_codex; WORKTREE="$2"
fake_codex() { printf '%s\\n' "$@"; }
timeout() { shift 3; "$@"; }
run_agent /dev/null /dev/null "$2/args.log"
cat "$2/args.log"
`, "test", root, dir], { encoding: "utf8" });
  const args = result.trim().split("\n");
  expect(args[args.indexOf("--output-schema") + 1]).toBe(schemaPath);
  expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(args[args.indexOf("-m") + 1]).toBe("test-model");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("生のJSONは読み込むが、引用符が欠けた結果を合格へ修復しない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-json-test-"));
  try {
    const file = path.join(dir, "result.json");
    const parse = () => spawnSync("bash", ["-c", 'source "$1/scripts/run-release-review.sh"; extract_result_json "$2"', "test", root, file], { encoding: "utf8" });
    writeFileSync(file, '{"state":"needs_check","summary":"引用\\\"と日本語"}');
    expect(JSON.parse(parse().stdout).state).toBe("needs_check");
    writeFileSync(file, '{"state":"passed","evidence": 引用符なし"}');
    expect(parse().status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
