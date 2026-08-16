"use client";

import { Lightbulb } from "lucide-react";

import packageJson from "../../../../package.json";
import { APP_CHANGELOG } from "@/lib/changelog";
import { cn } from "@/lib/utils";

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Tokyo",
});

function formatDate(date: string) {
  const parsed = new Date(`${date}T00:00:00+09:00`);
  return Number.isNaN(parsed.getTime()) ? date : dateFormatter.format(parsed);
}

/**
 * 設定の「更新履歴」区分（#1764）。PCの設定ダイアログとスマホの設定画面が同じこれを描く。
 *
 * 中身（`APP_CHANGELOG`）はリリースのたびに`scripts/version-changelog.mjs`が先頭へ足す。
 * `usage`（どう使うか・#1729）は**画面で使える変化が無いリリースでは生成されない**ため、
 * 無いときは枠ごと出さない。空の見出しだけが残ると書き漏らしに見えるため。
 */
export function ChangelogSection() {
  const currentVersion = packageJson.version;

  return (
    <div className="flex flex-col gap-5">
      {APP_CHANGELOG.map((entry) => (
        <section
          key={entry.version}
          className={cn(
            "flex flex-col gap-2",
            entry !== APP_CHANGELOG[0] && "border-t pt-5",
          )}
        >
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold tabular-nums">v{entry.version}</h3>
            {entry.version === currentVersion && (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[0.65rem] font-medium text-foreground">
                使用中
              </span>
            )}
            <time dateTime={entry.date} className="ml-auto text-xs text-muted-foreground">
              {formatDate(entry.date)}
            </time>
          </div>

          <ul className="flex flex-col gap-1.5">
            {entry.changes.map((change) => (
              <li key={change} className="flex gap-2 text-sm">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                <span className="min-w-0">{change}</span>
              </li>
            ))}
          </ul>

          {entry.usage && entry.usage.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/50 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <Lightbulb className="size-3.5" />
                使い方
              </p>
              <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-xs">
                {entry.usage.map((line) => (
                  <li key={line}>{line.replace(/^\d+[.)]\s*/, "")}</li>
                ))}
              </ol>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
