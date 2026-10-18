import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyDeployVersionCheck, stripYamlComments } from "@/lib/deploy-version-check";

const GATE = `
      # APP_COMMIT_SHA は guchi-apps/vps#298 のgateが /api/app-version と照合する
      - name: Send environment variables
        env:
          APP_COMMIT_SHA: \${{ github.sha }}
        run: |
          {
            printf '%s\\n' "APP_COMMIT_SHA=\${APP_COMMIT_SHA}"
          } | ssh -p "\${SSH_PORT}" "\${USERNAME}@\${HOST}" env
      - name: Deploy and restart
        run: ssh -p "\${SSH_PORT}" "\${USERNAME}@\${HOST}" deploy
`;

describe("classifyDeployVersionCheck（#4757）", () => {
  it("issue-deck自身のdeploy.ymlは自身の照合（self）", () => {
    expect(classifyDeployVersionCheck(readFileSync(".github/workflows/deploy.yml", "utf-8"))).toBe("self");
  });

  it("gateへAPP_COMMIT_SHAをenvで渡してdeployを呼ぶ形はgate", () => {
    expect(classifyDeployVersionCheck(GATE)).toBe("gate");
  });

  it("コメントを書き換えても判定は変わらない", () => {
    expect(classifyDeployVersionCheck(GATE.replace(/^\s*#.*$/m, "      # 別の説明"))).toBe("gate");
    expect(classifyDeployVersionCheck(GATE.replace(/^\s*#.*$/m, ""))).toBe("gate");
  });

  it("コメントやechoに2語を書いただけの照合なしは none", () => {
    const text = `
      # APP_COMMIT_SHA と /api/app-version を照合する（つもり）
      - run: echo "check /api/app-version against APP_COMMIT_SHA"
      - run: curl -fsS http://127.0.0.1:3000/login
`;
    expect(classifyDeployVersionCheck(text)).toBe("none");
  });

  it("コメント行だけでgateの形を装っても none", () => {
    const text = GATE.split("\n").map((l) => (l.trim() ? `# ${l}` : l)).join("\n");
    expect(classifyDeployVersionCheck(text)).toBe("none");
  });

  it("deployを呼ばない（envを渡すだけ）は none", () => {
    expect(classifyDeployVersionCheck(GATE.replace(/ deploy\n/, " restart\n"))).toBe("none");
  });

  it("stripYamlCommentsは行末コメントも落とす", () => {
    expect(stripYamlComments("a: 1 # c\n# d\nb: 2")).toBe("a: 1\n\nb: 2");
  });
});
