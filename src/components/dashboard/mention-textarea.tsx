"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Eye, ImagePlus, Loader2, Pencil } from "lucide-react";

import { MarkdownBody } from "@/components/dashboard/markdown-body";
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
  /** プレビュー時にIssue参照（#番号）をリンク化するためのリポジトリ */
  repositoryFullName?: string;
};

export function MentionTextarea({
  value,
  onChange,
  issueSuggestions = [],
  onKeyDown,
  onBlur,
  className,
  onUploadingChange,
  repositoryFullName,
  disabled,
  ...props
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [uploadingCount, setUploadingCount] = useState(0);
  const isUploading = uploadingCount > 0;
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isPreview, setIsPreview] = useState(false);

  // 複数画像を同時にアップロードすると、各アップロード完了時のonChangeがレンダー未反映のvalueを
  // 閉じ込めてしまい、後勝ちで他方の挿入結果を消してしまう。挿入のたびに同期更新するrefを
  // 正とすることで、完了順が前後しても両方の挿入結果を保持できるようにする。
  const latestValueRef = useRef(value);
  const lastEmittedRef = useRef(value);
  // 画像アップロード中に次の挿入位置を引き継ぐための参照。nullの間は実際のカーソル位置を使う。
  const pendingInsertPosRef = useRef<number | null>(null);
  const activeUploadsRef = useRef(0);
  useEffect(() => {
    // onChange経由で自分が発行した値への追従（エコーバック）は無視し、送信後のクリアなど
    // 呼び出し元起因の外部変更のみをrefへ反映する。
    if (value !== lastEmittedRef.current) {
      latestValueRef.current = value;
      lastEmittedRef.current = value;
    }
  }, [value]);

  function emitChange(nextValue: string) {
    latestValueRef.current = nextValue;
    lastEmittedRef.current = nextValue;
    onChange(nextValue);
  }

  useEffect(() => {
    onUploadingChange?.(isUploading);
  }, [isUploading, onUploadingChange]);

  // 送信後などに呼び出し元が本文を空にした場合は、空のプレビューを表示し続けずに入力へ戻す。
  const showPreview = isPreview && value.trim() !== "";

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
    emitChange(`${before}${text}${after}`);
    setTrigger(null);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = before.length + text.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    // 空になってプレビューを抜けたあと、再入力で勝手にプレビューへ戻らないようにする。
    setIsPreview(false);
    emitChange(e.target.value);
    const cursor = e.target.selectionStart ?? e.target.value.length;
    setTrigger(detectTrigger(e.target.value, cursor));
    setActiveIndex(0);
    // ユーザーが手で編集した場合は、以降の画像挿入は現在のカーソル位置へ戻す。
    pendingInsertPosRef.current = null;
  }

  function insertAtCursor(text: string) {
    const el = textareaRef.current;
    // 複数画像を同時にアップロードすると、完了順が前後してレンダー未反映の value を
    // 元に挿入し合い、互いの挿入結果を消してしまうことがあるため、常に最新の内容を
    // 保持する latestValueRef を正として使う。挿入位置も、同一操作内の他の画像の挿入で
    // 動いた分を pendingInsertPosRef で引き継ぎ、1枚目の直後に2枚目が続くようにする。
    const current = latestValueRef.current;
    const start = pendingInsertPosRef.current ?? el?.selectionStart ?? current.length;
    const end = pendingInsertPosRef.current ?? el?.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const combined = `${before}${text}${after}`;
    const nextPos = before.length + text.length;
    pendingInsertPosRef.current = nextPos;
    emitChange(combined);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextPos, nextPos);
    });
  }

  async function uploadImage(file: File) {
    setUploadError(null);
    activeUploadsRef.current += 1;
    setUploadingCount(activeUploadsRef.current);
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
      activeUploadsRef.current -= 1;
      setUploadingCount(activeUploadsRef.current);
      if (activeUploadsRef.current === 0) {
        // 一連のアップロードが終わったら、次回は改めて実際のカーソル位置から挿入する。
        pendingInsertPosRef.current = null;
      }
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
        // 候補選択中はEnterを確定操作として扱うため、祖先のCtrl+Enter送信ショートカットへ伝播させない。
        e.stopPropagation();
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

  if (showPreview) {
    return (
      <div className="flex flex-col gap-1">
        <div
          className={cn(
            "max-h-64 w-full overflow-y-auto rounded-lg border border-input px-2.5 py-2",
            className,
          )}
          data-slot="mention-textarea-preview"
        >
          <MarkdownBody content={value} repositoryFullName={repositoryFullName} />
        </div>
        <div className="flex items-center gap-2">
          <PreviewToggleButton isPreview onClick={() => setIsPreview(false)} />
        </div>
      </div>
    );
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
                        "flex min-h-11 w-full items-center rounded-sm px-2 py-1 text-left hover:bg-accent md:min-h-0",
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
                        "flex min-h-11 w-full items-baseline gap-1.5 rounded-sm px-2 py-2.5 text-left hover:bg-accent md:min-h-0 md:py-1",
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
        <PreviewToggleButton
          isPreview={false}
          onClick={() => setIsPreview(true)}
          disabled={value.trim() === ""}
        />
        {uploadError && <span className="text-xs text-destructive">{uploadError}</span>}
      </div>
    </div>
  );
}

// 添付した画像やMarkdownの見た目を投稿前に確認するための、入力とプレビューの切り替えボタン（#384）。
function PreviewToggleButton({
  isPreview,
  onClick,
  disabled,
}: {
  isPreview: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isPreview}
    >
      {isPreview ? <Pencil /> : <Eye />}
      {isPreview ? "入力に戻る" : "プレビュー"}
    </Button>
  );
}
