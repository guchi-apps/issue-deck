-- 既存の使用量はClaude Codeの転記だけから収集していたため、既定値でClaudeへ移行する。
ALTER TABLE `SessionUsage`
    ADD COLUMN `agent` VARCHAR(16) NOT NULL DEFAULT 'claude';

DROP INDEX `SessionUsage_host_sessionId_key` ON `SessionUsage`;
CREATE UNIQUE INDEX `SessionUsage_host_agent_sessionId_key`
    ON `SessionUsage`(`host`, `agent`, `sessionId`);
