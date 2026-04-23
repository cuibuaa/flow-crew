import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Sparkline from "../../src/components/Sparkline";

describe("Sparkline", () => {
  it("renders unicode block chars for number array", () => {
    const { container } = render(<Sparkline values={[0, 50, 100]} />);
    const text = container.textContent!;
    expect(text.length).toBe(3);
    expect(text[0]).toBe("▁");
    expect(text[2]).toBe("█");
  });

  it("empty array renders empty", () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.textContent).toBe("");
  });

  it("single value renders one block", () => {
    const { container } = render(<Sparkline values={[42]} />);
    expect(container.textContent!.length).toBe(1);
  });

  it("normalizes values to 0-7 range", () => {
    const { container } = render(<Sparkline values={[10, 20, 30, 40, 50, 60, 70, 80]} />);
    const text = container.textContent!;
    expect(text.length).toBe(8);
    // First should be lowest block, last should be highest
    expect(text[0]).toBe("▁");
    expect(text[7]).toBe("█");
  });
});
