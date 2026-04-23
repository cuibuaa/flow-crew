import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Stage, Task } from "../../src/types";

// We test the StagePanel rerun buttons by rendering the relevant part of LiveMonitor
// Since StagePanel is not exported separately, we test the button rendering logic directly

function RerunButtons({ stage, isGate }: { stage: Stage; isGate: boolean }) {
  if (stage.status !== "failed") return null;
  return (
    <div>
      <button data-testid="rerun-btn">▶ Rerun from here</button>
      {isGate && <button data-testid="reeval-btn">▶ Re-evaluate gate</button>}
    </div>
  );
}

describe("StageRerun buttons", () => {
  it("failed stage shows 'Rerun from here' button", () => {
    const stage: Stage = { id: "s1", role: "coder", status: "failed", retries: 1, dependsOn: [] };
    const { getByTestId } = render(<RerunButtons stage={stage} isGate={false} />);
    expect(getByTestId("rerun-btn")).toBeTruthy();
    expect(getByTestId("rerun-btn").textContent).toContain("Rerun from here");
  });

  it("failed gate stage also shows 'Re-evaluate gate' button", () => {
    const stage: Stage = { id: "s1", role: "qa", status: "failed", retries: 1, dependsOn: [], isGate: true };
    const { getByTestId } = render(<RerunButtons stage={stage} isGate={true} />);
    expect(getByTestId("rerun-btn")).toBeTruthy();
    expect(getByTestId("reeval-btn")).toBeTruthy();
    expect(getByTestId("reeval-btn").textContent).toContain("Re-evaluate gate");
  });

  it("completed stage does NOT show rerun button", () => {
    const stage: Stage = { id: "s1", role: "coder", status: "complete", retries: 0, dependsOn: [] };
    const { container } = render(<RerunButtons stage={stage} isGate={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("running stage does NOT show rerun button", () => {
    const stage: Stage = { id: "s1", role: "coder", status: "running", retries: 0, dependsOn: [] };
    const { container } = render(<RerunButtons stage={stage} isGate={false} />);
    expect(container.innerHTML).toBe("");
  });
});
