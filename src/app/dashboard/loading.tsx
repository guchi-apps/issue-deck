import { Skeleton } from "@/components/ui/skeleton";

// ログイン直後など/dashboardへの遷移でDB取得が終わるまで白画面になるのを防ぐ（#221）。
export default function DashboardLoading() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="hidden items-center gap-3 border-b px-4 py-2 md:flex">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="ml-auto h-8 w-8 rounded-full" />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        <div className="flex flex-1 flex-col overflow-hidden md:hidden">
          <div className="border-b p-4">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="flex-1 space-y-4 overflow-hidden p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
          <div className="flex border-t py-2.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="h-2.5 w-8" />
              </div>
            ))}
          </div>
        </div>

        <div className="hidden w-60 shrink-0 flex-col gap-2 border-r p-3 md:flex">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>

        <div className="hidden w-96 shrink-0 flex-col gap-3 border-r p-3 md:flex">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>

        <div className="hidden flex-1 flex-col gap-3 p-4 md:flex">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
