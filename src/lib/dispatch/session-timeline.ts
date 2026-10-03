import { db } from "@/lib/db";

export const SESSION_TIMELINE_MAX_EVENTS = 40;
export const SESSION_TIMELINE_MAX_BODY_LENGTH = 1_200;
export const SESSION_TIMELINE_MAX_TOTAL_LENGTH = 12_000;

const KINDS = new Set(["assistant", "user", "event", "step", "waiting", "error"]);

export type SessionTimelineEventInput = {
  occurredAt: string;
  kind: string;
  title: string;
  body?: string | null;
};

export type SessionTimelineEventView = {
  id: string;
  occurredAt: string;
  kind: string;
  title: string;
  body: string | null;
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

/** 表示専用の安全なイベントだけを受け付ける。生のtool結果・コマンドはここへ入れない。 */
export function parseSessionTimelineEvents(value: unknown): SessionTimelineEventInput[] | null {
  if (!Array.isArray(value) || value.length > SESSION_TIMELINE_MAX_EVENTS) return null;
  let total = 0;
  const parsed: SessionTimelineEventInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const event = item as Record<string, unknown>;
    const occurredAt = text(event.occurredAt, 40);
    const kind = text(event.kind, 32);
    const title = text(event.title, 160);
    const body = event.body === undefined || event.body === null ? null : text(event.body, SESSION_TIMELINE_MAX_BODY_LENGTH);
    if (!occurredAt || !kind || !KINDS.has(kind) || !title || (event.body != null && body === null)) return null;
    if (Number.isNaN(new Date(occurredAt).getTime())) return null;
    total += title.length + (body?.length ?? 0);
    if (total > SESSION_TIMELINE_MAX_TOTAL_LENGTH) return null;
    parsed.push({ occurredAt, kind, title, body });
  }
  return parsed;
}

export async function replaceSessionTimeline(params: {
  sessionId: string;
  host: string;
  events: SessionTimelineEventInput[];
}): Promise<boolean> {
  const session = await db.dispatchSession.findFirst({
    where: { id: params.sessionId, host: params.host },
    select: { id: true },
  });
  if (!session) return false;
  await db.$transaction([
    db.dispatchSessionTimelineEvent.deleteMany({
      where: { sessionId: session.id, source: "transcript" },
    }),
    db.dispatchSessionTimelineEvent.createMany({
      data: params.events.map((event) => ({
        sessionId: session.id,
        source: "transcript",
        occurredAt: new Date(event.occurredAt),
        kind: event.kind,
        title: event.title,
        body: event.body ?? null,
      })),
      skipDuplicates: true,
    }),
  ]);
  return true;
}

export async function listSessionTimeline(sessionId: string): Promise<SessionTimelineEventView[]> {
  const events = await db.dispatchSessionTimelineEvent.findMany({
    where: { sessionId }, orderBy: { occurredAt: "desc" }, take: SESSION_TIMELINE_MAX_EVENTS,
  });
  return events.reverse().map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() }));
}
