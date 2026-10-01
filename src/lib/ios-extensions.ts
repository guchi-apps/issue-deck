/**
 * iOSアプリの拡張（ウィジェット・ロック画面・ライブアクティビティ・コントロール。#3708）。
 *
 * 一覧は**Swiftソースの宣言から推定した結果**で、Xcodeプロジェクトの正確な解析ではない。
 * 命名や書き方によっては漏れるため、画面にも「検出結果」と明記する。
 * 追加・編集は画面からSwiftを生成せず、種類別テンプレートでIssueを起票して通常の実装経路に渡す。
 */
export const IOS_EXTENSION_KINDS = ["widget", "lock-screen", "live-activity", "control"] as const;
export type IosExtensionKind = (typeof IOS_EXTENSION_KINDS)[number];

export const IOS_EXTENSION_KIND_LABELS: Record<IosExtensionKind, string> = {
  widget: "ウィジェット",
  "lock-screen": "ロック画面",
  "live-activity": "ライブアクティビティ",
  control: "コントロール",
};

export function isIosExtensionKind(value: unknown): value is IosExtensionKind {
  return typeof value === "string" && (IOS_EXTENSION_KINDS as readonly string[]).includes(value);
}

export type IosExtension = {
  kind: IosExtensionKind;
  /** Swiftの構造体名（`configurationDisplayName`があればそちらを`displayName`に持つ） */
  name: string;
  displayName: string | null;
  path: string;
};

/**
 * issue-deckが扱うiOSアプリのリポジトリ。判定は`webview-ios-repos.ts`・`device-build-repos.ts`の
 * 固定リストと同じ判断（`Repository`に種別の列は無い）で、ここは走査の候補を並べるだけ。
 * `guchi-apps/myroom`は`kurashio`の旧名（再同期されるまで旧名で残る）。
 */
export const IOS_EXTENSION_REPOSITORY_NAMES = [
  "guchi-apps/aide-ios",
  "guchi-apps/kurashio",
  "guchi-apps/myroom",
] as const;

/** 走査するSwiftファイルのパス。拡張が置かれる名前だけに絞り、取得するBlobの数を抑える */
export function isExtensionCandidatePath(path: string): boolean {
  return path.endsWith(".swift") && /widget|activity|control|extension/i.test(path);
}

const ACCESSORY_FAMILY = /\.accessory(Circular|Rectangular|Inline|Corner)\b/;
const HOME_FAMILY = /\.system(Small|Medium|Large|ExtraLarge)\b/;
const STRUCT_DECLARATION = /^\s*(?:public\s+|private\s+|fileprivate\s+)?struct\s+(\w+)\s*:\s*([^{]*)\{/gm;

/** 1つのSwiftファイルから拡張を検出する */
export function detectExtensionsInSource(path: string, source: string): IosExtension[] {
  const declarations = [...source.matchAll(STRUCT_DECLARATION)];
  const found: IosExtension[] = [];

  declarations.forEach((match, index) => {
    const conformances = match[2];
    const isControl = /\bControlWidget\b/.test(conformances);
    const isWidget = /(^|[\s,])Widget\b/.test(conformances);
    if (!isControl && !isWidget) return;

    const start = match.index ?? 0;
    const end = declarations[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    const name = match[1];
    const displayName = body.match(/configurationDisplayName\(\s*"([^"]+)"/)?.[1] ?? body.match(/displayName:\s*"([^"]+)"/)?.[1] ?? null;
    const entry = (kind: IosExtensionKind): IosExtension => ({ kind, name, displayName, path });

    if (isControl) {
      found.push(entry("control"));
      return;
    }
    if (/\bActivityConfiguration\b/.test(body)) {
      found.push(entry("live-activity"));
      return;
    }
    const hasAccessory = ACCESSORY_FAMILY.test(body);
    if (hasAccessory) found.push(entry("lock-screen"));
    // ファミリの指定が無いウィジェットは既定（ホーム画面向け）として扱う
    if (!hasAccessory || HOME_FAMILY.test(body)) found.push(entry("widget"));
  });

  return found;
}

export function detectExtensions(files: { path: string; source: string }[]): IosExtension[] {
  return files
    .flatMap((file) => detectExtensionsInSource(file.path, file.source))
    .sort((a, b) => IOS_EXTENSION_KINDS.indexOf(a.kind) - IOS_EXTENSION_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name));
}

const KIND_GUIDES: Record<IosExtensionKind, string[]> = {
  widget: [
    "WidgetKitのWidget Extensionに`Widget`を追加する（Extensionが無ければターゲットから作る）",
    "対応サイズ（systemSmall / systemMedium / systemLarge）と各サイズの表示内容を決める",
    "データはApp Groupの共有コンテナ経由で本体アプリと受け渡し、`TimelineProvider`の更新間隔を決める",
  ],
  "lock-screen": [
    "WidgetKitの`Widget`に`accessoryCircular` / `accessoryRectangular` / `accessoryInline`のファミリを指定する",
    "ロック画面は単色（vibrant）描画になるため、色に頼らない表示にする",
    "データはApp Groupの共有コンテナ経由で本体アプリと受け渡す",
  ],
  "live-activity": [
    "ActivityKitの`ActivityAttributes`（固定値とContentState）を定義し、Widget Extensionに`ActivityConfiguration`を追加する",
    "ロック画面・Dynamic Islandの各表示（compact / expanded / minimal）を決める",
    "開始・更新・終了のタイミングと、プッシュ更新を使うかどうかを決める（Info.plistの`NSSupportsLiveActivities`も確認する）",
  ],
  control: [
    "iOS 18のControl Widget（`ControlWidget`）を追加する。ボタン（`ControlWidgetButton`）かトグル（`ControlWidgetToggle`）かを決める",
    "実行する処理は`AppIntent`で実装し、本体アプリ側の処理との受け渡し方を決める",
    "コントロールセンター・ロック画面・アクションボタンに置けることを確認する",
  ],
};

export type IosExtensionIssueDraft = {
  mode: "add" | "edit";
  repositoryFullName: string;
  kind: IosExtensionKind;
  /** 編集時の対象（検出した拡張） */
  target?: Pick<IosExtension, "name" | "displayName" | "path">;
  /** 利用者が書いた、表示したい内容・変えたい内容 */
  description: string;
};

/** 種類別テンプレートからIssueのタイトルと本文を組み立てる */
export function buildIosExtensionIssue(draft: IosExtensionIssueDraft): { title: string; body: string } {
  const kindLabel = IOS_EXTENSION_KIND_LABELS[draft.kind];
  const targetLabel = draft.target ? (draft.target.displayName ?? draft.target.name) : null;
  const description = draft.description.trim();
  const title =
    draft.mode === "edit" && targetLabel
      ? `iOS${kindLabel}「${targetLabel}」を変更する`
      : `iOS${kindLabel}を追加する${description ? `: ${firstLine(description, 40)}` : ""}`;

  const lines = [
    "<!-- ios-extension-request -->",
    `## ${draft.mode === "edit" ? "変更したい内容" : "表示したい内容"}`,
    "",
    description || "（未記入。実装前に内容を決める）",
    "",
    "## 対象",
    "",
    `- 種類: ${kindLabel}`,
    `- リポジトリ: ${draft.repositoryFullName}`,
  ];
  if (draft.target) {
    lines.push(`- 既存の拡張: \`${draft.target.name}\`（\`${draft.target.path}\`）`);
  }
  lines.push("", "## 実装の目安", "", ...KIND_GUIDES[draft.kind].map((guide) => `- ${guide}`));
  lines.push(
    "",
    "## 確認",
    "",
    "- 実機（またはシミュレータ）でホーム画面・ロック画面に追加して表示を確認する",
    "- Xcodeでの実機反映が要る場合は、反映後の確認手順をPR本文に書く",
  );
  return { title, body: lines.join("\n") };
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/)[0];
  return line.length > max ? `${line.slice(0, max)}…` : line;
}
