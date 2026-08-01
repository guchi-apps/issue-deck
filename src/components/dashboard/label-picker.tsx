"use client";

import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getLabelDotStyle } from "@/lib/label-color";
import type { IssueLabel } from "@/types/issue";

type LabelPickerProps = {
  labels: IssueLabel[];
  selectedNames: string[];
  onToggle: (name: string) => void;
  isLoading?: boolean;
  trigger: ReactNode;
  align?: "start" | "end";
};

export function LabelPicker({
  labels,
  selectedNames,
  onToggle,
  isLoading,
  trigger,
  align = "start",
}: LabelPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-72 max-w-[calc(100vw-2rem)]">
        {labels.length === 0 ? (
          <DropdownMenuItem disabled>
            {isLoading ? "読み込み中..." : "ラベルがありません"}
          </DropdownMenuItem>
        ) : (
          labels.map((label) => (
            <DropdownMenuCheckboxItem
              key={label.name}
              checked={selectedNames.includes(label.name)}
              onCheckedChange={() => onToggle(label.name)}
              onSelect={(e) => e.preventDefault()}
              className="flex-col items-start gap-0.5"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={getLabelDotStyle(label.color)}
                />
                {label.name}
              </span>
              {label.description && (
                <span className="pl-3.5 text-xs text-muted-foreground">{label.description}</span>
              )}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
