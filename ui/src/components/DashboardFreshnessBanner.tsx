import { useEffect, useState } from "react";
import { fetchDashboardStatus } from "../api";
import type { DashboardStatus } from "../types";

const FRESHNESS_POLL_MS = 60_000;

export default function DashboardFreshnessBanner() {
  const [status, setStatus] = useState<DashboardStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetchDashboardStatus()
        .then((next) => { if (!cancelled) setStatus(next); })
        .catch(() => { /* An unreachable probe is not evidence that the loaded build is stale. */ });
    };
    refresh();
    const timer = window.setInterval(refresh, FRESHNESS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (status?.freshness !== "stale") return null;
  const started = Number.isFinite(Date.parse(status.startedAt))
    ? new Date(status.startedAt).toLocaleString()
    : status.startedAt;
  const port = window.location.port || "3000";
  const nextStep = `kill ${status.pid} && PORT=${port} flowcrew start`;
  return (
    <div className="dashboard-stale-banner" role="alert" data-testid="dashboard-stale-banner">
      <strong>Dashboard code is stale.</strong>
      <span>
        This page is served by code loaded at {started}; disk now contains {status.diskIsNewer ? "a newer" : "a different"} build.
      </span>
      <span>Run on the dashboard host: <code>{nextStep}</code></span>
    </div>
  );
}
