import { describe, expect, it } from "vitest";

import {
  computeManualStepHostApplications,
  describeManualStepHostApplications,
  isManualStepAllHostsGuide,
  isManualStepAppliedOnAllHosts,
  pickPendingManualStepHost,
} from "@/lib/manual-step-host-application";
import { parseManualStepGuide } from "@/lib/manual-step-guide";

const job = (targetHost: string, command: string) => ({ targetHost, command });

describe("全ホストで揃える手作業の適用状況（#5568）", () => {
  it("Mac miniだけ確認が通っていれば「MacMini 済／サブPC 未適用」で、全ホスト済みではない", () => {
    const applications = computeManualStepHostApplications({
      commands: ["test -f ~/a", "test -f ~/b"],
      hosts: ["subpc", "macmini"],
      succeededJobs: [job("macmini", "test -f ~/a"), job("macmini", "test -f ~/b")],
    });
    expect(applications).toEqual([
      { host: "macmini", applied: true },
      { host: "subpc", applied: false },
    ]);
    expect(describeManualStepHostApplications(applications)).toBe("MacMini 済／サブPC 未適用");
    expect(isManualStepAppliedOnAllHosts(applications)).toBe(false);
  });

  it("確認コマンドの一部しか通っていないホストは未適用", () => {
    const [entry] = computeManualStepHostApplications({
      commands: ["a", "b"],
      hosts: ["macmini"],
      succeededJobs: [job("macmini", "a")],
    });
    expect(entry.applied).toBe(false);
  });

  it("両方のホストで通れば全ホスト済み。サブPCが戻って実行されると揃う", () => {
    const applications = computeManualStepHostApplications({
      commands: ["a"],
      hosts: ["macmini", "subpc"],
      succeededJobs: [job("macmini", "a"), job("subpc", "a")],
    });
    expect(isManualStepAppliedOnAllHosts(applications)).toBe(true);
  });

  it("確認コマンドが無い・ホストが分からないときは済みとして扱わない", () => {
    expect(
      computeManualStepHostApplications({ commands: [], hosts: ["macmini"], succeededJobs: [] }),
    ).toEqual([{ host: "macmini", applied: false }]);
    expect(isManualStepAppliedOnAllHosts([])).toBe(false);
  });

  it("未適用のホストのうち優先順の先頭を選ぶ", () => {
    const applications = [
      { host: "macmini", applied: true },
      { host: "subpc", applied: false },
    ];
    expect(pickPendingManualStepHost(applications, ["macmini", "subpc"])).toBe("subpc");
    expect(pickPendingManualStepHost(applications, ["macmini"])).toBeNull();
  });

  it("（ローカル・全ホスト）の印で全ホスト手順と判定する", () => {
    const body = "## やること\n\n- [ ] （ローカル・全ホスト）値を足す\n";
    expect(isManualStepAllHostsGuide(parseManualStepGuide(body))).toBe(true);
    expect(
      isManualStepAllHostsGuide(parseManualStepGuide("## やること\n\n- [ ] （ローカル）設定する\n")),
    ).toBe(false);
    expect(
      isManualStepAllHostsGuide(
        parseManualStepGuide("## 前提条件\n\n- 実行するデバイス: ローカル（全ホスト）\n"),
      ),
    ).toBe(true);
  });
});
