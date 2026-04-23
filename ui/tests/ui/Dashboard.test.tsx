import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../../src/components/Dashboard";
import type { Task } from "../../src/types";

// Mock api
vi.mock("../../src/api", () => ({
  renameTask: vi.fn(() => Promise.resolve({ ok: true })),
  deleteTask: vi.fn(() => Promise.resolve({ ok: true })),
  cancelTask: vi.fn(() => Promise.resolve({ ok: true })),
  rerunTask: vi.fn(() => Promise.resolve({ ok: true })),
}));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: "t1",
  name: "test-task",
  type: "code",
  workflow: "default",
  status: "running",
  stages: [
    { id: "s1", role: "coder", status: "complete", retries: 0, dependsOn: [], startedAt: new Date().toISOString(), duration_ms: 5000 },
    { id: "s2", role: "qa", status: "running", retries: 0, dependsOn: ["s1"], startedAt: new Date().toISOString(), isGate: true },
  ],
  startedAt: new Date().toISOString(),
  elapsed_ms: 10000,
  tokens: 500,
  discussion: [],
  plan: [],
  currentIteration: 1,
  maxIterations: 3,
  autoApproveRetries: true,
  iterationLog: null,
  ...overrides,
});

function renderDashboard(tasks: Task[]) {
  return render(
    <MemoryRouter>
      <Dashboard tasks={tasks} />
    </MemoryRouter>
  );
}

describe("Dashboard", () => {
  it("renders task table with all columns", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { container } = renderDashboard(tasks);
    const headers = container.querySelectorAll("th");
    const headerTexts = Array.from(headers).map(h => h.textContent);
    expect(headerTexts).toContain("Task");
    expect(headerTexts).toContain("Type");
    expect(headerTexts).toContain("Phase");
    expect(headerTexts).toContain("Progress");
    expect(headerTexts).toContain("Score Trend");
    expect(headerTexts).toContain("Gates");
    expect(headerTexts).toContain("Time");
  });

  it("shows correct task type based on roles", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, type: i === 0 ? "paper" : "research", startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { container } = renderDashboard(tasks);
    expect(container.textContent).toContain("paper");
    expect(container.textContent).toContain("research");
  });

  it("empty state shows 'No tasks' message", () => {
    const { container } = renderDashboard([]);
    expect(container.textContent).toContain("No tasks");
  });

  it("with 1-2 tasks: renders TaskCard, not table", () => {
    const { queryByTestId } = renderDashboard([makeTask(), makeTask({ id: "t2", name: "task-2", startedAt: new Date().toISOString() })]);
    expect(queryByTestId("card-layout")).toBeTruthy();
    expect(queryByTestId("table-layout")).toBeNull();
  });

  it("with 5 tasks: renders table, not cards", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { queryByTestId } = renderDashboard(tasks);
    expect(queryByTestId("table-layout")).toBeTruthy();
    expect(queryByTestId("card-layout")).toBeNull();
  });

  it("rename works in card mode (double-click)", () => {
    const { getByTestId } = renderDashboard([makeTask()]);
    const name = getByTestId("task-name");
    fireEvent.doubleClick(name);
    const input = getByTestId("rename-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("test-task");
  });

  it("rename works in table mode (double-click task name)", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { getAllByTestId } = renderDashboard(tasks);
    const names = getAllByTestId("task-name");
    fireEvent.doubleClick(names[0]);
    const input = getAllByTestId("rename-input")[0] as HTMLInputElement;
    expect(input).toBeTruthy();
  });

  it("right-click task shows context menu with Rename, Delete, Rerun", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, status: "failed", startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { container, getByTestId } = renderDashboard(tasks);
    const row = container.querySelector("tr.border-b")!;
    fireEvent.contextMenu(row);
    expect(getByTestId("context-menu")).toBeTruthy();
    expect(getByTestId("ctx-rename")).toBeTruthy();
    expect(getByTestId("ctx-delete")).toBeTruthy();
    expect(getByTestId("ctx-rerun")).toBeTruthy();
  });

  it("clicking Rename in context menu enables inline edit", () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `t${i}`, name: `task-${i}`, startedAt: new Date(Date.now() - i * 1000).toISOString() })
    );
    const { container, getByTestId, getAllByTestId } = renderDashboard(tasks);
    const row = container.querySelector("tr.border-b")!;
    fireEvent.contextMenu(row);
    fireEvent.click(getByTestId("ctx-rename"));
    const input = getAllByTestId("rename-input")[0] as HTMLInputElement;
    expect(input).toBeTruthy();
  });
});
