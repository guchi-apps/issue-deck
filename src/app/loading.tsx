import { AppLoadingScreen } from "@/components/loading-screen";

// ログイン画面・Issue作成ウィンドウなど、ダッシュボード以外の画面へ移る間に出す（#1978）。
// ダッシュボードには専用の`dashboard/loading.tsx`（スケルトン）があり、そちらが優先される。
export default function Loading() {
  return <AppLoadingScreen />;
}
