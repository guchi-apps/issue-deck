"use client";

import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ImagePlus, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Issue } from "@/types/issue";

export type IssueSuggestion = {
  number: number;
  title: string;
};

export function getRepoIssueSuggestions(issues: Issue[], repositoryFullName: string): IssueSuggestion[] {
  return issues
    .filter((issue) => issue.repositoryFullName === repositoryFullName)
    .map((issue) => ({ number: issue.number, title: issue.title }));
}

const MENTION_SUGGESTIONS = ["claude"];
const MAX_ISSUE_SUGGESTIONS = 8;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Trigger = {
  type: "mention" | "issue";
  start: number;
  query: string;
};

const TRIGGER_PATTERN = /(^|[\s(（])([@#])([^\s@#]*)$/;

function detectTrigger(text: string, cursor: number): Trigger | null {
  const upToCursor = text.slice(0, cursor);
  const match = TRIGGER_PATTERN.exec(upToCursor);
  if (!match) return null;
  const [, prefix, symbol, query] = match;
  const start = match.index + prefix.length;
  return { type: symbol === "@" ? "mention" : "issue", start, query };
}

type MentionTextareaProps = Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  issueSuggestions?: IssueSuggestion[];
  /** trueの間、画像アップロード中であることを示す（呼び出し元は送信ボタンのdisabledに反映する） */
  onUploadingChange?: (uploading: boolean) => void;
};

export function MentionTextarea({
  value,
  onChange,
  issueSuggestions = [],
  onKeyDown,
  onBlur,
  className,
  onUploadingChange,
  disabled,
  ...props
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const mentionItems =
    trigger?.type === "mention"
      ? MENTION_SUGGESTIONS.filter((name) => name.startsWith(trigger.query.toLowerCase()))
      : [];
  const issueItems =
    trigger?.type === "issue"
      ? issueSuggestions
          .filter(
            (issue) =>
              trigger.query === "" ||
              String(issue.number).startsWith(trigger.query) ||
              issue.title.toLowerCase().includes(trigger.query.toLowerCase()),
          )
          .slice(0, MAX_ISSUE_SUGGESTIONS)
      : [];
  const itemCount = trigger?.type === "mention" ? mentionItems.length : issueItems.length;

  function applySuggestion(inserted: string) {
    if (!trigger) return;
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? value.length;
    const before = value.slice(0, trigger.start);
    const after = value.slice(cursor);
    const symbol = trigger.type === "mention" ? "@" : "#";
    const text = `${symbol}${inserted} `;
    onChange(`${before}${text}${after}`);
    setTrigger(null);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + text.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    const cursor = e.target.selectionStart ?? e.target.value.length;
    setTrigger(detectTrigger(e.target.value, cursor));
    setActiveIndex(0);
  }

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    onChange(`${before}${text}${after}`);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + text.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function uploadImage(file: File) {
    setUploadError(null);
    setIsUploading(true);
    onUploadingChange?.(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/issues/images", { method: "POST", body: formData });
      if (!res.ok) throw new Error("upload_failed");
      const data: { url: string } = await res.json();
      insertAtCursor(`![${file.name}](${data.url})`);
    } catch {
      setUploadError("画像のアップロードに失敗しました");
    } finally {
      setIsUploading(false);
      onUploadingChange?.(false);
    }
  }

  function uploadImageFiles(files: Iterable<File>) {
    for (const file of files) {
      if (ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        uploadImage(file);
      }
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    uploadImageFiles(files);
  }

  function handleDrop(e: DragEvent<HTMLTextAreaElement>) {
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((file) =>
      ACCEPTED_IMAGE_TYPES.includes(file.type),
    );
    if (files.length === 0) return;
    e.preventDefault();
    uploadImageFiles(files);
  }

  function handleDragOver(e: DragEvent<HTMLTextAreaElement>) {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) uploadImageFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (trigger && itemCount > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % itemCount);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + itemCount) % itemCount);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (trigger.type === "mention") {
          applySuggestion(mentionItems[activeIndex]);
        } else {
          applySuggestion(String(issueItems[activeIndex].number));
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            setTrigger(null);
            onBlur?.(e);
          }}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={() => setIsDraggingOver(false)}
          disabled={disabled}
          className={cn(isDraggingOver && "ring-3 ring-ring/50", className)}
          {...props}
        />
        {trigger && itemCount > 0 && (
          <ul
            role="listbox"
            className="absolute z-20 mt-1 max-h-48 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          >
            {trigger.type === "mention"
              ? mentionItems.map((name, index) => (
                  <li key={name} role="option" aria-selected={index === activeIndex}>
                    <button
                      type="button"
                      className={cn(
                        "w-full rounded-sm px-2 py-1 text-left hover:bg-accent",
                        index === activeIndex && "bg-accent",
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applySuggestion(name);
                      }}
                    >
                      @{name}
                    </button>
                  </li>
                ))
              : issueItems.map((issue, index) => (
                  <li key={issue.number} role="option" aria-selected={index === activeIndex}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-baseline gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-accent",
                        index === activeIndex && "bg-accent",
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applySuggestion(String(issue.number));
                      }}
                    >
                      <span className="shrink-0 font-medium">#{issue.number}</span>
                      <span className="truncate text-muted-foreground">{issue.title}</span>
                    </button>
                  </li>
                ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isUploading}
        >
          {isUploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
          {isUploading ? "アップロード中..." : "画像を添付"}
        </Button>
        {uploadError && <span className="text-xs text-destructive">{uploadError}</span>}
      </div>
    </div>
  );
}
