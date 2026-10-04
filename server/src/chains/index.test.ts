import { describe, it, expect } from "vitest";
import { checkConsensus } from "../chains/index.js";

type ProviderResult = { provider: string; success: boolean; data?: unknown; error?: string; latencyMs: number };

function makeResult(provider: string, success: boolean, data: unknown, error?: string): ProviderResult {
  return { provider, success, data, error, latencyMs: 100 };
}

describe("checkConsensus", () => {
  it("identical responses reach consensus", () => {
    const results = [
      makeResult("a", true, { value: 1 }),
      makeResult("b", true, { value: 1 })
    ];
    const consensus = checkConsensus(results, 0.66);
    expect(consensus.reached).toBe(true);
    expect(consensus.value).toEqual({ value: 1 });
    expect(consensus.agreeingProviders).toEqual(["a", "b"]);
  });

  it("divergent responses fail consensus", () => {
    const results = [
      makeResult("a", true, { value: 1 }),
      makeResult("b", true, { value: 2 })
    ];
    const consensus = checkConsensus(results, 0.66);
    expect(consensus.reached).toBe(false);
    expect(consensus.value).toBeNull();
  });

  it("partial failures with majority success reach consensus", () => {
    const results = [
      makeResult("a", true, { value: 1 }),
      makeResult("b", false, undefined, "timeout"),
      makeResult("c", true, { value: 1 })
    ];
    const consensus = checkConsensus(results, 0.66);
    expect(consensus.reached).toBe(true);
    expect(consensus.value).toEqual({ value: 1 });
  });

  it("threshold strictly enforced - 2 of 3 is 66.6%, threshold 0.66 passes", () => {
    const results = [
      makeResult("a", true, { value: 1 }),
      makeResult("b", true, { value: 1 }),
      makeResult("c", false, undefined, "down")
    ];
    expect(checkConsensus(results, 0.66).reached).toBe(true);
    expect(checkConsensus(results, 0.67).reached).toBe(false);
  });

  it("empty results fail consensus", () => {
    const consensus = checkConsensus([], 0.66);
    expect(consensus.reached).toBe(false);
    expect(consensus.value).toBeNull();
  });

  it("single successful provider reaches any threshold <= 1", () => {
    const results = [makeResult("a", true, { foo: "bar" })];
    expect(checkConsensus(results, 1.0).reached).toBe(true);
    expect(checkConsensus(results, 1.0).value).toEqual({ foo: "bar" });
  });

  it("ignores failed providers when counting agreement", () => {
    const results = [
      makeResult("a", true, { v: 1 }),
      makeResult("b", false, undefined, "x")
    ];
    const consensus = checkConsensus(results, 0.5);
    expect(consensus.reached).toBe(true);
    expect(consensus.agreeingProviders).toEqual(["a"]);
  });
});