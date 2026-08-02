import { Skeleton } from "@/components/ui/skeleton";

export function MobileScreenSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
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
    </div>
  );
}
