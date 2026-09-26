import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import plugin from "../../src/index";

describe("native V2 plugin setup", () => {
  let home: string | undefined;
  let previousHome: string | undefined;
  let previousDelegate: string | undefined;

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDelegate === undefined) delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    else process.env.MODEL_ROUTER_VERIFIED_DELEGATE = previousDelegate;
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("registers through native V2 domains without a V1 hook object", async () => {
    home = mkdtempSync(join(tmpdir(), "omr-v2-setup-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    previousDelegate = process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";

    const hooks = new Map<string, Function>();
    const tools: any[] = [];
    const commands: any[] = [];
    const context: any = {
      app: { name: "test", version: "2.0.18", channel: "test" },
      location: { directory: home, project: {} },
      options: {},
      provider: { list: async () => ({ providers: [] }) },
      model: { list: async () => ({ providers: [] }) },
      session: {
        hook: async (name: string, handler: Function) => hooks.set(`session:${name}`, handler),
        create: async () => ({ id: "child" }),
        prompt: async () => ({ parts: [] }),
        interrupt: async () => {},
        synthetic: async () => {},
      },
      tool: {
        hook: async (name: string, handler: Function) => hooks.set(`tool:${name}`, handler),
        transform: async (callback: Function) => callback({ add: (tool: any) => tools.push(tool) }),
      },
      agent: {
        transform: async (callback: Function) => callback({ update: () => {} }),
        reload: async () => {},
      },
      command: {
        transform: async (callback: Function) => callback({ add: (command: any) => commands.push(command) }),
      },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {},
        }),
      },
    };

    const cleanup = await plugin.setup(context);

    expect(hooks.has("session:context")).toBe(true);
    expect(hooks.has("session:prompt")).toBe(true);
    expect(hooks.has("tool:execute.before")).toBe(true);
    expect(hooks.has("tool:execute.after")).toBe(true);
    expect(tools.map((tool) => tool.name)).toContain("delegate");
    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["tiers", "preset", "budget", "bypass", "router"]),
    );

    cleanup?.();
  });
});
