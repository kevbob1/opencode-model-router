import { describe, expect, it, vi } from "vitest";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { createVerificationWiring } from "../../src/verify/wiring";
import type { RouterConfig } from "../../src/router/config";

const cfg: RouterConfig = {
  activePreset: "p", presets: { p: { medium: { model: "p/model", description: "", whenToUse: [] } } },
  rules: [], defaultTier: "medium", enforcement: { verify: { graderTemperature: 0 } },
};
const request = Object.freeze({ tier: "medium", system: "Judge", prompt: "Inspect" });

function fixture() {
  const prompt = vi.fn(async (_request: unknown): Promise<any> => ({ data: { parts: [{ type: "text", text: "ok" }] } }));
  const client = { session: {
    create: vi.fn(async () => ({ data: { id: "child" } })), prompt,
    abort: vi.fn(async () => {}), delete: vi.fn(async () => {}),
  } };
  const wiring = createVerificationWiring({ client, directory: "/project", getConfig: () => cfg });
  return { wiring, prompt, client };
}

describe("bounded grader temperature retry", () => {
  it.each([
    ["thrown", new Error("Unsupported parameter: 'temperature'")],
    ["SDK response", { error: { name: "APIError", data: { message: "temperature is not supported" } } }],
    ["assistant response", { data: { info: { error: { name: "APIError", data: { message: "This model does not support temperature" } } } } }],
    ["wrapped native error", new ToolError({ message: "Child failed", error: new Error("Provider failed", {
      cause: { response: { body: JSON.stringify({ error: { code: "unsupported_parameter", param: "temperature", message: "Option rejected" } }) } },
    }) })],
  ])("retries one %s rejection and preserves request/model/config", async (_name, rejection) => {
    const { wiring, prompt, client } = fixture();
    const before = JSON.stringify(cfg);
    if (rejection instanceof Error) prompt.mockRejectedValueOnce(rejection);
    else prompt.mockResolvedValueOnce(rejection);
    prompt.mockImplementationOnce(async () => {
      expect(wiring.graderTemperatureOmissions.has("child")).toBe(true);
      return { data: { parts: [{ type: "text", text: "ok" }] } };
    });
    await expect(wiring.dispatchGrader(request, "parent")).resolves.toEqual({ sessionID: "child", text: "ok" });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0]?.[0]).toEqual(prompt.mock.calls[1]?.[0]);
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({ body: { model: { providerID: "p", modelID: "model" }, system: "Judge" } });
    expect(JSON.stringify(cfg)).toBe(before);
    expect(request).toEqual({ tier: "medium", system: "Judge", prompt: "Inspect" });
    expect(wiring.graderTemperatureOmissions.size).toBe(0);
    expect(wiring.graderSessions.size).toBe(0);
    expect(client.session.delete).toHaveBeenCalledOnce();
  });

  it.each([
    "Invalid temperature: expected a value between 0 and 2",
    "Invalid API key (request temperature=0)",
    "Unsupported model; request included temperature=0",
    "Unknown provider; temperature=0",
    "Rate limit exceeded",
  ])("does not retry an unrelated failure: %s", async message => {
    const { wiring, prompt } = fixture();
    const error = new Error(message);
    prompt.mockRejectedValueOnce(error);
    await expect(wiring.dispatchGrader(request)).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledOnce();
    expect(wiring.graderTemperatureOmissions.size).toBe(0);
  });

  it("preserves SDK-returned unrelated errors and cyclic causes without retrying", async () => {
    const { wiring, prompt } = fixture();
    const error: Record<string, unknown> = { message: "Invalid API key", code: "invalid_parameter", param: "temperature" };
    error.cause = error;
    prompt.mockResolvedValueOnce({ error });
    await expect(wiring.dispatchGrader(request)).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not classify echoed request content as a provider rejection", async () => {
    const { wiring, prompt } = fixture();
    const error = { response: { body: JSON.stringify({
      error: { message: "Unauthorized" }, request: { messages: [{ content: "Unsupported parameter: temperature" }] },
    }) } };
    prompt.mockRejectedValueOnce(error);
    await expect(wiring.dispatchGrader(request)).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not retry a second rejection and preserves the retry error", async () => {
    const { wiring, prompt } = fixture();
    const error = new Error("temperature is not supported");
    prompt.mockRejectedValue(error);
    await expect(wiring.dispatchGrader(request)).rejects.toBe(error);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(wiring.graderTemperatureOmissions.size).toBe(0);
    expect(wiring.graderSessions.size).toBe(0);
  });

  it.each([false, true])("bounds native child retries (unrelated error: %s)", async unrelated => {
    const error = new ToolError({ message: "Child failed", error: new Error(unrelated
      ? "Invalid API key (temperature=0)" : "temperature is not supported") });
    const run = vi.fn(async (input: any): Promise<any> => {
      await input.onCreated("child");
      throw error;
    });
    const dispose = vi.fn(async () => {});
    const wiring = createVerificationWiring({ client: {}, childRunner: { run, dispose }, directory: "/project", getConfig: () => cfg });
    await expect(wiring.dispatchGrader(request, "parent")).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(unrelated ? 1 : 2);
    if (!unrelated) expect(run.mock.calls[1]?.[0]).toMatchObject({ sessionID: "child", omitTemperature: true });
    expect(dispose).toHaveBeenCalledOnce();
    expect(wiring.graderTemperatureOmissions.size).toBe(0);
    expect(wiring.graderSessions.size).toBe(0);
  });
});
