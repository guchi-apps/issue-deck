"use client";

import { BUMP_KIND_CRITERIA, BUMP_KINDS, nextVersion, type BumpKind } from "@/lib/semver-bump";
import { cn } from "@/lib/utils";

type ReleaseBumpKindSelectProps = {
  /** 選択中の上げ幅。`null`は自動判定（既定） */
  value: BumpKind | null;
  onChange: (value: BumpKind | null) => void;
  /**
   * 現在のバージョン（`3.21.0`）。渡すと各選択肢に`3.21.0 → 3.22.0`の目安を出す。
   * 取得できていない場合はnullで、そのときは目安を出さない。
   */
  currentVersion?: string | null;
  disabled?: boolean;
};

/**
 * リリース起動時にバージョンの上げ幅を選ぶ（#1548）。
 *
 * 上げ幅はこれまでworkflow内のClaudeだけが決めており、バンプPRはCI通過後にAuto-mergeで
 * developへ入るため、**判定が意図と違っていても人が直す時間が実質無かった。** 起動する時点で
 * 選べるようにして、後から直す必要そのものを無くす。
 *
 * 既定は「自動判定」（`null`）で、選ばなければ起動の挙動は今までと変わらない。
 * 各選択肢に添える基準は`BUMP_KIND_CRITERIA`——**自動判定へ渡している判定基準と同じ文面**で、
 * 人が選ぶときと自動で決まるときで基準が食い違わないようにしている。
 *
 * 起動の導線は2か所（ヘッダーのロケットボタンと「ブランチとPRの流れ」画面）あるため、
 * `release-request.ts`と同じく**選択UIも1か所に置く**。
 */
export function ReleaseBumpKindSelect({
  value,
  onChange,
  currentVersion = null,
  disabled = false,
}: ReleaseBumpKindSelectProps) {
  const options: { key: BumpKind | null; label: string; hint: string; criteria: string }[] = [
    {
      key: null,
      label: "自動判定",
      hint: "既定",
      criteria:
        "main↔developのコード差分からClaudeが判定する。複数種類の変更が混在する場合は上げ幅が大きいほうを採る",
    },
    ...[...BUMP_KINDS].reverse().map((kind) => ({
      key: kind,
      label: kind,
      hint: hintFor(currentVersion, kind),
      criteria: BUMP_KIND_CRITERIA[kind],
    })),
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">バージョンの上げ幅</p>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="バージョンの上げ幅">
        {options.map((option) => {
          const selected = option.key === value;
          return (
            <button
              key={option.key ?? "auto"}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.key)}
              className={cn(
                "flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left disabled:opacity-60",
                selected ? "border-primary bg-primary/10" : "border-border hover:bg-accent/50",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2.5 shrink-0 rounded-full border",
                    selected ? "border-primary bg-primary ring-2 ring-primary/30" : "border-border",
                  )}
                />
                <span className={cn("text-xs", selected && "font-semibold")}>{option.label}</span>
                {option.hint && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {option.hint}
                  </span>
                )}
              </span>
              <span className="pl-[1.125rem] text-xs leading-relaxed text-muted-foreground">
                {option.criteria}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** `3.21.0 → 3.22.0`の目安。現在のバージョンが読めない場合は空文字（何も出さない） */
function hintFor(currentVersion: string | null, kind: BumpKind): string {
  const next = nextVersion(currentVersion, kind);
  return next && currentVersion ? `${currentVersion} → ${next}` : "";
}
