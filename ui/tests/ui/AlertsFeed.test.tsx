import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import AlertsFeed from "../../src/components/AlertsFeed";
import type { Task } from "../../src/types";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  name: "test-task",
  type: "code",
  workflow: "default",
  status: "running",
  stages: [],
  startedAt: new Date().toISOString(),
  elapsed_ms: 1000,
  tokens: 0,
  discussion: [],
  plan: [],
  currentIteration: 1,
  maxIterations: 3,
  autoApproveRetries: true,
  iterationLog: null,
  ...overrides,
});

describe("AlertsFeed", () => {
  it("renders alert messages with timestamps", () => {
    const task = makeTask({
      stages: [
        { id: "s1", role: "coder", status: "complete", retries: 0, dependsOn: [], startedAt: new Date().toISOString() },
      ],
    });
    const { container } = render(<AlertsFeed tasks={[task]} />);
    expect(container.textContent).toContain("test-task");
    expect(container.textContent).toContain("completed");
  });

  it("shows stall warnings for stages with no recent output", () => {
    const staleTime = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    const task = makeTask({
      stages: [
        { id: "s1", role: "coder", status: "running", retries: 0, dependsOn: [], startedAt: staleTime },
      ],
    });
    const { container } = render(<AlertsFeed tasks={[task]} />);
    expect(container.textContent).toContain("stalled");
  });

  it("empty alerts shows nothing", () => {
    const { container } = render(<AlertsFeed tasks={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
