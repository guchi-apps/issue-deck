// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseRcCancel } from "./release-rc-cancel";
import type { RcCandidateView } from "@/lib/release-rc-run";

const candidate = { id: "rc1", sequence: 1, label: "RC-1", phase: "review", prNumber: 12,
  status: { status: "needs_fix", label: "修正が必要" } } as RcCandidateView;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("確認を断れば送らず、承認後は見ていた候補・段階で取消を依頼する", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetch);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const changed = vi.fn();
  render(<ReleaseRcCancel candidate={candidate} repositoryFullName="o/r" onChanged={changed} />);
  fireEvent.click(screen.getByRole("button"));
  expect(fetch).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ owner: "o", repo: "r", action: "cancel", candidateId: "rc1", expectedPhase: "review" });
});

it("競合・取消失敗を完了とせず理由を表示する", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "candidate_changed" }) }));
  const changed = vi.fn();
  render(<ReleaseRcCancel candidate={candidate} repositoryFullName="o/r" onChanged={changed} />);
  fireEvent.click(screen.getByRole("button"));
  expect((await screen.findByRole("alert")).textContent).toContain("候補の状態が変わっています");
  expect(changed).not.toHaveBeenCalled();
});

it.each(["deploying", "verifying_production", "completed", "cancelled"])("%sでは取消操作を出さない", (phase) => {
  render(<ReleaseRcCancel candidate={{ ...candidate, phase }} repositoryFullName="o/r" onChanged={() => {}} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it.each(["preparing", "awaiting_approval"])("%sでは確認後にその段階を前提として取消を依頼する", async (phase) => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const changed = vi.fn();
  render(<ReleaseRcCancel candidate={{ ...candidate, phase }} repositoryFullName="o/r" onChanged={changed} />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[0][1].body).expectedPhase).toBe(phase);
});

it("検証中・合格候補には取消操作を出さない", () => {
  render(<ReleaseRcCancel candidate={{ ...candidate, status: { ...candidate.status, status: "ready_to_prepare" } }} repositoryFullName="o/r" onChanged={() => {}} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("修正系列が残るreview候補にも正規の取消操作を出す", () => {
  render(<ReleaseRcCancel candidate={{ ...candidate, status: { ...candidate.status, status: "fixing" } }} repositoryFullName="o/r" onChanged={() => {}} />);
  expect(screen.getByRole("button", { name: "候補を取り消して作り直す" })).toBeTruthy();
});
