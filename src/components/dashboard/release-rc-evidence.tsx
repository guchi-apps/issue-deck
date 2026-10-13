"use client";

import type { RcFinalizationView } from "@/lib/release-finalize-run";
import type { RcCandidateView } from "@/lib/release-rc-run";

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "—");

/**
 * 候補共通検証の根拠（#4560）。**バンプ前（検証の対象）とバンプ後（最終ビルドの対象）のbase/headを分けて見せる。**
 * バンプ後に引き継いだ合格は、元の結果と差分根拠を出し、バンプ後のSHAで実行したとは書かない。
 */
export function ReleaseRcVerificationEvidence({
  candidate,
  finalization,
}: {
  candidate: RcCandidateView;
  finalization: RcFinalizationView | null;
}) {
  const current = candidate.revisions.find((r) => r.revision === candidate.currentRevision) ?? null;
  // 検証の対象は、公開準備があればその記録のバンプ前のSHA、無ければ現在revisionのSHA
  const pre = finalization && finalization.status !== "superseded"
    ? { base: finalization.preBaseSha, head: finalization.preHeadSha, revision: finalization.revision }
    : { base: current?.baseSha ?? null, head: current?.headSha ?? null, revision: candidate.currentRevision };
  const hasFinal = finalization !== null && finalization.status === "applied" && finalization.finalHeadSha !== null;

  return (
    <details className="text-[12px]" data-testid="release-rc-evidence">
      <summary className="cursor-pointer text-muted-foreground">検証の根拠（バンプ前／バンプ後）</summary>
      <div className="mt-1.5 overflow-x-auto">
        <table className="w-full min-w-[320px] border-collapse text-[11.5px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium" />
              <th className="py-1 pr-2 font-medium">base</th>
              <th className="py-1 font-medium">head</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            <tr className="border-t">
              <td className="py-1 pr-2 font-sans">バンプ前（revision {pre.revision} の検証対象）</td>
              <td className="py-1 pr-2">{short(pre.base)}</td>
              <td className="py-1">{short(pre.head)}</td>
            </tr>
            <tr className="border-t">
              <td className="py-1 pr-2 font-sans">バンプ後（最終ビルドの対象）</td>
              {hasFinal ? (
                <>
                  <td className="py-1 pr-2">{short(finalization.finalBaseSha)}</td>
                  <td className="py-1">{short(finalization.finalHeadSha)}</td>
                </>
              ) : (
                <td colSpan={2} className="py-1 font-sans text-muted-foreground">
                  未作成（公開準備で作成します）
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>
      {finalization && finalization.evidence.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1 text-muted-foreground">
          {finalization.evidence.map((e) => (
            <li key={`${e.kind}-${e.toHeadSha}`} className="break-words">
              {e.kind}: {e.action === "inherit" ? "バンプ前の合格を引き継ぎ" : "再検証"}（{e.reason}。元 {short(e.fromHeadSha)} → {short(e.toHeadSha)}）
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
