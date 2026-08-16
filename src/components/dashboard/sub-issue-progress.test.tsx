// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SubIssueProgress } from "@/components/dashboard/sub-issue-progress";
import type { SubIssue, SubIssueRelations } from "@/types/issue";

function child(number: number, overrides: Partial<SubIssue> = {}): SubIssue {
  return {
    number,
    title: `子Issue ${number}`,
    state: "open",
    htmlUrl: `https://github.com/guchi-apps/issue-deck/issues/${number}`,
    repositoryFullName: "guchi-apps/issue-deck",
    projectStatus: null,
    ...overrides,
  };
}

function relations(overrides: Partial<SubIssueRelations> = {}): SubIssueRelations {
  return { parent: null, children: [], childCount: 0, ...overrides };
}

describe("SubIssueProgress", () => {
  afterEach(cleanup);

  it("親も子も無ければ何も描かない", () => {
    const { container } = render(<SubIssueProgress relations={relations()} />);
    expect(container.innerHTML).toBe("");
  });

  it("親だけあるときは親のリンクだけを出す", () => {
    render(
      <SubIssueProgress
        relations={relations({
          parent: child(1200, { title: "監督エージェントの役を追加する", state: "closed" }),
        })}
      />,
    );

    expect(screen.getByText("親Issue")).toBeTruthy();
    expect(screen.getByText("#1200")).toBeTruthy();
    expect(screen.queryByText("子Issue")).toBeNull();
  });

  it("子の進捗の内訳と完了件数を出す", () => {
    render(
      <SubIssueProgress
        relations={relations({
          children: [
            child(1177, { state: "closed" }),
            child(1178, { state: "closed" }),
            child(1190),
            child(1012, { projectStatus: "Implementation" }),
          ],
          childCount: 4,
        })}
      />,
    );

    expect(screen.getByText("2 / 4 完了")).toBeTruthy();
    expect(screen.getByText("未着手 1")).toBeTruthy();
    expect(screen.getByText("実装中 1")).toBeTruthy();
    expect(screen.getByText("本番反映済 2")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("子の行はGitHubのIssueへのリンクになる", () => {
    render(<SubIssueProgress relations={relations({ children: [child(1190)], childCount: 1 })} />);

    const link = screen.getByRole("link", { name: /1190/ });
    expect(link.getAttribute("href")).toBe("https://github.com/guchi-apps/issue-deck/issues/1190");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("別リポジトリの子にだけリポジトリ名を添える（#1722）", () => {
    render(
      <SubIssueProgress
        relations={relations({
          children: [
            child(1190),
            child(1190, {
              repositoryFullName: "guchi-apps/car-care",
              htmlUrl: "https://github.com/guchi-apps/car-care/issues/1190",
            }),
          ],
          childCount: 2,
        })}
        baseRepositoryFullName="guchi-apps/issue-deck"
      />,
    );

    // 同番号の子が並んでも、リポジトリ名で見分けが付く
    expect(screen.getAllByText("#1190")).toHaveLength(2);
    expect(screen.getByText("car-care").getAttribute("title")).toBe("guchi-apps/car-care");
    expect(screen.queryByText("issue-deck")).toBeNull();
  });

  it("基準リポジトリを渡さなければリポジトリ名は出さない", () => {
    render(
      <SubIssueProgress
        relations={relations({
          children: [child(1190, { repositoryFullName: "guchi-apps/car-care" })],
          childCount: 1,
        })}
      />,
    );
    expect(screen.queryByText("car-care")).toBeNull();
  });

  it("取得上限を超えた分は件数として補足する", () => {
    render(
      <SubIssueProgress relations={relations({ children: [child(1190)], childCount: 103 })} />,
    );
    expect(screen.getByText(/ほか102件/)).toBeTruthy();
  });
});
