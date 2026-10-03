CREATE TABLE "DispatchSessionTimelineEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DispatchSessionTimelineEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchSessionTimelineEvent_sessionId_occurredAt_kind_title_key"
ON "DispatchSessionTimelineEvent"("sessionId", "occurredAt", "kind", "title");
CREATE INDEX "DispatchSessionTimelineEvent_sessionId_occurredAt_idx"
ON "DispatchSessionTimelineEvent"("sessionId", "occurredAt");
ALTER TABLE "DispatchSessionTimelineEvent" ADD CONSTRAINT "DispatchSessionTimelineEvent_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "DispatchSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
