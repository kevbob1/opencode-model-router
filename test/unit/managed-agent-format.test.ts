import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { testing } from "../../src/index.js";

const { managedTierAgent, syncGlobalTierAgents } = testing;

const TIER_DEF = {
  description: "glm-5.3-flash variant=low composite 73.47",
  prompt: "STOP CONDITIONS — read these FIRST.",
  maxSteps: 30,
};

function makeAgentsDir(): string {
  return mkdtempSync(join(osTmpdir(), "omr-agents-"));
}

describe("managedTierAgent format", () => {
  it("starts with frontmatter at offset 0 so opencode parses it", () => {
    const content = managedTierAgent("fast", TIER_DEF);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: omr-fast");
    expect(content).toContain("mode: subagent");
    expect(content).toContain("steps: 30");
    expect(content).toContain("managedBy: opencode-model-router");
  });

  it("emits exact frontmatter with no extra comments or HTML wrappers", () => {
    const content = managedTierAgent("fast", TIER_DEF);
    expect(content).toBe([
      "---",
      "name: omr-fast",
      "description: \"glm-5.3-flash variant=low composite 73.47\"",
      "mode: subagent",
      "steps: 30",
      "managedBy: opencode-model-router",
      "---",
      "STOP CONDITIONS — read these FIRST.",
      "",
    ].join("\n"));
    expect(content.match(/^---$/gm)?.length).toBe(2);
    expect(content).not.toContain("#");
  });

  it("keeps managed ownership marker inside the frontmatter", () => {
    const content = managedTierAgent("heavy", TIER_DEF);
    expect(content).toContain("managedBy: opencode-model-router");
    expect(content).not.toContain("<!--");
  });
});

describe("syncGlobalTierAgents", () => {
  it("writes new-format files into the agents directory", () => {
    const dir = makeAgentsDir();
    try {
      const available = syncGlobalTierAgents({ fast: TIER_DEF }, () => {}, dir);
      expect(available.has("fast")).toBe(true);
      const content = readFileSync(join(dir, "omr-fast.md"), "utf8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain("mode: subagent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites existing router-generaged files wholesale by filename", () => {
    const dir = makeAgentsDir();
    try {
      // Simulate an old file that had a broken back-to-back frontmatter.
      writeFileSync(join(dir, "omr-fast.md"), "---\n---\n---\n---\nname: omr-fast\nmode: primary\nmanagedBy: opencode-model-router\n---\nbody");
      const warnings: string[] = [];
      const available = syncGlobalTierAgents({ fast: TIER_DEF }, (m) => warnings.push(m), dir);
      expect(available.has("fast")).toBe(true);
      expect(warnings).toEqual([]);
      const after = readFileSync(join(dir, "omr-fast.md"), "utf8");
      expect(after.startsWith("---\nname: omr-fast\n")).toBe(true);
      expect(after).toContain("mode: subagent");
      expect(after).not.toContain("mode: primary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves user files that lack the managed marker", () => {
    const dir = makeAgentsDir();
    try {
      writeFileSync(join(dir, "omr-fast.md"), "---\nname: omr-fast\nmode: primary\n---\nuser content");
      const warnings: string[] = [];
      const available = syncGlobalTierAgents({ fast: TIER_DEF }, (m) => warnings.push(m), dir);
      expect(available.has("fast")).toBe(false);
      expect(warnings.join("\n")).toContain("collision");
      expect(readFileSync(join(dir, "omr-fast.md"), "utf8")).toContain("user content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
