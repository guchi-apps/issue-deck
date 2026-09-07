"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePostCreateDestination } from "@/hooks/use-post-create-destination";
import {
  POST_CREATE_DESTINATION_LABELS,
  normalizePostCreateDestinationSetting,
  type PostCreateDestinationSetting,
} from "@/lib/post-create-destination";

const OPTIONS: readonly {
  value: PostCreateDestinationSetting;
  description: string;
}[] = [
  { value: "ask", description: "作成のたびに選択画面を出します。" },
  { value: "detail", description: "作ったIssueの詳細をそのまま開きます。" },
  { value: "stay", description: "開いていた一覧・カンバンのままにします。" },
];

/**
 * Issueを作った後に開く画面の設定（#2862）。設定の「表示」区分に置く。
 *
 * **選択画面の「次回からこの画面を出さない」を取り消せる唯一の場所。** チェックを入れると
 * 選択画面そのものが出なくなるため、戻し口が無いと端末のlocalStorageを消すしか無くなる。
 *
 * 「表示」区分に置くのは、これが**端末ごとに効く画面の見え方**だから（区分の割り方は
 * `settings-sections.ts`）。保存ボタンは無く、選んだ時点でこの端末に反映する。
 */
export function PostCreateDestinationSection() {
  const { setting, setSetting } = usePostCreateDestination();
  const description = OPTIONS.find((option) => option.value === setting)?.description ?? "";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-medium">Issueを作った後に開く画面</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Select
          value={setting}
          onValueChange={(value) => setSetting(normalizePostCreateDestinationSetting(value))}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Issueを作った後に開く画面">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {POST_CREATE_DESTINATION_LABELS[option.value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        この設定はこの端末にだけ残ります（他の端末・他のブラウザには持ち越しません）。
      </p>
    </div>
  );
}
