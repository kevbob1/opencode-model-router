import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
// Keep this hook test independent of Git processes and background suite runs.
vi.mock("../../src/verify/tree", () => ({ snapshotTree: async () => undefined }));

async function captureGraderParams(
  initialTemperature?: number,
  rejection?: Error,
): Promise<{ params: Record<string, unknown>; attempts: Record<string, unknown>[] }> {
  let hooks: any;
  let params: Record<string, unknown> = initialTemperature === undefined
    ? {}
    : { temperature: initialTemperature };
  const attempts: Record<string, unknown>[] = [];
  const graderSessionID = "grader-session";
  let graderCalls = 0;
  let createdSessions = 0;

  const ctx = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        // The checker requires an independent grader, not the producer's ID.
        create: async () => ({ data: { id: ++createdSessions === 1 ? "producer-session" : graderSessionID } }),
        prompt: async (request: any) => {
          if (request.body.system !== undefined) {
            graderCalls += 1;
            params = initialTemperature === undefined ? {} : { temperature: initialTemperature };
            await hooks["chat.params"]({
              sessionID: graderSessionID,
              model: { providerID: "provider", id: "model", variant: "test-variant" },
            }, params);
            attempts.push({ ...params });
            if (rejection && graderCalls === 1) throw rejection;
            return {
              data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
            };
          }

          return { data: { parts: [{ type: "text", text: "producer output" }] } };
        },
      },
    } as any,
  };

  hooks = await ModelRouterPlugin(ctx as any);
  try {
    await hooks.tool.delegate.execute({
      task: "complete the task",
      tier: "fast",
      acceptance: "[acceptance]\ncriteria: result is correct\n[/acceptance]",
    });
  } finally {
    await hooks.dispose?.();
  }

  return { params, attempts };
}

async function captureV2GraderParams(rejection: Error): Promise<{
  attempts: Array<{ request: Record<string, unknown>; params: Record<string, unknown> }>;
}> {
  let hooks: any;
  const attempts: Array<{ request: Record<string, unknown>; params: Record<string, unknown> }> = [];
  let graderCalls = 0;
  const graderSessionID = "v2-grader-session";
  const ctx = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    routerChildRunner: {
      run: async (request: any) => {
        if (request.agent) {
          await request.onCreated("v2-producer-session");
          return { sessionID: "v2-producer-session", text: "producer output" };
        }
        const sessionID = request.sessionID ?? graderSessionID;
        await request.onCreated(sessionID);
        const params: Record<string, unknown> = {};
        graderCalls += 1;
        await hooks["chat.params"]({
          sessionID,
          model: { providerID: "provider", id: "model", variant: "test-variant" },
        }, params);
        attempts.push({ request: { ...request }, params: { ...params } });
        if (graderCalls === 1) throw rejection;
        return { sessionID, text: '{"pass":true,"reasons":[]}' };
      },
      dispose: async () => {},
    },
    client: {
      session: {
        create: async () => ({ data: { id: "unused" } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "unused" }] } }),
      },
    } as any,
  };

  hooks = await ModelRouterPlugin(ctx as any);
  try {
    await hooks.tool.delegate.execute({
      task: "complete the task",
      tier: "fast",
      acceptance: "[acceptance]\ncriteria: result is correct\n[/acceptance]",
    });
  } finally {
    await hooks.dispose?.();
  }
  return { attempts };
}

describe("grader temperature hook", () => {
  beforeEach(() => {
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  });

  afterEach(() => {
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
  });

  it("omits temperature when graderTemperature is undefined", async () => {
    const cfg = loadConfig();
    delete cfg.enforcement?.verify?.graderTemperature;

    await expect(captureGraderParams()).resolves.toMatchObject({ params: {} });
  });

  it("keeps an explicitly configured zero grader temperature", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    await expect(captureGraderParams()).resolves.toMatchObject({ params: { temperature: 0 } });
  });

  it("keeps configured grader temperature when capability metadata is absent", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    await expect(captureGraderParams(0.7)).resolves.toMatchObject({ params: { temperature: 0 } });
  });

  it("preserves an inherited temperature when no grader override is configured", async () => {
    const cfg = loadConfig();
    delete cfg.enforcement?.verify?.graderTemperature;

    await expect(captureGraderParams(0.7)).resolves.toMatchObject({ params: { temperature: 0.7 } });
  });

  it("retries a compatible grader request once without temperature when the provider rejects it", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    const rejection = Object.assign(new Error("Unsupported parameter: temperature"), {
      code: "unsupported_parameter",
      status: 400,
    });
    const result = await captureGraderParams(0.7, rejection);
    expect(result.attempts).toEqual([{ temperature: 0 }, {}]);
    expect(result.attempts.filter((attempt) => !Object.hasOwn(attempt, "temperature"))).toHaveLength(1);
  });

  it("retries the V2 subagent request with its Model.Ref and omits temperature only on the retry", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    const result = await captureV2GraderParams(new Error("temperature is not supported by this model"));
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.params).toEqual({ temperature: 0 });
    expect(result.attempts[1]?.params).toEqual({});
    expect(result.attempts[1]?.request).toMatchObject({
      sessionID: "v2-grader-session",
      model: { providerID: expect.any(String), modelID: expect.any(String) },
    });
  });

  it("does not retry unrelated provider errors, even when they are client errors", async () => {
    const cfg = loadConfig();
    cfg.enforcement ??= {};
    cfg.enforcement.verify ??= {};
    cfg.enforcement.verify.graderTemperature = 0;

    const rejection = Object.assign(new Error("model rate limit exceeded"), {
      code: "rate_limit_exceeded",
      status: 400,
    });
    await expect(captureGraderParams(0.7, rejection)).resolves.toMatchObject({
      attempts: [{ temperature: 0 }],
      params: { temperature: 0 },
    });
  });
});
