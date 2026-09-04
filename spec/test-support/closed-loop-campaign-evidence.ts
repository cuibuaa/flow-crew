import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CampaignCriterionEvidence,
  CampaignDeclinedItem,
  CampaignMetricSeries,
  CampaignSuccessorGuidance,
  CampaignSuccessorInput,
  CampaignTerminalEvidence,
} from '../../src/campaign-successor.js';

interface RecordedAnchor {
  label: string;
  sourcePath: string;
  byteStart: number;
  byteEndExclusive: number;
  sha256: string;
  utf8: string;
}

interface RecordedCampaignFixture {
  version: 1;
  kind: 'closed_loop_campaign_evidence';
  evidenceRunId: string;
  predecessorTaskId: number;
  oracleTaskId: number;
  predecessorBrief: string;
  preflightAddendum?: string;
  frozenContract: Record<string, unknown>;
  terminal: CampaignTerminalEvidence;
  operatorGuidance: CampaignSuccessorGuidance[];
  criterion: CampaignCriterionEvidence;
  metricSeries: CampaignMetricSeries;
  declinedItems: CampaignDeclinedItem[];
  expectation: {
    floor: { metricId: string; operator: '>='; value: number; unit: string };
    latestObservedDoseMinutes: number;
    promotedGuidanceIds: string[];
    convertedCriterionId: string;
    within_expected_range: false;
    method_was_not_adjusted_to_match_expectation: true;
  };
  oracle: {
    comparisonOnly: true;
    yardstickDigest: string;
    containsHardDoseFloor: true;
    hardFloorAnchor: string;
    convertedCriterionAnchor: string;
  };
  anchors: RecordedAnchor[];
}

export interface LoadedClosedLoopCampaignEvidence {
  evidenceRunId: string;
  predecessorTaskId: number;
  derivationInput: CampaignSuccessorInput;
  expectation: RecordedCampaignFixture['expectation'];
  oracle: RecordedCampaignFixture['oracle'];
  anchors: RecordedAnchor[];
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixturePath(): string {
  return join(import.meta.dirname, '..', 'fixtures', 'closed-loop-campaign-evidence.json');
}

/**
 * Load only the repository-owned immutable replay fixture. External run/task/project
 * paths are provenance strings, never opened by this research test.
 */
export function loadClosedLoopCampaignEvidence(): LoadedClosedLoopCampaignEvidence {
  const fixture = JSON.parse(readFileSync(fixturePath(), 'utf-8')) as RecordedCampaignFixture;
  if (fixture.version !== 1 || fixture.kind !== 'closed_loop_campaign_evidence') {
    throw new Error('unsupported closed-loop campaign fixture');
  }
  for (const anchor of fixture.anchors) {
    const bytes = Buffer.byteLength(anchor.utf8, 'utf8');
    if (anchor.byteEndExclusive - anchor.byteStart !== bytes) {
      throw new Error(`fixture anchor ${anchor.label} has an invalid byte interval`);
    }
    if (digest(anchor.utf8) !== anchor.sha256) {
      throw new Error(`fixture anchor ${anchor.label} has an invalid sha256`);
    }
  }
  const goal = fixture.frozenContract.goal;
  const goalDigest = fixture.frozenContract.goalDigest;
  if (typeof goalDigest !== 'string' || digest(JSON.stringify(goal)) !== goalDigest) {
    throw new Error('recorded semantic goal digest does not match its frozen bytes');
  }
  const guidanceIds = fixture.operatorGuidance.map((entry) => entry.id);
  if (new Set(guidanceIds).size !== guidanceIds.length) {
    throw new Error('recorded operator guidance ids are not unique');
  }
  const anchorsByLabel = new Map(fixture.anchors.map((anchor) => [anchor.label, anchor]));
  for (const guidance of fixture.operatorGuidance) {
    const directAnchor = guidance.sourceAnchor ? anchorsByLabel.get(guidance.sourceAnchor) : undefined;
    const anchor = directAnchor?.utf8.includes('<!-- flowcrew-guidance ')
      ? directAnchor
      : fixture.anchors.find((candidate) => candidate.utf8.includes(`\"id\":\"${guidance.id}\"`));
    const metadataText = anchor && /<!-- flowcrew-guidance (\{[^\n]+\}) -->/.exec(anchor.utf8)?.[1];
    if (!metadataText) throw new Error(`guidance ${guidance.id} has no byte-anchored envelope`);
    const metadata = JSON.parse(metadataText) as {
      id?: unknown;
      target?: unknown;
      source?: unknown;
      createdAt?: unknown;
      bodyLength?: unknown;
    };
    const body = guidance.body ?? guidance.text ?? '';
    const reconstructedId = guidance.createdAt
      ? digest(JSON.stringify([guidance.target, guidance.source, guidance.createdAt, body])).slice(0, 20)
      : '';
    if (metadata.id !== guidance.id
      || metadata.target !== guidance.target
      || metadata.source !== guidance.source
      || metadata.createdAt !== guidance.createdAt
      || metadata.bodyLength !== body.length
      || reconstructedId !== guidance.id) {
      throw new Error(`guidance ${guidance.id} does not match its byte-anchored envelope`);
    }
  }

  const predecessorBrief = `${fixture.predecessorBrief}${fixture.preflightAddendum ?? ''}`;
  return {
    evidenceRunId: fixture.evidenceRunId,
    predecessorTaskId: fixture.predecessorTaskId,
    derivationInput: {
      campaignContract: fixture.frozenContract,
      predecessorBrief,
      terminal: fixture.terminal,
      operatorGuidance: fixture.operatorGuidance,
      declinedItems: fixture.declinedItems,
      criterion: fixture.criterion,
      metricSeries: fixture.metricSeries,
    },
    expectation: fixture.expectation,
    // The oracle is deliberately returned beside, never inside, derivationInput.
    oracle: fixture.oracle,
    anchors: fixture.anchors,
  };
}
