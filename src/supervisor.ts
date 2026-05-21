import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Adapter, AgentConfig, RunResult } from './adapters/base.js';
import { readRunState, runDir as getRunDirPath } from './store.js';
import type { StoreState } from './store.js';
import type { SupervisorConfig } from './config.js';
import pino from 'pino';

const log = pino({ name: 'supervisor' });

export type SupervisorVerdict = 'WAIT' | 'GUIDE' | 'ABORT' | 'REPLAN' | 'DONE';

export interface SupervisorAssessment {
  verdict: SupervisorVerdict;
  targetStage: string | null;
  reason: string;
  guidance: string | null;
}

interface SupervisorAction {
  timestamp: string;
  tick: number;
  assessment: SupervisorAssessment;
  runningStages: string[];
}

function buildSupervisorSystemPrompt(stuckThresholdMs: number): string {
  const stuckMinutes = Math.max(1, Math.round(stuckThresholdMs / 60_000));
  return `You are a workflow supervisor monitoring agent progress toward a goal.
Analyze the running stages below and respond with exactly ONE JSON object.
Do NOT explain your reasoning — output ONLY the JSON.

Format: {"verdict":"WAIT|GUIDE|ABORT|REPLAN|DONE","target_stage":"<stage_id or null>","reason":"<1 sentence>","guidance":"<instruction if GUIDE, else null>"}

Verdicts:
- WAIT: Agents making progress. No intervention.
- GUIDE: Agent going wrong direction. Provide corrective instruction in "guidance".
- ABORT: Stage stuck/looping/wasting time. Kill it and let retry handle it.
- REPLAN: Fundamental approach is wrong. Needs a new plan entirely.
- DONE: The original goal is fully met based on evidence in the output.

Rules:
- Default to WAIT when agents are making progress toward the goal.
- GUIDE only when you see a concrete wrong direction (not just slow progress).
- DONE only when the ORIGINAL GOAL (stated at the top of this prompt) is fully satisfied — not when an intermediate stage passes its own tests. A stage's tests passing means that STAGE succeeded, not that the overall goal is met. Only signal DONE if you see evidence that ALL acceptance criteria from the original goal are achieved (e.g., final QA gate passes, target metric exceeded, all deliverables confirmed). For exploration/research tasks where the goal is to improve a metric, NEVER signal DONE just because code compiles or intermediate tests pass.
- ABORT only if a stage has been running for ${stuckMinutes}+ minutes with no new output (truly stuck). Note: codex agents often edit files silently via tool calls without printing to stdout; do NOT abort based on stdout silence alone if you can see file/artifact activity in the snapshot.
- Keep "reason" to one sentence. Keep "guidance" to 1-2 sentences max.`;
}

export class Supervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private byteOffsets = new Map<string, number>();
  private lastActionTime = 0;
  private assessmentCount = 0;
  private tickCount = 0;
  private actions: SupervisorAction[] = [];
  private stopped = false;
  private startTime = Date.now();
  private decisions: string[] = [];
  private deliverables: string[] = [];
  private observations: string[] = [];
  private knownStages = new Set<string>();
  private completedStages = new Map<string, { role: string; duration: number }>();
  private lastState: StoreState | null = null;

  constructor(
    private projectDir: string,
    private runId: string,
    private adapter: Adapter,
    private config: SupervisorConfig,
    private taskDescription: string,
  ) {}

  // Adaptive polling: the effective interval grows on consecutive WAITs and
  // resets to base when something interesting happens (non-WAIT verdict, stage
  // state change, or a new artifact). Cap prevents a quiet run from polling
  // less often than every 5 minutes.
  private effectivePollIntervalMs: number = 0;
  private static readonly MAX_EFFECTIVE_POLL_MS = 300_000;  // 5 min cap
  private static readonly BACKOFF_TRIGGER_WAITS = 3;        // start doubling after N WAITs
  private consecutiveWaits = 0;
  private prevStageStatusSnapshot: Record<string, string> = {};
  // Per-iteration assessment budget refills when state.currentIteration advances.
  private lastSeenIteration = 0;
  private iterationAssessmentCount = 0;

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.effectivePollIntervalMs = this.config.pollIntervalMs;
    const logPath = this.logPath();
    mkdirSync(join(this.runDir(), 'signals'), { recursive: true });
    appendFileSync(logPath, `# Supervisor Log\n\nGoal: ${this.taskDescription.slice(0, 200)}\nStarted: ${new Date().toISOString()}\nConfig: poll=${this.config.pollIntervalMs}ms (adaptive, max ${Supervisor.MAX_EFFECTIVE_POLL_MS}ms), model=${this.config.model}, max/iter=${this.config.maxAssessmentsPerIteration}\n\n`);
    log.info({ runId: this.runId }, 'Supervisor started');
    this.scheduleNextTick();
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch(err => log.error(err, 'Supervisor tick error'))
        .finally(() => this.scheduleNextTick());
    }, this.effectivePollIntervalMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Re-read final state for accurate progress report
    try {
      const finalState = readRunState(this.projectDir, this.runId);
      this.trackMilestones(finalState);
    } catch { /* ignore */ }
    appendFileSync(this.logPath(), `\n---\nSupervisor stopped: ${new Date().toISOString()}, ${this.assessmentCount} assessments made.\n`);
    this.writeProgress();
    log.info({ runId: this.runId, assessments: this.assessmentCount }, 'Supervisor stopped');
  }

  private writeProgress(): void {
    const state = this.lastState;
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const status = state?.status ?? 'unknown';
    const iteration = state?.currentIteration ?? 1;
    const maxIter = state?.maxIterations ?? '?';
    const retries = this.actions.filter(a => a.assessment.verdict !== 'WAIT').length;

    // No Goal section — page header / tab title already show the task name,
    // and the full brief is one click away. Repeating 300 chars of Goal here
    // pushes the actually-actionable Outcome below the fold.
    const lines: string[] = [
      `# Run: ${this.runId}`,
      '',
    ];

    // Outcome first — single most actionable line. Read this and you know
    // whether you need to do anything.
    lines.push('## Outcome');
    lines.push(`${status === 'complete' ? 'Complete' : status === 'failed' ? 'Failed' : 'In progress'} (${elapsed}s, iteration ${iteration}/${maxIter}, ${retries} interventions)`);
    lines.push('');

    if (this.decisions.length > 0) {
      lines.push('## What was decided');
      for (const d of this.decisions) lines.push(`- ${d}`);
      lines.push('');
    }

    // Deliverables: don't dump every artifact path (a single run with images +
    // keyframes can produce 100+ paths and turn this section into a wall of
    // text). Show artifact count per stage, surface the final_package path if
    // one is present, and cap individual entries to a readable preview.
    if (this.deliverables.length > 0) {
      lines.push('## What was delivered');
      let finalPackagePath: string | null = null;
      for (const d of this.deliverables) {
        const colon = d.indexOf(':');
        const stageId = colon > 0 ? d.slice(0, colon).trim() : d;
        const rest = colon > 0 ? d.slice(colon + 1).trim() : '';
        const items = rest ? rest.split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!finalPackagePath) {
          const fp = items.find(p => /\/final_package(?:\/|$)/.test(p));
          if (fp) finalPackagePath = fp.split('/final_package')[0] + '/final_package';
        }
        if (items.length === 0) {
          lines.push(`- ${stageId}: (no artifacts)`);
        } else if (items.length === 1) {
          lines.push(`- ${stageId}: ${items[0]}`);
        } else {
          lines.push(`- ${stageId}: ${items.length} artifacts (e.g. ${items[0]})`);
        }
      }
      if (finalPackagePath) {
        lines.push(`- final_package: ${finalPackagePath}`);
      }
      lines.push('');
    }

    // Observations: only keep the recent non-WAIT verdicts and user-guidance
    // events. Per-tick WAIT reasons ("stage still making progress") are noise
    // here — they're already visible in the SupervisorPane action list. The
    // tag convention in act(): WAIT pushes a bare reason, non-WAIT pushes
    // "VERDICT: reason"; user input pushes "User guidance received: ...".
    if (this.observations.length > 0) {
      const noteworthy = this.observations.filter(o =>
        /^(GUIDE|ABORT|REPLAN|DONE):/.test(o) || o.startsWith('User guidance received:'),
      );
      const recent = noteworthy.slice(-5);
      if (recent.length > 0) {
        lines.push('## Notable supervisor events');
        for (const o of recent) lines.push(`- ${o}`);
        lines.push('');
      }
    }

    writeFileSync(this.progressPath(), lines.join('\n'), 'utf-8');
    this.writeSupervisorState();
  }

  private progressPath(): string {
    return join(this.runDir(), 'progress.md');
  }

  /**
   * Structured state for the dashboard UI to render the supervisor activity pane.
   * Refreshed on every assessment, on idle ticks, and at stop. Keeps last 30 actions.
   */
  private writeSupervisorState(): void {
    const path = join(this.runDir(), 'supervisor_state.json');
    const payload = {
      runId: this.runId,
      startedAt: new Date(this.startTime).toISOString(),
      stoppedAt: this.stopped ? new Date().toISOString() : null,
      assessmentCount: this.assessmentCount,
      iterationAssessmentCount: this.iterationAssessmentCount,
      maxAssessmentsPerIteration: this.config.maxAssessmentsPerIteration,
      currentIteration: this.lastSeenIteration,
      basePollIntervalMs: this.config.pollIntervalMs,
      effectivePollIntervalMs: this.effectivePollIntervalMs,
      consecutiveWaits: this.consecutiveWaits,
      tickCount: this.tickCount,
      actions: this.actions.slice(-30).map(a => ({
        tick: a.tick,
        timestamp: a.timestamp,
        runningStages: a.runningStages,
        verdict: a.assessment.verdict,
        targetStage: a.assessment.targetStage,
        reason: a.assessment.reason,
        guidance: a.assessment.guidance,
      })),
    };
    try { writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8'); } catch { /* non-critical */ }
  }

  private readUserInput(): string | null {
    const inputPath = join(this.runDir(), 'user_input.md');
    if (!existsSync(inputPath)) return null;
    try {
      const content = readFileSync(inputPath, 'utf-8').trim();
      unlinkSync(inputPath); // consume it
      if (content) return content;
    } catch { /* ignore */ }
    return null;
  }

  private trackMilestones(state: StoreState): void {
    this.lastState = state;

    // Detect new stages starting
    for (const [id, ss] of Object.entries(state.stages)) {
      if (ss.status === 'running' && !this.knownStages.has(id)) {
        this.knownStages.add(id);
      }
      // Detect stage completions
      if ((ss.status === 'complete' || ss.status === 'failed') && !this.completedStages.has(id)) {
        const duration = ss.duration_ms ? Math.round(ss.duration_ms / 1000) : 0;
        this.completedStages.set(id, { role: '', duration });

        if (ss.status === 'complete') {
          // Check for deliverables (artifacts)
          if (ss.artifacts && ss.artifacts.length > 0) {
            this.deliverables.push(`${id}: ${ss.artifacts.join(', ')}`);
          }
        }
      }
    }

    // Detect dispatch decisions
    if (state.dispatchedStages && Array.isArray(state.dispatchedStages)) {
      const dispatched = state.dispatchedStages as unknown[];
      const dispatchCount = dispatched.length;
      const stageNames = dispatched.map((s) => (s && typeof s === 'object' && 'id' in s ? (s as { id: string }).id : 'unknown')).join(', ');
      const decision = `Planner dispatched ${dispatchCount} stages: ${stageNames}`;
      if (!this.decisions.includes(decision)) {
        this.decisions.push(decision);
      }
    }
  }

  private runDir(): string {
    return getRunDirPath(this.projectDir, this.runId);
  }

  private logPath(): string {
    return join(this.runDir(), 'supervisor_log.md');
  }

  private signalDir(): string {
    return join(this.runDir(), 'signals');
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount++;

    // Read current state
    let state: StoreState;
    try {
      state = readRunState(this.projectDir, this.runId);
    } catch { /* non-critical */
      return; // run not ready yet
    }

    // Track milestones and update progress
    this.trackMilestones(state);

    // Refill per-iteration budget when the campaign iteration advances.
    const currentIter = state.currentIteration ?? 1;
    if (currentIter !== this.lastSeenIteration) {
      if (this.lastSeenIteration !== 0) {
        log.info({ from: this.lastSeenIteration, to: currentIter, perIterUsed: this.iterationAssessmentCount }, 'Supervisor per-iteration budget refilled');
      }
      this.lastSeenIteration = currentIter;
      this.iterationAssessmentCount = 0;
      // Also reset adaptive backoff on iteration transition — fresh iteration
      // is "something happened" by definition.
      if (this.effectivePollIntervalMs !== this.config.pollIntervalMs) {
        this.effectivePollIntervalMs = this.config.pollIntervalMs;
        this.consecutiveWaits = 0;
      }
    }

    // Stop if run is no longer active
    if (state.status === 'complete' || state.status === 'failed') {
      this.stop();
      return;
    }

    // Check for user input
    const userInput = this.readUserInput();
    if (userInput) {
      this.observations.push(`User guidance received: "${userInput.slice(0, 100)}"`);
      // Write as run-level guidance for next stage
      const runGuidancePath = join(this.runDir(), 'supervisor_guidance.md');
      const existing = existsSync(runGuidancePath) ? readFileSync(runGuidancePath, 'utf-8') : '';
      writeFileSync(runGuidancePath, existing + `\n\n[user]: ${userInput}`, 'utf-8');
      log.info({ runId: this.runId }, 'User input received and applied as guidance');
      this.writeProgress();
    }

    // Find running stages
    const runningStages = Object.entries(state.stages)
      .filter(([, s]) => s.status === 'running')
      .map(([id]) => id);

    if (runningStages.length === 0) {
      this.writeProgress(); // update progress even when idle
      return;
    }

    // Read live.log tails
    const tails = this.readStageTails(runningStages);
    const totalDelta = [...tails.values()].reduce((sum, t) => sum + t.length, 0);

    // Detect adaptive-reset events: stage state change OR new artifact since last tick.
    // Either resets backoff so the supervisor "wakes up" when something happens.
    const currentSnapshot: Record<string, string> = {};
    for (const [id, s] of Object.entries(state.stages)) currentSnapshot[id] = s.status;
    const stageTransition = Object.entries(currentSnapshot).some(
      ([id, st]) => this.prevStageStatusSnapshot[id] !== undefined && this.prevStageStatusSnapshot[id] !== st,
    ) || Object.entries(this.prevStageStatusSnapshot).some(
      ([id]) => currentSnapshot[id] === undefined,
    );
    this.prevStageStatusSnapshot = currentSnapshot;

    if (stageTransition && this.effectivePollIntervalMs !== this.config.pollIntervalMs) {
      log.info({ from: this.effectivePollIntervalMs, to: this.config.pollIntervalMs }, 'Supervisor adaptive reset: stage transition');
      this.effectivePollIntervalMs = this.config.pollIntervalMs;
      this.consecutiveWaits = 0;
    }

    // Skip if not enough new output (artifact scan still gates via separate path below)
    if (totalDelta < this.config.minDeltaBytes && !stageTransition) return;

    // Check cooldown
    if (Date.now() - this.lastActionTime < this.config.cooldownAfterActionMs) return;

    // Per-iteration budget. Refills automatically on iteration transition.
    if (this.iterationAssessmentCount >= this.config.maxAssessmentsPerIteration) return;

    // Include user input in assessment if just received
    let extraContext = '';
    if (userInput) {
      extraContext = `\n\n# User Guidance (just received)\n${userInput}\nIncorporate this into your assessment.`;
    }

    // Build prompt and assess
    const recentArtifacts = this.readRecentArtifacts();
    const newArtifacts = recentArtifacts.length > 0;
    if (newArtifacts && this.effectivePollIntervalMs !== this.config.pollIntervalMs) {
      log.info({ from: this.effectivePollIntervalMs, to: this.config.pollIntervalMs }, 'Supervisor adaptive reset: new artifact');
      this.effectivePollIntervalMs = this.config.pollIntervalMs;
      this.consecutiveWaits = 0;
    }
    const prompt = this.buildAssessmentPrompt(tails, state, runningStages, recentArtifacts) + extraContext;
    const assessment = await this.assess(prompt);
    if (!assessment) return;

    this.assessmentCount++;
    this.iterationAssessmentCount++;

    // Adaptive backoff: count consecutive WAITs; after N, double the effective
    // poll interval up to a 5-min ceiling. Any non-WAIT verdict resets it.
    if (assessment.verdict === 'WAIT') {
      this.consecutiveWaits++;
      if (this.consecutiveWaits >= Supervisor.BACKOFF_TRIGGER_WAITS) {
        const next = Math.min(this.effectivePollIntervalMs * 2, Supervisor.MAX_EFFECTIVE_POLL_MS);
        if (next !== this.effectivePollIntervalMs) {
          log.info({ from: this.effectivePollIntervalMs, to: next, consecutiveWaits: this.consecutiveWaits }, 'Supervisor adaptive backoff');
          this.effectivePollIntervalMs = next;
        }
      }
    } else {
      this.consecutiveWaits = 0;
      if (this.effectivePollIntervalMs !== this.config.pollIntervalMs) {
        log.info({ from: this.effectivePollIntervalMs, to: this.config.pollIntervalMs }, 'Supervisor adaptive reset: non-WAIT verdict');
        this.effectivePollIntervalMs = this.config.pollIntervalMs;
      }
    }

    // Record action
    const action: SupervisorAction = {
      timestamp: new Date().toISOString(),
      tick: this.tickCount,
      assessment,
      runningStages,
    };
    this.actions.push(action);

    // Act on verdict
    await this.act(assessment);

    // Log
    this.appendLog(action);

    // Record observation
    if (assessment.verdict === 'WAIT') {
      this.observations.push(assessment.reason);
    } else {
      this.observations.push(`${assessment.verdict}: ${assessment.reason}`);
      if (assessment.verdict === 'GUIDE' && assessment.guidance) {
        this.decisions.push(`Guided ${assessment.targetStage}: ${assessment.guidance.slice(0, 100)}`);
      } else if (assessment.verdict === 'REPLAN') {
        this.decisions.push(`Triggered replan: ${assessment.reason}`);
      } else if (assessment.verdict === 'DONE') {
        this.decisions.push(`Goal confirmed met: ${assessment.reason}`);
      }
      log.info({ tick: this.tickCount, verdict: assessment.verdict, target: assessment.targetStage, reason: assessment.reason }, 'Supervisor action');
    }

    // Update progress file
    this.writeProgress();
  }

  private readStageTails(stageIds: string[]): Map<string, string> {
    const tails = new Map<string, string>();
    for (const stageId of stageIds) {
      const logPath = join(this.runDir(), 'stages', stageId, 'live.log');
      if (!existsSync(logPath)) continue;

      try {
        const stat = statSync(logPath);
        const prevOffset = this.byteOffsets.get(stageId) ?? Math.max(0, stat.size - this.config.tailBytes);
        const bytesToRead = Math.min(this.config.tailBytes, stat.size - prevOffset);
        if (bytesToRead <= 0) continue;

        const fd = openSync(logPath, 'r');
        const buf = Buffer.alloc(bytesToRead);
        readSync(fd, buf, 0, bytesToRead, prevOffset);
        closeSync(fd);

        this.byteOffsets.set(stageId, stat.size);
        tails.set(stageId, buf.toString('utf-8'));
      } catch { /* file access error, skip */ }
    }
    return tails;
  }

  private buildAssessmentPrompt(
    tails: Map<string, string>,
    state: StoreState,
    runningStages: string[],
    recentArtifacts: Array<{ path: string; content: string }>,
  ): string {
    const parts: string[] = [];

    // Goal: include the FULL task brief so every success criterion, banned string,
    // and acceptance test is visible to the supervisor (no truncation).
    parts.push(`# Goal\n${this.taskDescription}`);
    parts.push(`\n# Iteration ${state.currentIteration ?? 1}/${state.maxIterations ?? 5}`);

    // Running stages with output (8 KB per stage so silent fallbacks are visible in stdout)
    parts.push('\n# Running Stages');
    for (const stageId of runningStages) {
      const ss = state.stages[stageId];
      const elapsed = ss?.startedAt ? Math.round((Date.now() - new Date(ss.startedAt).getTime()) / 1000) : 0;
      const tail = tails.get(stageId) ?? '(no output yet)';
      parts.push(`\n## ${stageId} — ${elapsed}s elapsed\n\`\`\`\n${tail.slice(-8000)}\n\`\`\``);
    }

    // Recent JSON artifacts: capability reports, gate verdicts, metric files modified
    // since the previous tick. Catches silent fallbacks (e.g. "selected_provider falls back")
    // that show up in JSON files but not in live.log stdout.
    if (recentArtifacts.length > 0) {
      parts.push('\n# Recent Artifacts (modified since last tick)');
      parts.push('These JSON files were written by stages and may signal silent fallbacks, blockers, or completion. Read them carefully — gates lying with `pass:true` while `value<threshold` is a known failure mode.');
      for (const { path, content } of recentArtifacts) {
        parts.push(`\n## ${path}\n\`\`\`json\n${content}\n\`\`\``);
      }
    }

    // Completed stages summary
    const completed = Object.entries(state.stages)
      .filter(([, s]) => s.status === 'complete' || s.status === 'failed')
      .map(([id, s]) => `- ${id}: ${s.status}${s.error ? ` (${s.error})` : ''}`);
    if (completed.length > 0) {
      parts.push(`\n# Completed Stages\n${completed.join('\n')}`);
    }

    // Previous supervisor actions (last 3)
    if (this.actions.length > 0) {
      const recent = this.actions.slice(-3).map(a =>
        `- Tick ${a.tick}: ${a.assessment.verdict}${a.assessment.targetStage ? ` → ${a.assessment.targetStage}` : ''} — ${a.assessment.reason}`
      );
      parts.push(`\n# Previous Supervisor Actions\n${recent.join('\n')}`);
    }

    return parts.join('\n');
  }

  /**
   * Scan the run dir for JSON artifacts that were modified since the last assessment.
   * Caps results so the assessment prompt stays bounded.
   */
  private lastArtifactScanAt: number = 0;
  private readRecentArtifacts(): Array<{ path: string; content: string }> {
    const runDirAbs = this.runDir();
    const since = this.lastArtifactScanAt;
    const now = Date.now();
    this.lastArtifactScanAt = now;
    // First tick: look back one poll interval so the first assessment isn't empty.
    const cutoff = since > 0 ? since : now - Math.max(this.config.pollIntervalMs * 2, 30_000);

    const interesting = (name: string) =>
      /capability_report\.json$/.test(name) ||
      /^verdict[_.].*\.json$/.test(name) ||
      /^metric\.json$/.test(name) ||
      /capability_blocker\.json$/.test(name);

    const walk = (dir: string, depth: number, acc: Array<{ path: string; mtime: number }>) => {
      if (depth > 4) return;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[]; } catch { return; }
      for (const e of entries) {
        if (e.name === 'codex_home' || e.name === 'node_modules' || e.name === '.tmp') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1, acc);
        } else if (e.isFile() && interesting(e.name)) {
          try {
            const st = statSync(p);
            if (st.mtimeMs >= cutoff) acc.push({ path: p, mtime: st.mtimeMs });
          } catch { /* skip */ }
        }
      }
    };

    const found: Array<{ path: string; mtime: number }> = [];
    walk(runDirAbs, 0, found);

    // Most recent first, cap at 5 files, 4 KB each to keep prompt bounded.
    found.sort((a, b) => b.mtime - a.mtime);
    const top = found.slice(0, 5);
    return top.map(({ path }) => {
      let content: string;
      try {
        const raw = readFileSync(path, 'utf-8');
        content = raw.length > 4000 ? raw.slice(0, 4000) + '\n... [truncated]' : raw;
      } catch { content = '[unreadable]'; }
      return { path: relative(runDirAbs, path), content };
    });
  }

  private async assess(prompt: string): Promise<SupervisorAssessment | null> {
    const agentConfig: AgentConfig = {
      name: 'supervisor',
      description: 'Workflow supervisor',
      model: this.config.model,
      reasoning_effort: this.config.reasoningEffort,
      tools: [],
      prompt: buildSupervisorSystemPrompt(this.config.stuckThresholdMs),
    };

    let result: RunResult;
    try {
      result = await this.adapter.run(prompt, agentConfig, {
        timeout_ms: 30000,
        workDir: this.projectDir,
        runDir: this.runDir(),
        stageId: '_supervisor',
      });
    } catch (err) {
      log.warn({ err }, 'Supervisor assessment call failed');
      return null;
    }

    if (result.exitCode !== 0) {
      log.warn({ exitCode: result.exitCode }, 'Supervisor assessment returned non-zero');
      return null;
    }

    // Parse JSON from output. Codex echoes the prompt before its response, so
    // `output` typically contains: [prompt with possibly a JSON template that
    // also has "verdict"] then [the real response]. Single-match regex picked
    // the prompt-echoed template (with placeholders like <number>) and failed
    // to JSON.parse — silently killing the supervisor for the entire run.
    //
    // Fix: collect ALL `{...verdict...}` matches, scan LAST-TO-FIRST (real
    // response is at the end of output, templates appear earlier in the
    // prompt), and accept the first one that both parses as JSON and carries a
    // legal verdict string. If none parse, log a tail preview for debugging.
    const matches = [...result.output.matchAll(/\{[^}]*"verdict"[^}]*\}/g)];
    if (matches.length === 0) {
      log.warn({ outputPreview: result.output.slice(-500) }, 'No JSON with "verdict" found in supervisor response');
      return null;
    }
    const validVerdicts = ['WAIT', 'GUIDE', 'ABORT', 'REPLAN', 'DONE'];
    for (let i = matches.length - 1; i >= 0; i--) {
      const candidate = matches[i][0];
      try {
        const parsed = JSON.parse(candidate);
        const verdict = parsed.verdict as string;
        if (!validVerdicts.includes(verdict)) continue;
        return {
          verdict: verdict as SupervisorVerdict,
          targetStage: parsed.target_stage ?? null,
          reason: parsed.reason ?? '',
          guidance: parsed.guidance ?? null,
        };
      } catch { /* try the next earlier match */ }
    }
    log.warn({ matchCount: matches.length, outputPreview: result.output.slice(-500) }, 'All supervisor JSON candidates failed to parse');
    return null;
  }

  private async act(assessment: SupervisorAssessment): Promise<void> {
    const signalDir = this.signalDir();

    switch (assessment.verdict) {
      case 'WAIT':
        break;

      case 'GUIDE':
        if (assessment.targetStage && assessment.guidance) {
          const guidancePath = join(this.runDir(), 'stages', assessment.targetStage, 'guidance.md');
          mkdirSync(join(this.runDir(), 'stages', assessment.targetStage), { recursive: true });
          writeFileSync(guidancePath, assessment.guidance, 'utf-8');
          // Also write run-level guidance for subsequent stages
          const runGuidancePath = join(this.runDir(), 'supervisor_guidance.md');
          const existing = existsSync(runGuidancePath) ? readFileSync(runGuidancePath, 'utf-8') : '';
          writeFileSync(runGuidancePath, existing + `\n\n[${assessment.targetStage}]: ${assessment.guidance}`, 'utf-8');
        }
        this.lastActionTime = Date.now();
        break;

      case 'ABORT':
        if (assessment.targetStage) {
          writeFileSync(join(signalDir, `abort_${assessment.targetStage}.json`),
            JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        }
        this.lastActionTime = Date.now();
        break;

      case 'REPLAN':
        writeFileSync(join(signalDir, 'replan.json'),
          JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        this.lastActionTime = Date.now();
        break;

      case 'DONE':
        writeFileSync(join(signalDir, 'goal_met.json'),
          JSON.stringify({ reason: assessment.reason, timestamp: new Date().toISOString() }), 'utf-8');
        this.lastActionTime = Date.now();
        break;
    }
  }

  private appendLog(action: SupervisorAction): void {
    const entry = [
      `## Tick ${action.tick} — ${action.timestamp}`,
      `Running: ${action.runningStages.join(', ')}`,
      `Verdict: **${action.assessment.verdict}**${action.assessment.targetStage ? ` → ${action.assessment.targetStage}` : ''}`,
      `Reason: ${action.assessment.reason}`,
    ];
    if (action.assessment.guidance) {
      entry.push(`Guidance: ${action.assessment.guidance}`);
    }
    entry.push('');
    appendFileSync(this.logPath(), entry.join('\n') + '\n');
  }
}
