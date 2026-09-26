-- CreateTable
CREATE TABLE `ClaudeApiUsageCumulative` (
    `model` VARCHAR(191) NOT NULL,
    `inputTokens` BIGINT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`model`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 通算カウンタの初期値は、いま保持している5分バケット（直近7日）の合計から引き継ぐ。
INSERT INTO `ClaudeApiUsageCumulative` (`model`, `inputTokens`, `updatedAt`)
SELECT `model`, SUM(`inputTokens`), NOW(3)
FROM `ClaudeApiUsageBucket`
GROUP BY `model`;
