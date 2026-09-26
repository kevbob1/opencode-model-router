import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { testing } from "../../src/index.js";

const { managedTierAgent, syncGlobalTierAgents } = testing;

const LEGACY = [
  "<!-- BEGIN opencode-model-router managed -->",
  "---",
  "name: omr-fast",
  "description: \"old\"",
  "mode: subagent",
  "managedBy: opencode-model-router",
  "---",
  "legacy prompt",
  "<!-- END opencode-model-router managed -->",
  "",
].join("\n");

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

  it("keeps managed markers as yaml comments, not html comments", () => {
    const content = managedTierAgent("heavy", TIER_DEF);
    expect(content).toContain("# managed-file: BEGIN");
    expect(content).toContain("# managed-file: END");
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

  it("rewrites a legacy html-comment-wrapped file to the new format", () => {
    const dir = makeAgentsDir();
    try {
      writeFileSync(join(dir, "omr-fast.md"), LEGACY);
      const warnings: string[] = [];
      const available = syncGlobalTierAgents({ fast: TIER_DEF }, (m) => warnings.push(m), dir);
      expect(available.has("fast")).toBe(true);
      expect(warnings).toEqual([]);
      const after = readFileSync(join(dir, "omr-fast.md"), "utf8");
      expect(after.startsWith("---\n")).toBe(true);
      expect(after).not.toContain("<!--");
      expect(after).toContain("mode: subagent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves user files that lack the managed marker", () => {
    const dir = makeAgentsDir();
    try {
      const userFile = join(dir, "omr-fast.md");
      writeFileSync(userFile, "---\nname: omr-fast\nmode: subagent\n---\nuser content");
      const warnings: string[] = [];
      const available = syncGlobalTierAgents({ fast: TIER_DEF }, (m) => warnings.push(m), dir);
      expect(available.has("fast")).toBe(false);
      expect(warnings.join("\n")).toContain("collision");
      expect(readFileSync(userFile, "utf8")).toContain("user content");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
