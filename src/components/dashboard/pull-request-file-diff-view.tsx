import { cn } from "@/lib/utils";

type PullRequestFileDiffViewProps = {
  /** unified diff形式の差分本文（GitHubの`patch`をそのまま渡す） */
  patch: string;
};

type DiffLineKind = "hunk" | "added" | "removed" | "context" | "meta";

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  hunk: "bg-muted/70 text-muted-foreground",
  added: "bg-green-600/10 text-foreground dark:bg-green-500/10",
  removed: "bg-destructive/10 text-foreground",
  context: "text-foreground",
  meta: "text-muted-foreground italic",
};

/**
 * unified diffの1行を種別へ寄せる。行頭の記号（`+`/`-`/`@@`/`\`）だけで判定できる形式のため、
 * パーサーは持たずシンプルな先頭一致で足りる。
 */
function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (line.startsWith("\\")) return "meta";
  return "context";
}

/**
 * 変更ファイル一覧の「差分を表示」で展開する、unified diffの簡易ビューアー（#3383）。
 *
 * diff2html等のライブラリは使わず、行頭記号だけで種別（追加・削除・hunk見出し）を判定して
 * 背景色を付ける最小限の実装にしている。シンタックスハイライトは行わない——1ファイルの
 * 差分をその場で読めれば十分で、GitHubの表示をそのまま再現する必要は無いため。
 */
export function PullRequestFileDiffView({ patch }: PullRequestFileDiffViewProps) {
  const lines = patch.split("\n");
  return (
    <pre className="overflow-x-auto border-t bg-background px-4 py-2 font-mono text-[11px] leading-5">
      <code>
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn("whitespace-pre px-1", DIFF_LINE_CLASS[classifyDiffLine(line)])}
          >
            {line.length === 0 ? " " : line}
          </div>
        ))}
      </code>
    </pre>
  );
}
