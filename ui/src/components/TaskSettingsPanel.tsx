import { useState, useEffect } from "react";
import { fetchSettings } from "../api";
import { getCampaignDisplayName, getCampaignIteration } from "../types";
import type { CampaignTriggers, Task } from "../types";

interface Props {
  task: Task;
  open: boolean;
  onClose: () => void;
  onSave: (vals: { timeoutMs: number; maxIterations: number; maxRetries: number; autoApproveRetries: boolean; campaignTriggers?: CampaignTriggers }) => void;
}

const DEFAULT_TIMEOUT_MS = 30 * 60000;
const DEFAULT_MAX_ITERATIONS = 5;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TRIGGERS: CampaignTriggers = {
  enabled: true,
  regressionAfter: 2,
  plateauAfter: 3,
  plateauThreshold: 5,
  repeatedFailureAfter: 3,
};

function toMinutes(ms: number): number {
  return Math.round(ms / 60000);
}

export default function TaskSettingsPanel({ task, open, onClose, onSave }: Props) {
  const [timeoutMin, setTimeoutMin] = useState(30);
  const [maxIterations, setMaxIterations] = useState(5);
  const [maxRetries, setMaxRetries] = useState(2);
  const [autoApprove, setAutoApprove] = useState(true);
  const [triggersEnabled, setTriggersEnabled] = useState(true);
  const [regressionAfter, setRegressionAfter] = useState(2);
  const [plateauAfter, setPlateauAfter] = useState(3);
  const [plateauThreshold, setPlateauThreshold] = useState(5);
  const [repeatedFailureAfter, setRepeatedFailureAfter] = useState(3);
  const [defaultTimeoutMs, setDefaultTimeoutMs] = useState(DEFAULT_TIMEOUT_MS);

  useEffect(() => {
    fetchSettings().then(s => {
      if (s.default_timeout_ms !== undefined) setDefaultTimeoutMs(s.default_timeout_ms);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!task) return;
    const triggers = { ...DEFAULT_TRIGGERS, ...(task.campaignTriggers ?? {}) };
    setTimeoutMin(toMinutes(task.timeoutMs ?? defaultTimeoutMs));
    setMaxIterations(task.maxIterations ?? DEFAULT_MAX_ITERATIONS);
    setMaxRetries(task.maxRetries ?? DEFAULT_MAX_RETRIES);
    setAutoApprove(task.autoApproveRetries ?? true);
    setTriggersEnabled(triggers.enabled);
    setRegressionAfter(triggers.regressionAfter);
    setPlateauAfter(triggers.plateauAfter);
    setPlateauThreshold(triggers.plateauThreshold);
    setRepeatedFailureAfter(triggers.repeatedFailureAfter);
  }, [task, defaultTimeoutMs]);

  if (!open) return null;

  const isReadOnly = task.status === "completed" || task.status === "failed";

  const handleSave = () => {
    onSave({
      timeoutMs: timeoutMin * 60000,
      maxIterations,
      maxRetries,
      autoApproveRetries: autoApprove,
      campaignTriggers: {
        enabled: triggersEnabled,
        regressionAfter,
        plateauAfter,
        plateauThreshold,
        repeatedFailureAfter,
      },
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative w-80 h-full bg-rc-bg border-l border-rc-border shadow-xl overflow-auto p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-sm font-bold text-rc-text uppercase tracking-wider">Task Settings</h2>

        {(task.campaignId || task.researchInjection) && (
          <div className="rounded-card border border-rc-border bg-rc-card/60 p-3 text-xs text-rc-text-secondary space-y-2">
            {task.campaignId && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono rounded-input bg-rc-code px-2 py-0.5">
                  {getCampaignDisplayName(task)} #{task.campaignSeq ?? "?"}
                </span>
                <span className="font-mono">Campaign iteration {getCampaignIteration(task)}</span>
              </div>
            )}
            {task.researchInjection && (
              <div className="text-amber-100">
                Research injected at iteration {task.researchInjection.iteration}: {task.researchInjection.message}
              </div>
            )}
          </div>
        )}

        <label className="block text-xs text-rc-text-secondary">
          ⏱ Stage timeout (min)
          <input type="number" min={0} value={timeoutMin} onChange={e => setTimeoutMin(+e.target.value)} disabled={isReadOnly}
            className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
        </label>

        <label className="block text-xs text-rc-text-secondary">
          🔄 Max iterations
          <input type="number" min={0} value={maxIterations} onChange={e => setMaxIterations(+e.target.value)} disabled={isReadOnly}
            className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
        </label>

        <label className="block text-xs text-rc-text-secondary">
          🔁 Max retries (per stage)
          <input type="number" min={0} value={maxRetries} onChange={e => setMaxRetries(+e.target.value)} disabled={isReadOnly}
            className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
        </label>

        <label className="flex items-center space-x-2 text-xs text-rc-text-secondary cursor-pointer">
          <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} disabled={isReadOnly}
            className="rounded border-rc-border bg-rc-code" />
          <span>☑ Auto-approve retries</span>
        </label>

        {task.campaignId && (
          <>
            <div className="border-t border-rc-border pt-3 mt-3">
              <h3 className="text-xs font-bold text-rc-muted uppercase tracking-wider mb-2">Campaign Triggers</h3>
            </div>
            <label className="flex items-center space-x-2 text-xs text-rc-text-secondary cursor-pointer">
              <input type="checkbox" checked={triggersEnabled} onChange={e => setTriggersEnabled(e.target.checked)} disabled={isReadOnly}
                className="rounded border-rc-border bg-rc-code" />
              <span>Enable auto-triggers</span>
            </label>
            <label className="block text-xs text-rc-text-secondary">
              📉 Regression after
              <input type="number" min={1} value={regressionAfter} onChange={e => setRegressionAfter(+e.target.value)} disabled={isReadOnly || !triggersEnabled}
                className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
              <span className="text-[10px] text-rc-muted">consecutive drops</span>
            </label>
            <label className="block text-xs text-rc-text-secondary">
              📊 Plateau after
              <input type="number" min={1} value={plateauAfter} onChange={e => setPlateauAfter(+e.target.value)} disabled={isReadOnly || !triggersEnabled}
                className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
              <span className="text-[10px] text-rc-muted">entries within {plateauThreshold}%</span>
            </label>
            <label className="block text-xs text-rc-text-secondary">
              🔁 Repeated failure after
              <input type="number" min={1} value={repeatedFailureAfter} onChange={e => setRepeatedFailureAfter(+e.target.value)} disabled={isReadOnly || !triggersEnabled}
                className="w-full mt-1 px-2 py-1 bg-rc-code border border-rc-border rounded-input text-sm text-rc-text focus:outline-none focus:border-rc-accent disabled:opacity-50" />
              <span className="text-[10px] text-rc-muted">same gate failures</span>
            </label>
          </>
        )}

        <div className="flex space-x-2 pt-2">
          {!isReadOnly && (
            <button onClick={handleSave} className="btn-accent px-4 py-2 text-sm font-medium">Save</button>
          )}
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm border border-rc-border">
            {isReadOnly ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
