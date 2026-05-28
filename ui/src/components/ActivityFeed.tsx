import type { RunEvent } from "../types";

function eventKind(event: RunEvent): string {
  const ev = event.event ?? event.type ?? "";
  if (/complete|success|done/i.test(ev)) return "complete";
  if (/error|fail/i.test(ev)) return "error";
  if (/guide|supervisor/i.test(ev)) return "guide";
  return "";
}

export default function ActivityFeed({ events }: { events?: RunEvent[] }) {
  const validEvents = (events ?? []).filter((event) => event && (event.ts || event.timestamp));
  return (
    <div className="activity-feed" data-testid="activity-feed" tabIndex={0} aria-label="Activity feed events">
      <div className="feed-title">Activity feed <span>· events.jsonl</span></div>
      {validEvents.length === 0 ? <div className="empty-state">no events recorded</div> : validEvents.map((event, index) => {
        const name = event.event ?? event.type ?? "?";
        const ts = String(event.ts ?? event.timestamp ?? "");
        return (
          <div className="activity-row" key={`${ts}-${name}-${index}`} data-testid="activity-row">
            <span className="ts">{ts.slice(11, 19)}</span>
            <span className={`ev ${eventKind(event)}`}>{name}</span>
            <span className="activity-message">{event.stage ?? event.message ?? event.detail ?? ""}</span>
          </div>
        );
      })}
    </div>
  );
}
