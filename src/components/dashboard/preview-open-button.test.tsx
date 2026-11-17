// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PreviewOpenButton,
  PreviewOpenProvider,
  type PreviewOpenContextValue,
} from "@/components/dashboard/preview-open-button";
import type { DispatchHostView } from "@/lib/dispatch/dispatch-job";

const REPO = "guchi-apps/issue-deck";

function host(overrides: Partial<DispatchHostView> = {}): DispatchHostView {
  return {
    name: "subpc",
    repositories: [REPO],
    contractVersion: 2,
    online: true,
    lastSeenAt: "2026-11-17T12:00:00.000Z",
    previewCapable: true,
    previewRepositories: [REPO],
    preview: null,
    ...overrides,
  } as DispatchHostView;
}

function renderButton(value: Partial<PreviewOpenContextValue>) {
  return render(
    <PreviewOpenProvider
      value={{
        hosts: [host()],
        jobs: [],
        isLoaded: true,
        onRequestPreview: vi.fn().mockResolvedValue({ ok: true }),
        ...value,
      }}
    >
      <PreviewOpenButton repositoryFullName={REPO} />
    </PreviewOpenProvider>,
  );
}

describe("PreviewOpenButton（#5495）", () => {
  afterEach(cleanup);

  it("提供元が無い・取得前は何も出さない", () => {
    const { container } = render(<PreviewOpenButton repositoryFullName={REPO} />);
    expect(container.textContent).toBe("");
    cleanup();
    expect(renderButton({ isLoaded: false }).container.textContent).toBe("");
  });

  it("停止中は起動ボタンを出し、押すと start を積む。所要時間の注記も出す", async () => {
    const onRequestPreview = vi.fn().mockResolvedValue({ ok: true });
    renderButton({ onRequestPreview });
    expect(screen.getByText(/数分かかります/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /developを確認環境で起動/ }));
    await waitFor(() =>
      expect(onRequestPreview).toHaveBeenCalledWith({
        hostName: "subpc",
        repositoryFullName: REPO,
        action: "start",
      }),
    );
  });

  it("動いていれば、tailnetのURLへの「開く」リンクになる（window.openは使わない）", () => {
    const open = vi.spyOn(window, "open");
    renderButton({
      hosts: [
        host({
          preview: {
            repository: REPO,
            port: 4000,
            branch: "develop",
            url: "http://subpc.tail5210f2.ts.net:4000/",
            commit: "ea52e5c4",
            subject: null,
            startedAt: null,
            idleMinutes: 60,
            seed: null,
          },
        }),
      ],
    });
    const link = screen.getByRole("link", { name: /developを開く/ });
    expect(link.getAttribute("href")).toBe("http://subpc.tail5210f2.ts.net:4000/");
    expect(open).not.toHaveBeenCalled();
  });

  it("開発サーバーを持たないリポジトリでは何も出さない", () => {
    const { container } = renderButton({ hosts: [host({ previewRepositories: [] })] });
    expect(container.textContent).toBe("");
  });
});
