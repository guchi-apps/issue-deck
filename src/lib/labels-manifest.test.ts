// 共通GitHubラベルの正本（`.github/labels.json`）の整合と、旧ラベル名の取りこぼし検査（#3237）。
//
// 正本は全リポジトリへ配られるため、ここが壊れると**全リポジトリのラベルが壊れる**。
// また旧名が1か所でも残ると、改名済みのリポジトリでラベルの付与に失敗して気づけない。

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CLOSE_REASON_LABELS } from "@/lib/github/issue-close";
import {
  CHECK_USER_LABEL,
  CHECK_USER_REASON_LABELS,
  MANUAL_STEP_LABEL,
} from "@/lib/github/approval-labels";
import { LOCAL_LABEL_NAME } from "@/lib/github/project-status-dispatch";
import { START_IMPLEMENTATION_OPTIONS } from "@/lib/github/start-implementation";
import { HIGH_PRIORITY_LABEL, LOW_PRIORITY_LABEL } from "@/lib/branch-flow";
import { isAutoAssignableLabelName } from "@/lib/issue-status";

type ManifestLabel = { name: string; color: string; description: string; category: string };
type Manifest = {
  labels: ManifestLabel[];
  renames: { from: string; to: string }[];
};

const repoRoot = path.resolve(__dirname, "../..");
const manifest: Manifest = JSON.parse(
  readFileSync(path.join(repoRoot, ".github/labels.json"), "utf8"),
);
const labelNames = new Set(manifest.labels.map((label) => label.name));

/** 旧名を書いてよいファイル。対応表・正本・移行のテストだけ */
const OLD_NAME_ALLOWED_FILES = new Set([
  ".github/labels.json",
  "docs/label-scheme.md",
  "scripts/sync-labels.test.mjs",
  "src/lib/labels-manifest.test.ts",
]);

describe("共通ラベルの正本（.github/labels.json）", () => {
  it("名前は大文字小文字を区別せず一意で、番号帯（先頭2桁）を持つ", () => {
    const lower = manifest.labels.map((label) => label.name.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    for (const label of manifest.labels) {
      expect(label.name, label.name).toMatch(/^\d{2}\./);
    }
  });

  it("色は6桁の16進（#無し）で、説明は空でなくGitHubの上限100文字以内", () => {
    for (const label of manifest.labels) {
      expect(label.color, label.name).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length, label.name).toBeGreaterThan(0);
      expect(label.description.length, label.name).toBeLessThanOrEqual(100);
    }
  });

  it("色はカテゴリ単位で統一されている", () => {
    const colorsByCategory = new Map<string, Set<string>>();
    for (const label of manifest.labels) {
      // 自動実行・確認フロー用（`00.`〜`25.`）は従来の色を保つため、名前ごとに色が違ってよい
      if (label.category === "automation") continue;
      const colors = colorsByCategory.get(label.category) ?? new Set<string>();
      colors.add(label.color);
      colorsByCategory.set(label.category, colors);
    }
    for (const [category, colors] of colorsByCategory) {
      expect([...colors], category).toHaveLength(1);
    }
  });

  it("カテゴリは番号帯と対応する（30〜49問題・50〜59機能変更・60〜69保守・70〜79進行・80〜89優先度・90〜99クローズ）", () => {
    const expected = (band: number): string => {
      if (band < 30) return "automation";
      if (band < 50) return "problem";
      if (band < 60) return "change";
      if (band < 70) return "maintenance";
      if (band < 80) return "state";
      if (band < 90) return "priority";
      return "close";
    };
    for (const label of manifest.labels) {
      expect(label.category, label.name).toBe(expected(Number(label.name.slice(0, 2))));
    }
  });

  it("renamesの新名は正本にあり、旧名は正本にない（大文字小文字だけの改名を除く）", () => {
    for (const rename of manifest.renames) {
      expect(labelNames.has(rename.to), rename.to).toBe(true);
      if (rename.from.toLowerCase() === rename.to.toLowerCase()) {
        expect(labelNames.has(rename.from), rename.from).toBe(false);
      } else {
        expect(
          manifest.labels.some((label) => label.name.toLowerCase() === rename.from.toLowerCase()),
          rename.from,
        ).toBe(false);
      }
    }
  });

  it("自動実行・確認フロー用ラベル（00.〜25.）が全て残っている", () => {
    for (const name of [
      "00.check-user",
      "01.check-plan",
      "01.check-input",
      "01.check-merge",
      "01.check-blocked",
      "01.check-answered",
      "11.local",
      "21.plan-required",
      "22.merge-confirm-required",
      "23.preview-required",
      "25.artifact-required",
    ]) {
      expect(labelNames.has(name), name).toBe(true);
    }
  });
});

describe("コードが参照するラベル名は正本にある", () => {
  it("自動実行・確認フロー・実装オプションのラベル", () => {
    const names = [
      CHECK_USER_LABEL,
      ...Object.values(CHECK_USER_REASON_LABELS),
      LOCAL_LABEL_NAME,
      MANUAL_STEP_LABEL,
      ...START_IMPLEMENTATION_OPTIONS.map((option) => option.githubLabel),
    ];
    for (const name of names) expect(labelNames.has(name), name).toBe(true);
  });

  it("クローズ理由と優先度のラベル", () => {
    for (const reason of CLOSE_REASON_LABELS) {
      expect(labelNames.has(reason.name), reason.name).toBe(true);
    }
    expect(labelNames.has(HIGH_PRIORITY_LABEL)).toBe(true);
    expect(labelNames.has(LOW_PRIORITY_LABEL)).toBe(true);
    expect(labelNames.has("85.Priority: Medium")).toBe(true);
  });

  it("自動付与の対象は「本文から決まる」ラベルだけで、状態ラベルを含まない", () => {
    const auto = manifest.labels.filter((label) => isAutoAssignableLabelName(label.name));
    const autoNames = new Set(auto.map((label) => label.name));
    for (const name of [
      "30.bug",
      "40.investigation",
      "50.feature",
      "63.refactor",
      "70.needs-decision",
      "85.Priority: Medium",
    ]) {
      expect(autoNames.has(name), name).toBe(true);
    }
    for (const name of [
      "41.cannot-reproduce",
      "71.manual-step",
      "72.blocked",
      "73.needs-info",
      "74.needs-spec",
      "75.agent-ready",
      "91.Close: duplicate",
      "11.local",
    ]) {
      expect(autoNames.has(name), name).toBe(false);
    }
  });
});

describe("旧ラベル名がリポジトリに残っていない", () => {
  it("コード・ワークフロー・プロンプト・ドキュメントが旧名を参照していない", () => {
    const oldNames = [
      ...manifest.renames.map((rename) => rename.from),
      // 誤字だった旧名。改名前後どちらの綴りでも残さない
      "wonfix",
    ];
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);

    const found: string[] = [];
    for (const file of files) {
      if (OLD_NAME_ALLOWED_FILES.has(file)) continue;
      // ロックファイル・画像などの生成物・バイナリは対象外
      if (file.endsWith("pnpm-lock.yaml") || /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i.test(file)) {
        continue;
      }
      const absolute = path.join(repoRoot, file);
      let size: number;
      try {
        size = statSync(absolute).size;
      } catch {
        continue; // 削除済みで作業ツリーに無い
      }
      if (size > 2 * 1024 * 1024) continue;
      const text = readFileSync(absolute, "utf8");
      if (text.includes("\0")) continue;
      for (const oldName of oldNames) {
        if (text.includes(oldName)) found.push(`${file}: ${oldName}`);
      }
    }

    expect(found).toEqual([]);
  });
});
