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
import { Eye, ImagePlus, Loader2, Pencil, X } from "lucide-react";

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

/** 入力欄の下にサムネイルとして並べる、添付済みの画像1枚ぶん */
export type ImageAttachment = {
  /** 画像記法のalt。アップロードしたファイル名が入る */
  name: string;
  url: string;
};

/** 単独の行がまるごと画像記法（`![alt](url)`）になっているかどうか */
const ATTACHMENT_LINE_PATTERN = /^!\[([^\]]*)\]\(([^()\s]+)\)$/;

/**
 * 本文の末尾に並ぶ画像記法を「添付」として切り出す（#1819）。
 *
 * 添付は常に末尾へ足すため、末尾から空行を読み飛ばしつつ画像記法だけの行を集め、
 * それ以外の行が現れた時点で打ち切る。**文章の途中に書かれた画像記法は本文の文字として
 * そのまま残す**——過去の下書きや既存コメントには文中に画像を置いたものがあり、
 * それらを勝手に末尾へ動かすと編集で本文が書き換わってしまうため。
 */
export function splitAttachments(value: string): { body: string; attachments: ImageAttachment[] } {
  const lines = value.split("\n");
  const attachments: ImageAttachment[] = [];
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === "") {
      end -= 1;
      continue;
    }
    const match = ATTACHMENT_LINE_PATTERN.exec(line);
    if (!match) break;
    attachments.unshift({ name: match[1], url: match[2] });
    end -= 1;
  }
  if (attachments.length === 0) return { body: value, attachments: [] };
  return { body: lines.slice(0, end).join("\n").replace(/\s+$/, ""), attachments };
}

/** `splitAttachments`の逆。本文と添付から、呼び出し元へ渡す1本の文字列を組み立てる */
export function composeAttachments(body: string, attachments: ImageAttachment[]): string {
  // 添付が無いときに本文へ手を入れると、末尾の改行が消えて入力の邪魔になる。
  if (attachments.length === 0) return body;
  const block = attachments.map(({ name, url }) => `![${name}](${url})`).join("\n");
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? block : `${trimmed}\n\n${block}`;
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
  const [uploads, setUploads] = useState<{ id: number; name: string }[]>([]);
  const isUploading = uploads.length > 0;
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isPreview, setIsPreview] = useState(false);

  // 呼び出し元へ渡す値（value）は「本文＋末尾の画像記法」のままにし、表示だけを分ける（#1819）。
  // 入力欄には本文だけを出し、末尾の画像記法はサムネイルとして下に並べる。
  const [{ body, attachments }, setContent] = useState(() => splitAttachments(value));
  // 複数画像を同時にアップロードすると、各アップロード完了時のonChangeがレンダー未反映の値を
  // 閉じ込めてしまい、後勝ちで他方の追加結果を消してしまう。更新のたびに同期更新するrefを
  // 正とすることで、完了順が前後しても両方の添付を保持できるようにする。
  const bodyRef = useRef(body);
  const attachmentsRef = useRef(attachments);
  const lastEmittedRef = useRef(value);
  const uploadIdRef = useRef(0);
  useEffect(() => {
    // onChange経由で自分が発行した値への追従（エコーバック）は無視し、送信後のクリアや
    // 下書きの復元など呼び出し元起因の外部変更のみを取り込む。
    if (value === lastEmittedRef.current) return;
    const next = splitAttachments(value);
    lastEmittedRef.current = value;
    bodyRef.current = next.body;
    attachmentsRef.current = next.attachments;
    setContent(next);
  }, [value]);

  function emitChange(nextBody: string, nextAttachments: ImageAttachment[]) {
    bodyRef.current = nextBody;
    attachmentsRef.current = nextAttachments;
    setContent({ body: nextBody, attachments: nextAttachments });
    const nextValue = composeAttachments(nextBody, nextAttachments);
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
    const cursor = el?.selectionStart ?? body.length;
    const before = body.slice(0, trigger.start);
    const after = body.slice(cursor);
    const symbol = trigger.type === "mention" ? "@" : "#";
    const text = `${symbol}${inserted} `;
    emitChange(`${before}${text}${after}`, attachmentsRef.current);
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
    emitChange(e.target.value, attachmentsRef.current);
    const cursor = e.target.selectionStart ?? e.target.value.length;
    setTrigger(detectTrigger(e.target.value, cursor));
    setActiveIndex(0);
  }

  function removeAttachment(index: number) {
    emitChange(
      bodyRef.current,
      attachmentsRef.current.filter((_, i) => i !== index),
    );
  }

  async function uploadImage(file: File) {
    setUploadError(null);
    uploadIdRef.current += 1;
    const uploadId = uploadIdRef.current;
    setUploads((prev) => [...prev, { id: uploadId, name: file.name }]);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/issues/images", { method: "POST", body: formData });
      if (!res.ok) throw new Error("upload_failed");
      const data: { url: string } = await res.json();
      // カーソル位置は見ない。添付は常に末尾（サムネイル列の右端）へ足す（#1819）。
      emitChange(bodyRef.current, [...attachmentsRef.current, { name: file.name, url: data.url }]);
    } catch {
      setUploadError("画像のアップロードに失敗しました");
    } finally {
      setUploads((prev) => prev.filter((upload) => upload.id !== uploadId));
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
          value={body}
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
          // iOS Safariはfont-sizeが16px未満の入力欄にフォーカスすると画面を自動拡大するため、
          // スマホでは16px（text-base）を下回らせない。md以上（PC）は従来どおり14px（#1442）。
          className={cn("text-base md:text-sm", isDraggingOver && "ring-3 ring-ring/50", className)}
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
      {(attachments.length > 0 || uploads.length > 0) && (
        <AttachmentStrip
          attachments={attachments}
          uploads={uploads}
          onRemove={removeAttachment}
          disabled={disabled}
        />
      )}
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

/**
 * 添付した画像を入力欄の下にサムネイルで横一列に並べる（#1819）。
 * 枚数が増えても高さを1段に保ちたいので、折り返さず横スクロールにする——折り返すと
 * スマホで送信ボタンが画面外へ押し出されるため。
 */
function AttachmentStrip({
  attachments,
  uploads,
  onRemove,
  disabled,
}: {
  attachments: ImageAttachment[];
  uploads: { id: number; name: string }[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  const countLabel = [
    attachments.length > 0 ? `添付 ${attachments.length}枚` : null,
    uploads.length > 0 ? `${uploads.length}枚アップロード中` : null,
  ]
    .filter(Boolean)
    .join("・");

  return (
    <div className="flex items-center gap-2 overflow-x-auto py-0.5" data-slot="mention-attachments">
      {attachments.map((attachment, index) => (
        <div key={`${attachment.url}-${index}`} className="relative size-16 shrink-0 md:size-18">
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            title={`${attachment.name}（新しいタブで開く）`}
            className="block size-full overflow-hidden rounded-md border"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachment.url} alt={attachment.name} className="size-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/80 to-transparent px-1 pt-2 pb-0.5 text-[9px] leading-tight text-white">
              {attachment.name}
            </span>
          </a>
          <button
            type="button"
            onClick={() => onRemove(index)}
            disabled={disabled}
            aria-label={`${attachment.name} の添付を取り消す`}
            className="absolute top-0.5 right-0.5 grid size-6 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      {uploads.map((upload) => (
        <div
          key={upload.id}
          title={`${upload.name} をアップロード中`}
          className="grid size-16 shrink-0 place-items-center rounded-md border border-dashed text-muted-foreground md:size-18"
        >
          <Loader2 className="size-4 animate-spin" />
        </div>
      ))}
      <span className="shrink-0 text-[11px] text-muted-foreground">{countLabel}</span>
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
