import { describe, expect, it } from "vitest";
import { applyWorkflowPatch } from "../../api/mcp.js";

const workflow = {
  name: "Example",
  settings: { browser: { headless: true, recording: false } },
  nodes: [
    { type: "start", name: "Start" },
    { type: "block", name: "Fetch", code: "return 1" },
    { type: "end", name: "End" },
  ],
  edges: [
    { from: "Start", to: "Fetch" },
    { from: "Fetch", to: "End" },
  ],
};

describe("applyWorkflowPatch", () => {
  it("applies graph operations in order and leaves the source unchanged", () => {
    const patched = applyWorkflowPatch(workflow, {
      nodes: {
        remove: ["Fetch"],
        add: [{ type: "block", name: "Transform", code: "return 2" }],
        update: [{ name: "Transform", patch: { name: "Process" } }],
      },
      edges: {
        add: [
          { from: "Start", to: "Process" },
          { from: "Process", to: "End" },
        ],
      },
    });

    expect(patched.nodes.map((node: { name: string }) => node.name)).toEqual(["Start", "End", "Process"]);
    expect(patched.edges).toEqual([
      { from: "Start", to: "Process" },
      { from: "Process", to: "End" },
    ]);
    expect(workflow.nodes[1]?.name).toBe("Fetch");
    expect(workflow.edges).toHaveLength(2);
  });

  it("deep-merges settings while replacing other top-level fields", () => {
    const patched = applyWorkflowPatch(workflow, {
      settings: { browser: { recording: true } },
      helpers: [{ name: "helper", code: "return true" }],
    });

    expect(patched.settings).toEqual({ browser: { headless: true, recording: true } });
    expect(patched.helpers).toEqual([{ name: "helper", code: "return true" }]);
  });

  it("rejects unknown node operations and edge endpoints", () => {
    expect(() => applyWorkflowPatch(workflow, { nodes: { remove: ["Missing"] } })).toThrow(
      /Cannot remove unknown node/,
    );
    expect(() => applyWorkflowPatch(workflow, { edges: { add: [{ from: "Start", to: "Missing" }] } })).toThrow(
      /unknown endpoint/,
    );
  });
});
