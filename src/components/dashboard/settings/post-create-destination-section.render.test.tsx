// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostCreateDestinationSection } from "@/components/dashboard/settings/post-create-destination-section";
import { POST_CREATE_DESTINATION_STORAGE_KEY } from "@/lib/post-create-destination";

describe("PostCreateDestinationSection（#2862）", () => {
  beforeEach(() => window.localStorage.clear());

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("既定は「毎回選ぶ」で、その意味を添える", () => {
    render(<PostCreateDestinationSection />);

    expect(screen.getByText("Issueを作った後に開く画面")).not.toBeNull();
    expect(screen.getByText("作成のたびに選択画面を出します。")).not.toBeNull();
    expect(screen.getByLabelText("Issueを作った後に開く画面")).not.toBeNull();
  });

  /** 選択画面の「次回からこの画面を出さない」で保存された値が、ここに出てくる */
  it("端末に保存された行き先を読んで説明を出す", async () => {
    window.localStorage.setItem(POST_CREATE_DESTINATION_STORAGE_KEY, JSON.stringify("stay"));
    render(<PostCreateDestinationSection />);

    expect(await screen.findByText("開いていた一覧・カンバンのままにします。")).not.toBeNull();
  });

  it("壊れた値が残っていても既定へ落として表示する", async () => {
    window.localStorage.setItem(POST_CREATE_DESTINATION_STORAGE_KEY, JSON.stringify("issue"));
    render(<PostCreateDestinationSection />);

    expect(await screen.findByText("作成のたびに選択画面を出します。")).not.toBeNull();
  });
});
