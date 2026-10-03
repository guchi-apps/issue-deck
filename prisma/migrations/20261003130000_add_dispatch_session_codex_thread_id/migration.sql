-- CodexのDeep Linkをissue-deck側で組み立てるため、検証済みUUIDだけを保存する。
ALTER TABLE "DispatchSession" ADD COLUMN "codexThreadId" VARCHAR(36);
