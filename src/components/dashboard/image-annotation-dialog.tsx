"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Loader2,
  Move,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { useHistoryDismiss } from "@/hooks/use-history-dismiss";
import {
  ANNOTATION_COLORS,
  ANNOTATION_SIZES,
  EMPTY_HISTORY,
  colorValue,
  commitShapes,
  drawShape,
  findShapeAt,
  fontSizeFor,
  isNegligibleShape,
  measureTextWidth,
  moveShape,
  redoShapes,
  strokeWidthFor,
  undoShapes,
  type AnnotationColor,
  type AnnotationSize,
  type AnnotationTool,
  type Point,
  type Shape,
  type ShapeHistory,
} from "@/lib/annotation/shapes";
import { cn } from "@/lib/utils";
import { useDialogOverlayDisabled } from "@/components/ui/dialog";

/** 書き込みを始める画像。閉じているときは`null` */
export type AnnotationTarget = {
  src: string;
  name: string;
};

/** `POST /api/issues/images`の上限（10MB）。PNGで超えたらJPEGで出し直す */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 表示倍率の上限。小さなスクリーンショットを大画面で引き伸ばしすぎないため */
const MAX_DISPLAY_SCALE = 1.5;

const TOOLS: { id: AnnotationTool; label: string; icon: typeof Pencil }[] = [
  { id: "move", label: "移動", icon: Move },
  { id: "pen", label: "ペン", icon: Pencil },
  { id: "arrow", label: "矢印", icon: MoveUpRight },
  { id: "rect", label: "四角", icon: Square },
  { id: "text", label: "文字", icon: Type },
];

/**
 * 添付画像に線・矢印・四角・文字を書き込む全画面のエディタ（#2972）。
 *
 * 「表示されている文字を変えたい」「順番を入れ替えたい」を画像の上で示すためのもの。
 * 書いたものは保存するまで図形として持ち（`lib/annotation/shapes.ts`）、「移動」で位置を
 * 直せる。保存すると元の解像度で1枚の画像に描き出し、`onSave`へ渡す——アップロードと
 * 添付の差し替えは呼び出し元（`mention-textarea.tsx`）が行う。
 *
 * 閉じ方は画像プレビューと揃える（キャンセル・Esc・スマホの戻る操作）。書きかけが
 * あるときは破棄してよいかを聞く。**戻る操作は履歴エントリがすでに外れた後に届くため、
 * そこで「編集を続ける」を選ぶと次の戻る操作は下の画面へ効く**（`useHistoryDismiss`の
 * 仕組み上、エントリを積み直せない）。
 */
export function ImageAnnotationDialog({
  image,
  onClose,
  onSave,
}: {
  image: AnnotationTarget | null;
  onClose: () => void;
  onSave: (file: File) => Promise<void>;
}) {
  const open = image !== null;
  const setDialogOverlayDisabled = useDialogOverlayDisabled();
  const close = useCallback(() => {
    setDialogOverlayDisabled(false);
    onClose();
  }, [onClose, setDialogOverlayDisabled]);
  // 書きかけの有無は中のエディタだけが知っている。戻る操作・Escはここで受けて中へ渡す
  const requestCloseRef = useRef<() => void>(close);
  const requestClose = useCallback(() => requestCloseRef.current(), []);
  useHistoryDismiss(open, requestClose);

  // 親の共通Dialog暗幕は半透明かつぼかし付きで、iOS Safariではポータルの書き込み画面より
  // 前面に合成されることがある。書き込み中は親の暗幕も外し、不透明な書き込み画面1枚だけにする（#2993・#3006）。
  useLayoutEffect(() => {
    setDialogOverlayDisabled(open);
    return () => setDialogOverlayDisabled(false);
  }, [open, setDialogOverlayDisabled]);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* 暗幕（Overlay）は置かない（#3006）。中身が不透明な全画面なので見た目上は要らず、
            置くとiOS Safariが同じz-60の暗幕を中身より上に描き、画面全体が90%の黒に覆われて
            入力も奪われた（DOM順は正しかった。スクショの画素値が暗幕のbg-black/90と一致）。
            中身は他の全画面の層（z-50）より明示的に上へ置く（#2983） */}
        {image && (
          <AnnotationEditor
            key={image.src}
            image={image}
            onClose={close}
            onSave={onSave}
            requestCloseRef={requestCloseRef}
          />
        )}
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type TextEdit = {
  /** 書き直している既存の文字。新しく置く場合は`null` */
  id: string | null;
  at: Point;
  value: string;
  color: AnnotationColor;
  fontSize: number;
};

type Drag = { id: string; start: Point; origin: Shape; moved: boolean };

let shapeSeq = 0;
function nextShapeId(): string {
  shapeSeq += 1;
  return `shape-${shapeSeq}`;
}

function AnnotationEditor({
  image,
  onClose,
  onSave,
  requestCloseRef,
}: {
  image: AnnotationTarget;
  onClose: () => void;
  onSave: (file: File) => Promise<void>;
  requestCloseRef: React.RefObject<() => void>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null);

  const [tool, setTool] = useState<AnnotationTool>("pen");
  const [color, setColor] = useState<AnnotationColor>("red");
  const [size, setSize] = useState<AnnotationSize>("medium");
  const [history, setHistory] = useState<ShapeHistory>(EMPTY_HISTORY);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [moving, setMoving] = useState<Shape[] | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const shapes = history.present;
  const dirty = shapes.length > 0 || (textEdit !== null && textEdit.value.trim() !== "");

  useEffect(() => {
    requestCloseRef.current = () => {
      if (dirty) setConfirmDiscard(true);
      else onClose();
    };
  }, [dirty, onClose, requestCloseRef]);

  useEffect(() => {
    textEditRef.current = textEdit;
  }, [textEdit]);

  // 画像は同一オリジン（/api/issues/images）なので、描き出してもcanvasは汚染されない
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setNatural({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => setLoadError(true);
    img.src = image.src;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [image.src]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStageSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scale =
    natural && stageSize && stageSize.width > 0 && stageSize.height > 0
      ? Math.min(stageSize.width / natural.width, stageSize.height / natural.height, MAX_DISPLAY_SCALE)
      : 1;

  const editingId = textEdit?.id ?? null;
  const visibleShapes = useMemo(
    () => (moving ?? shapes).filter((s) => s.id !== editingId),
    [moving, shapes, editingId],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !img || !ctx || !natural) return;
    ctx.clearRect(0, 0, natural.width, natural.height);
    ctx.drawImage(img, 0, 0);
    for (const shape of visibleShapes) drawShape(ctx, shape);
    if (draft) drawShape(ctx, draft);
  }, [natural, visibleShapes, draft]);

  function toImagePoint(e: PointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    const width = natural?.width ?? rect.width;
    const height = natural?.height ?? rect.height;
    return {
      x: ((e.clientX - rect.left) * width) / (rect.width || width),
      y: ((e.clientY - rect.top) * height) / (rect.height || height),
    };
  }

  function commit(next: Shape[]) {
    setHistory((h) => commitShapes(h, next));
  }

  /** 入力中の文字を図形に反映した一覧。保存時と確定時の両方で使う */
  function shapesWithText(base: Shape[], edit: TextEdit | null): Shape[] {
    if (!edit) return base;
    const text = edit.value.trim();
    if (text === "") return edit.id ? base.filter((s) => s.id !== edit.id) : base;
    const shape: Shape = {
      id: edit.id ?? nextShapeId(),
      type: "text",
      color: edit.color,
      at: edit.at,
      text,
      fontSize: edit.fontSize,
      textWidth: measureTextWidth(canvasRef.current?.getContext("2d") ?? null, text, edit.fontSize),
    };
    return edit.id ? base.map((s) => (s.id === edit.id ? shape : s)) : [...base, shape];
  }

  function finishText() {
    const edit = textEditRef.current;
    if (!edit) return;
    textEditRef.current = null;
    setTextEdit(null);
    const next = shapesWithText(shapes, edit);
    if (next !== shapes) commit(next);
  }

  function cancelText() {
    textEditRef.current = null;
    setTextEdit(null);
  }

  function startTextEdit(target: Shape & { type: "text" }) {
    const edit: TextEdit = {
      id: target.id,
      at: target.at,
      value: target.text,
      color: target.color,
      fontSize: target.fontSize,
    };
    textEditRef.current = edit;
    setTextEdit(edit);
  }

  function tolerance(e: PointerEvent) {
    return (e.pointerType === "touch" ? 16 : 8) / scale;
  }

  function handlePointerDown(e: PointerEvent<HTMLCanvasElement>) {
    if (!natural || saving) return;
    // 互換のmousedownを止める。止めないと、この直後に出す文字の入力欄からフォーカスが
    // 外れ（キャンバスはフォーカスを受け取らないため）、入力が始まる前に確定されてしまう
    e.preventDefault();
    // 文字の入力中に画像を押したら、まず入力を確定するだけにする
    if (textEditRef.current) {
      finishText();
      return;
    }
    const point = toImagePoint(e);
    const hit = findShapeAt(shapes, point, tolerance(e));

    if (tool === "text") {
      if (hit?.type === "text") {
        startTextEdit(hit);
        return;
      }
      const edit: TextEdit = {
        id: null,
        at: point,
        value: "",
        color,
        fontSize: fontSizeFor(size, natural.width, natural.height),
      };
      textEditRef.current = edit;
      setTextEdit(edit);
      return;
    }

    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (tool === "move") {
      if (hit) dragRef.current = { id: hit.id, start: point, origin: hit, moved: false };
      return;
    }

    const common = { id: nextShapeId(), color };
    const width = strokeWidthFor(size, natural.width, natural.height);
    setDraft(
      tool === "pen"
        ? { ...common, type: "pen", width, points: [point] }
        : { ...common, type: tool, width, from: point, to: point },
    );
  }

  function handlePointerMove(e: PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (drag) {
      const point = toImagePoint(e);
      drag.moved = true;
      const moved = moveShape(drag.origin, point.x - drag.start.x, point.y - drag.start.y);
      setMoving(shapes.map((s) => (s.id === drag.id ? moved : s)));
      return;
    }
    if (!draft) return;
    const point = toImagePoint(e);
    setDraft(
      draft.type === "pen"
        ? { ...draft, points: [...draft.points, point] }
        : draft.type === "text"
          ? draft
          : { ...draft, to: point },
    );
  }

  function handlePointerUp() {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      if (drag.moved && moving) commit(moving);
      setMoving(null);
      return;
    }
    if (draft) {
      if (!isNegligibleShape(draft)) commit([...shapes, draft]);
      setDraft(null);
    }
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (tool !== "move" || !natural) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const point = {
      x: ((e.clientX - rect.left) * natural.width) / (rect.width || natural.width),
      y: ((e.clientY - rect.top) * natural.height) / (rect.height || natural.height),
    };
    const hit = findShapeAt(shapes, point, 8 / scale);
    if (hit?.type === "text") startTextEdit(hit);
  }

  function undo() {
    cancelText();
    setHistory(undoShapes);
  }

  function redo() {
    cancelText();
    setHistory(redoShapes);
  }

  function clearAll() {
    cancelText();
    if (shapes.length > 0) commit([]);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (textEditRef.current) return;
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }

  async function save() {
    const img = imageRef.current;
    if (!img || !natural) return;
    const finalShapes = shapesWithText(shapes, textEditRef.current);
    finishText();
    setSaving(true);
    setSaveError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = natural.width;
      canvas.height = natural.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no_canvas");
      ctx.drawImage(img, 0, 0);
      for (const shape of finalShapes) drawShape(ctx, shape);
      let blob = await toBlob(canvas, "image/png");
      let type = "image/png";
      if (blob.size > MAX_UPLOAD_BYTES) {
        blob = await toBlob(canvas, "image/jpeg", 0.9);
        type = "image/jpeg";
      }
      const file = new File([blob], annotatedFileName(image.name, type), { type });
      await onSave(file);
      onClose();
    } catch {
      setSaveError("保存に失敗しました。もう一度お試しください");
      setSaving(false);
    }
  }

  const actionButtons = (
    <>
      <ToolbarButton onClick={undo} disabled={history.past.length === 0 || saving} label="元に戻す">
        <Undo2 />
      </ToolbarButton>
      <ToolbarButton onClick={redo} disabled={history.future.length === 0 || saving} label="やり直す">
        <Redo2 />
      </ToolbarButton>
      <ToolbarButton onClick={clearAll} disabled={shapes.length === 0 || saving} label="全部消す">
        <Trash2 />
      </ToolbarButton>
      <button
        type="button"
        onClick={save}
        disabled={!natural || saving || !dirty}
        className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-semibold text-neutral-900 hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none disabled:opacity-50 md:h-8"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        {saving ? "保存中..." : "保存して差し替え"}
      </button>
    </>
  );

  return (
    <DialogPrimitive.Content
      data-slot="image-annotation"
      aria-describedby={undefined}
      onKeyDown={handleKeyDown}
      onEscapeKeyDown={(e) => {
        // 文字の入力中のEscは入力の取り消しだけにする
        if (textEditRef.current) {
          e.preventDefault();
          cancelText();
        }
      }}
      // 背景色は中身にも持たせ、暗幕との描画順に見た目を左右させない（#2983）
      className="fixed inset-0 z-60 flex flex-col bg-neutral-950 text-white outline-none"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => requestCloseRef.current()}
          disabled={saving}
          className="inline-flex h-10 shrink-0 items-center gap-1 rounded-lg border border-white/25 bg-white/10 px-3 text-sm hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none disabled:opacity-50 md:h-8"
        >
          <X className="size-4" />
          キャンセル
        </button>
        <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-xs text-white/70">
          画像に書き込む — {image.name}
        </DialogPrimitive.Title>
        <div className="hidden items-center gap-1.5 md:flex">{actionButtons}</div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          role="toolbar"
          aria-label="書き込みの道具"
          className="order-2 flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 py-2 md:order-1 md:justify-start"
        >
          <div className="flex items-center gap-0.5 rounded-xl bg-white/10 p-0.5">
            {TOOLS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={tool === id}
                onClick={() => {
                  finishText();
                  setTool(id);
                }}
                className={cn(
                  "flex h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1.5 text-[10px] text-white/80 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none md:h-10",
                  tool === id ? "bg-white text-neutral-900" : "hover:bg-white/15",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-xl bg-white/10 px-2.5 py-1.5">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={c.label}
                title={c.label}
                aria-pressed={color === c.id}
                onClick={() => {
                  setColor(c.id);
                  // 入力中の文字にも色を効かせる
                  setTextEdit((edit) => (edit ? { ...edit, color: c.id } : edit));
                }}
                style={{ backgroundColor: c.value }}
                className={cn(
                  "size-7 rounded-full border-2 border-white/40 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none",
                  color === c.id && "border-transparent ring-2 ring-white ring-offset-2 ring-offset-neutral-900",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-xl bg-white/10 p-0.5">
            {ANNOTATION_SIZES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`太さ: ${s.label}`}
                title={s.label}
                aria-pressed={size === s.id}
                onClick={() => setSize(s.id)}
                className={cn(
                  "grid size-9 place-items-center rounded-lg focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none",
                  size === s.id ? "bg-white/25" : "hover:bg-white/15",
                )}
              >
                <span className="block rounded-full bg-white" style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
              </button>
            ))}
          </div>
        </div>

        <div ref={stageRef} className="relative order-1 min-h-0 flex-1 md:order-2">
          <div className="absolute inset-0 grid place-items-center">
            {loadError ? (
              <p className="text-sm text-white/70">画像を読み込めませんでした</p>
            ) : !natural ? (
              <Loader2 className="size-6 animate-spin text-white/70" aria-label="画像を読み込み中" />
            ) : (
              <div
                className="relative"
                style={{ width: natural.width * scale, height: natural.height * scale }}
              >
                <canvas
                  ref={canvasRef}
                  width={natural.width}
                  height={natural.height}
                  aria-label={`${image.name} への書き込み`}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onDoubleClick={handleDoubleClick}
                  className={cn(
                    "block size-full touch-none rounded-sm shadow-[0_0_0_1px_rgba(255,255,255,0.15)]",
                    tool === "move" ? "cursor-move" : tool === "text" ? "cursor-text" : "cursor-crosshair",
                  )}
                />
                {textEdit && (
                  <input
                    autoFocus
                    aria-label="書き込む文字"
                    value={textEdit.value}
                    placeholder="文字を入力"
                    onChange={(e) =>
                      setTextEdit((edit) => (edit ? { ...edit, value: e.target.value } : edit))
                    }
                    onBlur={finishText}
                    onKeyDown={(e) => {
                      // IME変換中のEnterは確定に使わない
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        finishText();
                      }
                    }}
                    style={{
                      left: textEdit.at.x * scale,
                      top: textEdit.at.y * scale,
                      color: colorValue(textEdit.color),
                      // iOSは16px未満の入力欄で画面を拡大するため下回らせない
                      fontSize: Math.max(16, textEdit.fontSize * scale),
                    }}
                    className={cn(
                      "absolute min-w-[8em] rounded-sm border border-dashed border-current px-1 font-bold [field-sizing:content] focus:outline-none",
                      textEdit.color === "white" ? "bg-neutral-900/85" : "bg-white/90",
                    )}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <p className="order-3 shrink-0 px-3 pb-1 text-center text-[11px] text-white/55 md:order-3">
          {tool === "text"
            ? "置きたい場所を押して入力し、Enterで確定します。書いた文字を押すと書き直せます"
            : tool === "move"
              ? "書いたものをドラッグして位置を直せます。文字はダブルクリックで書き直せます"
              : "画像の上をなぞって書き込みます"}
        </p>

        {saveError && (
          <p role="alert" className="order-3 shrink-0 px-3 pb-1 text-center text-xs text-red-300">
            {saveError}
          </p>
        )}

        <div className="order-4 flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          {actionButtons}
        </div>
      </div>

      {confirmDiscard && (
        <div
          role="alertdialog"
          aria-label="書き込みを破棄しますか"
          className="absolute inset-x-3 top-16 mx-auto flex max-w-md flex-col gap-3 rounded-xl border border-white/15 bg-neutral-900 p-4 shadow-lg"
        >
          <p className="text-sm">書き込んだ内容は保存されていません。破棄して閉じますか？</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setConfirmDiscard(false)}
              className="h-10 rounded-lg border border-white/25 px-3 text-sm hover:bg-white/10 md:h-8"
            >
              編集を続ける
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-lg bg-red-500 px-3 text-sm font-semibold text-white hover:bg-red-500/90 md:h-8"
            >
              破棄して閉じる
            </button>
          </div>
        </div>
      )}
    </DialogPrimitive.Content>
  );
}

function ToolbarButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/25 bg-white/10 hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none disabled:opacity-40 md:size-8 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("to_blob_failed"))),
      type,
      quality,
    );
  });
}

/** 元のファイル名に「-annotated」を足し、拡張子を出力形式に合わせる */
export function annotatedFileName(name: string, type: string): string {
  const base = name.replace(/\.[^./]+$/, "").replace(/-annotated$/, "") || "image";
  return `${base}-annotated.${type === "image/jpeg" ? "jpg" : "png"}`;
}
