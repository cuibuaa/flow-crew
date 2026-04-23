import { useState, useEffect } from "react";
import type { SettingsData } from "../types";
import { fetchSettings } from "../api";

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-rc-muted">Loading…</div>;
  if (error) return <div className="text-rc-error">Error: {error}</div>;
  if (!settings) return null;

  return (
    <div>
      <h2 className="text-sm font-semibold text-rc-text mb-4">Settings</h2>
      <div className="glass-panel rounded-card p-6 space-y-4 text-sm">
        <Row label="Project Directory" value={settings.projectDir} mono />
        <Row label="Adapter" value={settings.adapter} />
        <Row label="Server Port" value={String(settings.port)} mono />
        <div>
          <span className="text-xs font-bold text-rc-muted uppercase tracking-wider">Workflows</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {settings.workflows.map((w) => (
              <span key={w} className="text-xs px-2 py-0.5 bg-rc-card border border-rc-border text-rc-text-secondary rounded-input">{w}</span>
            ))}
          </div>
        </div>
        <div>
          <span className="text-xs font-bold text-rc-muted uppercase tracking-wider">Skills</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {settings.skills.map((s) => (
              <span key={s} className="text-xs px-2 py-0.5 bg-rc-card border border-rc-border text-rc-text-secondary rounded-input">{s}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-xs font-bold text-rc-muted uppercase tracking-wider">{label}</span>
      <p className={`text-rc-text mt-0.5 ${mono ? "font-mono text-sm" : ""}`}>{value}</p>
    </div>
  );
}
