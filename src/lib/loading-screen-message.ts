/**
 * 読み込みが長引いたときに、ローディング画面が何を出すか（#1978）。
 *
 * ホーム画面から起動したPWAにはタブもアドレスバーも無いため、読み込み中であることも、
 * 読み込みが失敗したことも画面自身が名乗るしかない。ただし「時間がかかっています」を
 * 最初から出すと、ふだんの起動でも毎回出て意味が薄れる。**一定時間を過ぎてから**
 * 文言を強め、自分で読み込み直す手段を添える。
 *
 * しきい値と文言をここに集約するのは、全画面のローディング（`app/loading.tsx`）と
 * ダッシュボードのスケルトンに重ねる帯（`app/dashboard/loading.tsx`）で同じ区切り・
 * 同じ言い回しを使うため。片方だけ変わると、同じ待ち時間で画面ごとに違うことを言い出す。
 */
export const SLOW_LOADING_THRESHOLD_MS = 8_000;

export type LoadingScreenMessage = {
  /** 状態を表す短い一言。 */
  status: string;
  /** 状態の補足。長引いているときだけ出す。 */
  hint: string | null;
  /** 自分で読み込み直す操作を出すか。 */
  showReload: boolean;
};

export function loadingScreenMessage(elapsedMs: number): LoadingScreenMessage {
  if (elapsedMs < SLOW_LOADING_THRESHOLD_MS) {
    return { status: "読み込み中", hint: null, showReload: false };
  }

  return {
    status: "時間がかかっています",
    hint: "通信の状況を確かめるか、読み込み直してください。",
    showReload: true,
  };
}
