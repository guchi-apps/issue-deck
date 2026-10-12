"use client";

import { useState } from "react";

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
 * 自動判定中は「手動で変える」だけを出し、押したときだけmajor・minor・patchを横3列で出す（#4465）。
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
  // 手動で変えるを押した直後（まだ未選択）も開いたままにするため、選択値とは別に持つ。
  // ダイアログを閉じると部品ごと破棄されるので、開き直せば自動判定の閉じた状態に戻る（#4465）
  const [manualOpen, setManualOpen] = useState(false);
  const expanded = manualOpen || value !== null;

  return (
    <div className="sticky top-0 z-10 flex flex-col gap-1.5 bg-popover pb-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          バージョンの上げ幅：{expanded ? "手動" : "自動判定"}
        </p>
        {expanded ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setManualOpen(false);
            }}
            className="text-xs text-primary hover:underline disabled:opacity-60"
          >
            自動判定に戻す
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={false}
            disabled={disabled}
            onClick={() => setManualOpen(true)}
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent/50 disabled:opacity-60"
          >
            手動で変える
          </button>
        )}
      </div>
      {expanded && (
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="バージョンの上げ幅">
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
      )}
    </div>
  );
}

const KIND_LABEL: Record<BumpKind, string> = { major: "major", minor: "minor", patch: "patch" };

/** `→ 3.22.0`の目安。現在のバージョンが読めない場合は空文字（何も出さない） */
function hintFor(currentVersion: string | null, kind: BumpKind): string {
  const next = nextVersion(currentVersion, kind);
  return next && currentVersion ? `→ ${next}` : "";
}
