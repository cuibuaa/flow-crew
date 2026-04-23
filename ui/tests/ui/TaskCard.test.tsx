import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TaskCard from "../../src/components/TaskCard";
import type { Task } from "../../src/types";

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  name: "test-task",
  type: "research",
  workflow: "default",
  status: "running",
  stages: [
    { id: "plan", role: "planner", status: "complete", retries: 0, dependsOn: [] },
    { id: "impl", role: "coder", status: "running", retries: 0, dependsOn: ["plan"] },
    { id: "qa", role: "qa", status: "pending", retries: 0, dependsOn: ["impl"], isGate: true },
  ],
  startedAt: new Date().toISOString(),
  elapsed_ms: 120000,
  tokens: 500,
  bestScore: 199.74,
  discussion: [],
  plan: [],
  currentIteration: 1,
  maxIterations: 3,
  autoApproveRetries: true,
  iterationLog: null,
  ...overrides,
});

function renderCard(task: Task) {
  return render(
    <MemoryRouter>
      <TaskCard task={task} />
    </MemoryRouter>
  );
}

describe("TaskCard", () => {
  it("renders task name, type, progress, and score", () => {
    const { container } = renderCard(makeTask());
    const text = container.textContent!;
    expect(text).toContain("test-task");
    expect(text).toContain("research");
    expect(text).toContain("33%"); // 1 of 3 complete
    expect(text).toContain("199.74");
  });

  it("shows mini stage pipeline with correct status icons", () => {
    const { getByTestId } = renderCard(makeTask());
    const pipeline = getByTestId("mini-pipeline");
    const text = pipeline.textContent!;
    expect(text).toContain("plan ✅");
    expect(text).toContain("impl 🔄");
    expect(text).toContain("qa ⏳");
  });

  it("double-click name enables edit mode", () => {
    const { getByTestId } = renderCard(makeTask());
    const name = getByTestId("task-name");
    fireEvent.doubleClick(name);
    const input = getByTestId("rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("test-task");
  });
});
