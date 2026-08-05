import type { RunEvent } from "../types";
import { humanizeRunEvents } from "./run/model";

export default function ActivityFeed({ events }: { events?: RunEvent[] }) {
  const readableEvents = humanizeRunEvents(events);
  return (
    <div className="activity-feed" data-testid="activity-feed" tabIndex={0} aria-label="Recent run activity">
      <div className="feed-title">Recent activity</div>
      {readableEvents.length === 0 ? <div className="empty-state">no events recorded for the operator view</div> : readableEvents.map((event) => (
        <div className="activity-row" key={event.key} data-testid="activity-row">
          <time className="ts" dateTime={event.timestamp}>{event.timestamp.slice(11, 19) || event.timestamp}</time>
          <span className={`ev ${event.kind}`}>{event.description}</span>
          <span className="activity-message">{event.context}</span>
        </div>
      ))}
    </div>
  );
}
