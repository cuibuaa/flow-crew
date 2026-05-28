import { useEffect, useState } from "react";
import { fetchSettings } from "../api";
import type { SettingsData } from "../types";

function fmtMs(ms?: number): string {
  if (!ms) return "—";
  if (ms < 60000) return `${ms / 1000}s`;
  return `${Math.round(ms / 60000)}m`;
}

export default function SettingsView({ initialSettings }: { initialSettings?: SettingsData }) {
  const [settings, setSettings] = useState<SettingsData | null>(initialSettings ?? null);
  useEffect(() => {
    if (initialSettings) return;
    fetchSettings().then(setSettings).catch(() => setSettings(null));
  }, [initialSettings]);
  return (
    <div data-testid="settings-view">
      <div className="campaign-header"><div><h1>Settings</h1><div className="subtitle">flow-crew config + per-project defaults</div></div></div>
      <div className="section"><h2>Runtime</h2><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">adapter</span><span>{settings?.adapter ?? "codex"}</span></div>
        <div className="sd-meta-row"><span className="k">model</span><span>{settings?.model ?? "default"}</span></div>
        <div className="sd-meta-row"><span className="k">reasoning</span><span>{settings?.reasoning_effort ?? "default"}</span></div>
        <div className="sd-meta-row"><span className="k">project</span><span className="mono">{settings?.projectDir ?? "—"}</span></div>
        <div className="sd-meta-row"><span className="k">port</span><span className="mono">{settings?.port ?? 3000}</span></div>
      </div></div>
      <div className="section"><h2>Defaults</h2><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">timeout</span><span className="mono">{fmtMs(settings?.default_timeout_ms)}</span></div>
        <div className="sd-meta-row"><span className="k">max iter</span><span className="mono">{settings?.default_max_iterations ?? "—"}</span></div>
        <div className="sd-meta-row"><span className="k">gate retry</span><span className="mono">{settings?.default_gate_retry_loops ?? "—"}</span></div>
        <div className="sd-meta-row"><span className="k">stage retry</span><span className="mono">{settings?.default_stage_technical_retries ?? "—"}</span></div>
      </div></div>
      <div className="section"><h2>Workflows and skills</h2><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">workflows</span><span>{settings?.workflows?.join(", ") || "—"}</span></div>
        <div className="sd-meta-row"><span className="k">skills</span><span>{settings?.skills?.join(", ") || "none configured"}</span></div>
      </div></div>
      <div className="section"><h2>Campaign triggers</h2><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">enabled</span><span>{settings?.campaign_triggers?.enabled === false ? "off" : "on"}</span></div>
        <div className="sd-meta-row"><span className="k">regression</span><span className="mono">{settings?.campaign_triggers?.regression_after ?? "—"} runs</span></div>
        <div className="sd-meta-row"><span className="k">plateau</span><span className="mono">{settings?.campaign_triggers?.plateau_after ?? "—"} runs · threshold {settings?.campaign_triggers?.plateau_threshold ?? "—"}</span></div>
        <div className="sd-meta-row"><span className="k">failures</span><span className="mono">{settings?.campaign_triggers?.repeated_failure_after ?? "—"} runs</span></div>
      </div></div>
      <div className="section"><h2>Supervisor</h2><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">default</span><span>{settings?.supervisor?.enabled === false ? "off" : "on"}</span></div>
        <div className="sd-meta-row"><span className="k">threshold</span><span className="mono">{settings?.supervisor?.escalation_threshold ?? "default"}</span></div>
      </div></div>
      <details className="section advanced-settings"><summary>Advanced paths</summary><div className="kpi settings-panel">
        <div className="sd-meta-row"><span className="k">runs root</span><span className="mono">~/.fc/runs/</span></div>
        <div className="sd-meta-row"><span className="k">campaigns log</span><span className="mono">~/.fc/campaigns/</span></div>
        <div className="sd-meta-row"><span className="k">cross-camp KG</span><span className="mono">~/.fc/cross-campaign-kg/</span></div>
      </div></details>
    </div>
  );
}
