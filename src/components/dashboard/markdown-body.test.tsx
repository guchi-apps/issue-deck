// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactPreviewProvider } from "@/components/dashboard/artifact-preview";
import { GithubReferenceNavigationProvider } from "@/components/dashboard/github-reference-navigation";
import { MarkdownBody } from "@/components/dashboard/markdown-body";
import type { SessionArtifactView } from "@/lib/dispatch/session-artifact";
import type { GithubReference } from "@/lib/github-reference";

afterEach(() => cleanup());

function renderBody(content: string, openReference: (reference: GithubReference) => void) {
  return render(
    <GithubReferenceNavigationProvider openReference={openReference}>
      <MarkdownBody content={content} repositoryFullName="guchi-apps/issue-deck" />
    </GithubReferenceNavigationProvider>,
  );
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(element, event);
  return event;
}

describe("MarkdownBody のリンク", () => {
  // `#123`はrehypeLinkifyIssueRefsがGitHubのURLへ展開したうえで、クリック時に
  // アプリ内遷移へ差し替わる（#1260）
  it("本文中の #番号 はアプリ内でIssueを開く", () => {
    const openReference = vi.fn();
    renderBody("詳細は #1260 を参照。", openReference);

    const event = click(screen.getByText("#1260"));

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 1260,
      kind: "issue",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("本文中のPRのURLはアプリ内でPRを開く", () => {
    const openReference = vi.fn();
    renderBody("対応PR: https://github.com/guchi-apps/issue-deck/pull/42", openReference);

    click(screen.getByText("https://github.com/guchi-apps/issue-deck/pull/42"));

    expect(openReference).toHaveBeenCalledWith({
      repositoryFullName: "guchi-apps/issue-deck",
      number: 42,
      kind: "pull",
    });
  });

  it("GitHub以外・Issue/PR以外のリンクは別タブで開く外部リンクのまま", () => {
    const openReference = vi.fn();
    renderBody(
      "[実行ログ](https://github.com/guchi-apps/issue-deck/actions/runs/1) と [公式](https://example.com)",
      openReference,
    );

    const runLink = screen.getByText("実行ログ");
    expect(click(runLink).defaultPrevented).toBe(false);
    expect(click(screen.getByText("公式")).defaultPrevented).toBe(false);
    expect(openReference).not.toHaveBeenCalled();
    expect(runLink.getAttribute("target")).toBe("_blank");
  });
});

// チェックボックスに付く行番号は`rehypeTaskListItems`がASTの`position`から取る（#1486）。
// `rehype-raw`・`rehype-sanitize`を通しても行番号が保たれることを、ここで実際に確かめている。
const ARTIFACT_ID = "f4de9149-e883-4d06-af33-5da3a592aa59";
const ARTIFACT_URL = `https://claude.ai/code/artifact/${ARTIFACT_ID}`;

const STORED_ARTIFACT: SessionArtifactView = {
  id: "art_1",
  title: "見た目案",
  description: null,
  favicon: null,
  claudeUrl: ARTIFACT_URL,
  claudeArtifactId: ARTIFACT_ID,
  hostName: "subpc",
  byteSize: 100,
  publishedAt: "2026-08-22T10:00:00.000Z",
};

describe("MarkdownBody のアーティファクトリンク（#2154）", () => {
  function renderWithArtifacts(content: string, artifacts: SessionArtifactView[]) {
    return render(
      <ArtifactPreviewProvider artifacts={artifacts}>
        <MarkdownBody content={content} repositoryFullName="guchi-apps/issue-deck" />
      </ArtifactPreviewProvider>,
    );
  }

  it("保存済みのアーティファクトURLはアプリ内プレビューを開く", () => {
    renderWithArtifacts(`アーティファクト: ${ARTIFACT_URL}`, [STORED_ARTIFACT]);

    const event = click(screen.getByText(ARTIFACT_URL));

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(
      "/api/issues/artifacts/art_1",
    );
  });

  it("保存していないURLは素の外部リンクのまま（claude.aiを開く）", () => {
    renderWithArtifacts(`アーティファクト: ${ARTIFACT_URL}`, []);

    const link = screen.getByText(ARTIFACT_URL);
    const event = click(link);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute("href")).toBe(ARTIFACT_URL);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("修飾キー付きのクリックはブラウザに任せ、遷移先はissue-deckの単独ページ（#2210）", () => {
    renderWithArtifacts(`アーティファクト: ${ARTIFACT_URL}`, [STORED_ARTIFACT]);

    const link = screen.getByText(ARTIFACT_URL);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    // claude.aiのままだと、別で開いたときだけログインを求められる（スマホでは特に）
    expect(link.getAttribute("href")).toBe("/artifacts/art_1");
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("MarkdownBody のタスクリスト", () => {
  const body = ["## やること", "", "- [x] SSHする", "- [ ] .envを直す"].join("\n");

  function renderTasks(content: string, props: Partial<ComponentProps<typeof MarkdownBody>> = {}) {
    return render(
      <GithubReferenceNavigationProvider openReference={vi.fn()}>
        <MarkdownBody content={content} {...props} />
      </GithubReferenceNavigationProvider>,
    );
  }

  function checkboxes(): HTMLInputElement[] {
    return screen.getAllByRole("checkbox") as HTMLInputElement[];
  }

  it("onToggleTaskを渡すと、クリックした項目の行番号とチェック後の状態を返す", () => {
    const onToggleTask = vi.fn();
    renderTasks(body, { onToggleTask });

    const boxes = checkboxes();
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);

    fireEvent.click(boxes[1]);
    expect(onToggleTask).toHaveBeenCalledWith(4, true);

    fireEvent.click(boxes[0]);
    expect(onToggleTask).toHaveBeenCalledWith(3, false);
  });

  it("入れ子のタスクは親ではなく自分の行番号を返す", () => {
    const onToggleTask = vi.fn();
    renderTasks(["- [ ] 親", "  - [ ] 子"].join("\n"), { onToggleTask });

    fireEvent.click(checkboxes()[1]);

    expect(onToggleTask).toHaveBeenCalledWith(2, true);
  });

  it("コードブロック内の例示はチェックボックスにならず、後続の行番号もずれない", () => {
    const onToggleTask = vi.fn();
    renderTasks(["```markdown", "- [ ] 例示", "```", "", "- [ ] 実際のタスク"].join("\n"), {
      onToggleTask,
    });

    const boxes = checkboxes();
    expect(boxes).toHaveLength(1);

    fireEvent.click(boxes[0]);
    expect(onToggleTask).toHaveBeenCalledWith(5, true);
  });

  // 連打で本文の更新が競合しないよう、送信が終わるまでは操作させない。
  // （jsdomのfireEventはdisabledでもchangeを起こせてしまうため、属性そのものを確かめる）
  it("送信中はチェックを操作できない", () => {
    renderTasks(body, { onToggleTask: vi.fn(), isTaskToggling: true });

    for (const box of checkboxes()) {
      expect(box.disabled).toBe(true);
    }
  });

  it("onToggleTaskを渡さない場合は今までどおり読み取り専用", () => {
    renderTasks(body);

    for (const box of checkboxes()) {
      expect(box.disabled).toBe(true);
    }
  });
});

// 手作業Issueのコマンドを、スマホから範囲選択せずに取り出せるようにする（#1726）。
describe("MarkdownBody のコードブロック", () => {
  function renderContent(content: string) {
    return render(
      <GithubReferenceNavigationProvider openReference={vi.fn()}>
        <MarkdownBody content={content} />
      </GithubReferenceNavigationProvider>,
    );
  }

  function mockClipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("コピーボタンでコードブロック全体をコピーする", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    renderContent(["```bash", "git -C ~/apps/issue-deck pull --ff-only", "pnpm install", "```"].join("\n"));

    fireEvent.click(screen.getByRole("button", { name: "コードをコピー" }));

    // 末尾の改行は落とす（貼り付けた時点でコマンドが実行されないように）
    expect(writeText).toHaveBeenCalledWith("git -C ~/apps/issue-deck pull --ff-only\npnpm install");
    expect(await screen.findByRole("button", { name: "コピーしました" })).toBeTruthy();
  });

  // コピーできていないのに成功表示を出すと、貼り付けて初めて失敗に気づくことになる
  it("コピーに失敗したときは成功表示を出さない", async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    // フォールバック（execCommand）もjsdomには無いので、失敗の扱いになる
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    renderContent(["```", "ssh vps", "```"].join("\n"));

    fireEvent.click(screen.getByRole("button", { name: "コードをコピー" }));

    expect(await screen.findByRole("button", { name: "コピーできませんでした" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "コピーしました" })).toBeNull();
  });

  it("中身が空のコードブロックにはコピーボタンを出さない", () => {
    renderContent(["```", "```"].join("\n"));

    expect(screen.queryByRole("button", { name: "コードをコピー" })).toBeNull();
  });

  it("本文中のインラインのコードにはコピーボタンを出さない", () => {
    renderContent("`develop`の最新へ更新する。");

    expect(screen.queryByRole("button", { name: "コードをコピー" })).toBeNull();
  });
});

// react-markdownは各コンポーネントへhastのノード（node）も渡してくる。DOMへ流すと
// `node="[object Object]"`という無効な属性になるので、どの要素でも落としておく（#1499）。
describe("MarkdownBody のDOM属性", () => {
  it("描画したHTMLにnode属性が残らない", () => {
    const { container } = render(
      <GithubReferenceNavigationProvider openReference={vi.fn()}>
        <MarkdownBody
          content={[
            "`ssh vps`を実行する。",
            "",
            "```bash",
            "ssh vps",
            "```",
            "",
            "![図](https://example.com/a.png)",
            "",
            "[リンク](https://example.com)",
            "",
            "- [ ] タスク",
            "",
            "| 見出し |",
            "| --- |",
            "| 値 |",
          ].join("\n")}
        />
      </GithubReferenceNavigationProvider>,
    );

    expect(container.querySelectorAll("[node]")).toHaveLength(0);
  });
});

// 本文の画像は別タブではなくアプリ内のプレビューで開く（#2065）。ホーム画面から起動した
// アプリにはタブが無く、別タブに開くと元の画面へ戻る導線が消えていた。
describe("MarkdownBody の画像", () => {
  it("画像を押すとプレビューが開き、バツボタンで閉じる", () => {
    render(
      <GithubReferenceNavigationProvider openReference={vi.fn()}>
        <MarkdownBody content="![kanban.png](https://example.com/kanban.png)" />
      </GithubReferenceNavigationProvider>,
    );

    expect(screen.queryByRole("button", { name: "プレビューを閉じる" })).toBeNull();

    fireEvent.click(screen.getByAltText("kanban.png"));
    const close = screen.getByRole("button", { name: "プレビューを閉じる" });
    // 本文のサムネイルとプレビューの2枚になる
    expect(screen.getAllByAltText("kanban.png")).toHaveLength(2);

    fireEvent.click(close);
    expect(screen.queryByRole("button", { name: "プレビューを閉じる" })).toBeNull();
  });
});
