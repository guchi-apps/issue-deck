"use client";

/**
 * マージ確認ダイアログの「どの版からどの版へ上げるか」（#3260）。mainへのPRでしか出さない。
 *
 * かつては「このリリースに含まれる変更」の見出しに新しい版だけが小さく載っていたため、
 * 何から何へ上がるのかが読めなかった。変更一覧から切り出し、ダイアログの上の方に独立して置く。
 *
 * **前の版が分からないときは新しい版だけを出す。** 前の版はmainの`package.json`から読むため、
 * `version.json`型のリポジトリや読み取りに失敗したときは取れない。版は判断材料であって
 * マージの前提ではないので、取れないことを理由に帯ごと消したり、エラーを出したりしない。
 * 読み込み中は前の版の位置に`…`を出し、取得が終わった時点で値に置き換わる。
 */
export function PullRequestMergeVersion({
  from,
  to,
  isLoading,
}: {
  /** マージ先（main）の現在の版。`v`は付けない。読めなければnull */
  from: string | null;
  /** このリリースの版。`v`は付けない。タイトルから読めなければnull（その場合は何も出さない） */
  to: string | null;
  /** 前の版を取得中か */
  isLoading: boolean;
}) {
  if (!to) return null;
  const showFrom = isLoading || (from !== null && from !== to);

  return (
    <div className="flex items-center justify-center gap-2.5 rounded-lg border bg-muted/50 px-3 py-2.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">バージョン</span>
      <span className="inline-flex items-center gap-2 font-mono">
        {showFrom && (
          <>
            <span className="text-[13px] text-muted-foreground">{from ? `v${from}` : "…"}</span>
            <span aria-label="から" className="text-[13px] text-muted-foreground">
              →
            </span>
          </>
        )}
        <span className="rounded-full bg-primary px-2.5 text-[15px] leading-6 font-bold text-primary-foreground">
          v{to}
        </span>
      </span>
    </div>
  );
}
