/**
 * 文字列をクリップボードへコピーする（#1726）。コピーできたかどうかを返す。
 *
 * `navigator.clipboard`はセキュアコンテキスト（https・localhost）でしか生えない。
 * 本番はhttpsなのでそのまま通るが、tailnet経由で開発サーバーを見るとき
 * （`http://subpc.tail….ts.net:5726`）は生えないため、それだけだとスマホ実機で
 * 動作確認ができない。使えない場合は一時的な`textarea`と`document.execCommand("copy")`へ
 * 落とす（非推奨APIだが、非セキュアコンテキストで動く唯一の手段）。
 *
 * **失敗したときに`false`を返すのが要点。** 呼び出し側は成功表示の出し分けにこれを使う
 * （コピーできていないのに「コピーしました」を出さない。`dispatch-job-status.tsx`と同じ方針）。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 権限拒否などで落ちた場合は下のフォールバックを試す
    }
  }

  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  // 画面外へ置く。`display: none`だと選択できずコピーもできない
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
