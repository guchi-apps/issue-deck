"use client";

import { BUMP_KINDS, nextVersion, type BumpKind } from "@/lib/semver-bump";
import { cn } from "@/lib/utils";

type ReleaseBumpKindSelectProps = {
  /** 選択中の上げ幅。`null`は自動判定（既定） */
  value: BumpKind | null;
  onChange: (value: BumpKind | null) => void;
  /**
   * 現在のバージョン（`3.21.0`）。渡すと各選択肢に`→ 3.22.0`の目安を出す。
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
 * メジャー・マイナー・パッチは横3列で並べ、基準の説明文は出さない（#4310）。
 * スクロール領域の中でも上部に固定表示する。
 *
 * 起動の導線は2か所（ヘッダーのロケットボタンと「ブランチ」画面）あるため、
 * `release-request.ts`と同じく**選択UIも1か所に置く**。
 */
export function ReleaseBumpKindSelect({
  value,
  onChange,
  currentVersion = null,
  disabled = false,
}: ReleaseBumpKindSelectProps) {
  const kinds = [...BUMP_KINDS].reverse();
  const autoSelected = value === null;

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-1.5 bg-popover pb-2">
      <p className="text-xs font-medium text-muted-foreground">バージョンの上げ幅</p>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="バージョンの上げ幅">
        <button
          type="button"
          role="radio"
          aria-checked={autoSelected}
          disabled={disabled}
          onClick={() => onChange(null)}
          className={cn(
            "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs disabled:opacity-60",
            autoSelected ? "border-primary bg-primary/10 font-semibold" : "border-border hover:bg-accent/50",
          )}
        >
          <span>自動判定</span>
          <span className="ml-auto text-muted-foreground">既定</span>
        </button>
        <div className="grid grid-cols-3 gap-1">
          {kinds.map((kind) => {
            const selected = kind === value;
            const hint = hintFor(currentVersion, kind);
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(kind)}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-0.5 rounded-md border px-1.5 py-1.5 text-center text-xs disabled:opacity-60",
                  selected ? "border-primary bg-primary/10 font-semibold" : "border-border hover:bg-accent/50",
                )}
              >
                <span>{KIND_LABEL[kind]}</span>
                {hint && (
                  <span className="max-w-full text-[10px] leading-tight text-muted-foreground tabular-nums">
                    {hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<BumpKind, string> = { major: "メジャー", minor: "マイナー", patch: "パッチ" };

/** `→ 3.22.0`の目安。現在のバージョンが読めない場合は空文字（何も出さない） */
function hintFor(currentVersion: string | null, kind: BumpKind): string {
  const next = nextVersion(currentVersion, kind);
  return next && currentVersion ? `→ ${next}` : "";
}
