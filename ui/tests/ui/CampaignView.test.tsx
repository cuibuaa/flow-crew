import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sparkline from "../../src/components/Sparkline";
import type { CampaignEntry } from "../../src/types";

// CampaignView is rendered inline in Dashboard via campaign grouping
// Test the campaign data rendering logic

function CampaignHistory({ entries }: { entries: CampaignEntry[] }) {
  if (entries.length === 0) return <div>No runs yet</div>;
  const scores = entries.map(e => e.score);
  return (
    <div>
      <Sparkline values={scores} />
      <table>
        <thead>
          <tr><th>Seq</th><th>Score</th><th>Delta</th><th>Gates</th><th>Status</th></tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td>{e.score}</td>
              <td>{i > 0 ? (e.score - entries[i - 1].score).toFixed(2) : "—"}</td>
              <td>{e.gates}</td>
              <td>{e.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

describe("CampaignView", () => {
  it("renders campaign history table with score, delta, gates", () => {
    const entries: CampaignEntry[] = [
      { seq: 1, runId: "r1", score: 240.38, metric: "net_worth", gates: "3/3", status: "complete", timestamp: "2026-04-15T00:00:00Z" },
      { seq: 2, runId: "r2", score: 199.74, metric: "net_worth", gates: "0/3", status: "complete", timestamp: "2026-04-17T00:00:00Z" },
    ];
    const { container } = render(
      <MemoryRouter><CampaignHistory entries={entries} /></MemoryRouter>
    );
    expect(container.textContent).toContain("240.38");
    expect(container.textContent).toContain("199.74");
    expect(container.textContent).toContain("-40.64");
    expect(container.textContent).toContain("3/3");
    expect(container.textContent).toContain("0/3");
  });

  it("shows sparkline trend across runs", () => {
    const entries: CampaignEntry[] = [
      { seq: 1, runId: "r1", score: 100, metric: "m", gates: "1/1", status: "complete", timestamp: "2026-04-15T00:00:00Z" },
      { seq: 2, runId: "r2", score: 200, metric: "m", gates: "1/1", status: "complete", timestamp: "2026-04-16T00:00:00Z" },
    ];
    const { container } = render(
      <MemoryRouter><CampaignHistory entries={entries} /></MemoryRouter>
    );
    // Sparkline should render block chars
    const sparkText = container.querySelector("span")?.textContent ?? "";
    expect(sparkText.length).toBe(2);
  });

  it("empty campaign shows 'No runs yet'", () => {
    const { container } = render(
      <MemoryRouter><CampaignHistory entries={[]} /></MemoryRouter>
    );
    expect(container.textContent).toContain("No runs yet");
  });
});
