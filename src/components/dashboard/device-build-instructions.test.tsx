// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DeviceBuildInstructions } from "@/components/dashboard/device-build-instructions";

describe("DeviceBuildInstructions", () => {
  afterEach(() => {
    cleanup();
  });

  it("コマンドを表示する", () => {
    render(<DeviceBuildInstructions deviceBuild={{ command: "echo hello" }} />);
    expect(screen.getByText("echo hello")).not.toBeNull();
  });

  it("buildTargetOidを渡すとビルド対象の短縮OIDを表示する", () => {
    render(
      <DeviceBuildInstructions
        deviceBuild={{ command: "echo hello" }}
        buildTargetOid="0123456789abcdef"
      />,
    );
    expect(screen.getByText("0123456")).not.toBeNull();
  });

  it("buildTargetOidを渡さなければビルド対象の文言を出さない", () => {
    render(<DeviceBuildInstructions deviceBuild={{ command: "echo hello" }} />);
    expect(screen.queryByText(/今回ビルドする/)).toBeNull();
  });
});
