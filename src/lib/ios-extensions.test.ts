import { describe, expect, it } from "vitest";

import {
  buildIosExtensionIssue,
  detectExtensions,
  detectExtensionsInSource,
  isExtensionCandidatePath,
} from "./ios-extensions";

const WIDGET = `
struct TodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "today", provider: Provider()) { _ in Text("x") }
      .configurationDisplayName("今日の予定")
      .supportedFamilies([.systemSmall, .accessoryRectangular])
  }
}
`;

describe("detectExtensionsInSource", () => {
  it("ホーム向けとロック画面向けのファミリを両方持つウィジェットは2種類で出す", () => {
    const result = detectExtensionsInSource("W/TodayWidget.swift", WIDGET);
    expect(result.map((e) => e.kind)).toEqual(["lock-screen", "widget"]);
    expect(result[0]).toMatchObject({ name: "TodayWidget", displayName: "今日の予定" });
  });

  it("ActivityConfigurationはライブアクティビティ、ControlWidgetはコントロール", () => {
    const source = `
struct BuildActivity: Widget {
  var body: some WidgetConfiguration { ActivityConfiguration(for: A.self) { _ in Text("") } }
}
struct AirconControl: ControlWidget {
  var body: some ControlWidgetConfiguration { StaticControlConfiguration(kind: "a") { } }
}
struct Bundle: WidgetBundle { var body: some Widget { TodayWidget() } }
`;
    expect(detectExtensionsInSource("A.swift", source).map((e) => [e.kind, e.name])).toEqual([
      ["live-activity", "BuildActivity"],
      ["control", "AirconControl"],
    ]);
  });

  it("ファミリ指定の無いウィジェットはホーム画面向け", () => {
    const source = "struct Plain: Widget {\n var body: some WidgetConfiguration { EmptyWidgetConfiguration() }\n}";
    expect(detectExtensionsInSource("P.swift", source).map((e) => e.kind)).toEqual(["widget"]);
  });
});

describe("detectExtensions / isExtensionCandidatePath", () => {
  it("種類の順に並べる", () => {
    const result = detectExtensions([{ path: "W.swift", source: WIDGET }]);
    expect(result.map((e) => e.kind)).toEqual(["widget", "lock-screen"]);
  });

  it("走査対象は拡張らしい名前のSwiftファイルだけ", () => {
    expect(isExtensionCandidatePath("AideWidget/TodayWidget.swift")).toBe(true);
    expect(isExtensionCandidatePath("App/Views/Home.swift")).toBe(false);
    expect(isExtensionCandidatePath("AideWidget/Info.plist")).toBe(false);
  });
});

describe("buildIosExtensionIssue", () => {
  it("追加は種類別の目安を含む本文を作る", () => {
    const { title, body } = buildIosExtensionIssue({
      mode: "add",
      repositoryFullName: "guchi-apps/aide-ios",
      kind: "live-activity",
      description: "ビルド進捗を出す",
    });
    expect(title).toBe("iOSライブアクティビティを追加する: ビルド進捗を出す");
    expect(body).toContain("ActivityConfiguration");
    expect(body).toContain("ios-extension-request");
  });

  it("編集は既存の拡張のパスを本文へ残す", () => {
    const { title, body } = buildIosExtensionIssue({
      mode: "edit",
      repositoryFullName: "guchi-apps/aide-ios",
      kind: "widget",
      target: { name: "TodayWidget", displayName: "今日の予定", path: "W/TodayWidget.swift" },
      description: "3件表示にする",
    });
    expect(title).toBe("iOSウィジェット「今日の予定」を変更する");
    expect(body).toContain("`W/TodayWidget.swift`");
  });

  it("画像だけを添付したときはタイトルへ画像記法を入れない", () => {
    const image = "![image.png](https://example.com/api/issues/images/a.png)";
    const only = buildIosExtensionIssue({ mode: "add", repositoryFullName: "guchi-apps/aide-ios", kind: "widget", description: image });
    expect(only.title).toBe("iOSウィジェットを追加する");
    expect(only.body).toContain(image);
    const withText = buildIosExtensionIssue({ mode: "add", repositoryFullName: "guchi-apps/aide-ios", kind: "widget", description: `天気を出す\n\n${image}` });
    expect(withText.title).toBe("iOSウィジェットを追加する: 天気を出す");
  });
});
