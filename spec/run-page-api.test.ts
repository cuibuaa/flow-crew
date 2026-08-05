import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRunSummary } from "../ui/src/api";

describe("run summary read semantics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats only HTTP 404 as a known missing summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(fetchRunSummary("missing-summary")).resolves.toBeNull();
  });

  it("surfaces non-404 and network failures instead of turning them into empty data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "summary backend unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("backend-error")).rejects.toThrow("summary backend unavailable");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    await expect(fetchRunSummary("network-error")).rejects.toThrow("connection refused");
  });

  it("rejects malformed success payloads while accepting text content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(fetchRunSummary("invalid-json")).rejects.toThrow("not valid JSON");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("invalid-content")).rejects.toThrow("did not contain text content");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ content: "# Progress\n\nStill running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(fetchRunSummary("progress-fallback")).resolves.toBe("# Progress\n\nStill running");
  });
});
