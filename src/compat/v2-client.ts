import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { ChildSessionRunner } from "./child-session";

export const V2_GRADER_AGENT = "model-router-grader";
const RETAINED_CONTEXT_LIMIT = 500;
// A moved child dispatches provider hooks through its destination's plugin instance.
// Session IDs are host-owned and unique; share only the active retry's omission flag.
const temperatureOmissions = new Set<string>();

/** The small v1 client surface still used by the shared hooks. */
export function createV2Runtime(ctx: Plugin.Context) {
  type ToolScope = { context: ToolContext; active: boolean };
  const currentTool = new AsyncLocalStorage<ToolScope>();
  const retainedContexts = new Map<string, ToolScope>();
  const lifetime = new AbortController();
  const childSystems = new Map<string, string>();
  const activeChildren = new Map<string, AbortController>();

  const interrupt = async (sessionID: string, signal?: AbortSignal) => {
    activeChildren.get(sessionID)?.abort();
    return ctx.session.interrupt({ sessionID }, signal ? { signal } : undefined);
  };

  const client = {
    session: {
      async get(input: { path: { id: string }; signal?: AbortSignal }) {
        return { data: await ctx.session.get({ sessionID: input.path.id }, input.signal ? { signal: input.signal } : undefined) };
      },
      async abort(input: { path: { id: string }; signal?: AbortSignal }) {
        return { data: await interrupt(input.path.id, input.signal) };
      },
    },
    config: {
      async providers() {
        const location = { directory: ctx.location.directory };
        const [providers, models, defaultModel] = await Promise.all([
          ctx.provider.list({ location }),
          ctx.model.list({ location }),
          ctx.model.default({ location }),
        ]);
        return {
          data: {
            providers: providers.data.map(provider => ({
              id: provider.id,
              name: provider.name,
              models: Object.fromEntries(models.data
                .filter(model => model.providerID === provider.id && model.enabled)
                .map(model => [model.id, { id: model.id, status: model.status }])),
            })),
            default: defaultModel.data
              ? { [defaultModel.data.providerID]: defaultModel.data.id }
              : {},
          },
        };
      },
    },
    // v2 has no app.log endpoint. createPluginLogger uses its console fallback.
  };

  const childRunner: ChildSessionRunner = {
    async run(request) {
      lifetime.signal.throwIfAborted();
      const current = currentTool.getStore();
      // A shared background worker can run in a different caller's async
      // scope. Only a real context previously observed for the requested
      // parent may authorize that dispatch; never manufacture call/message IDs.
      const scope = request.parentSessionID && request.parentSessionID !== current?.context.sessionID
        ? retainedContexts.get(request.parentSessionID)
        : current;
      if (!scope) throw new Error("[model-router] v2 child dispatch requires an active tool context or a retained context matching its parent");
      const toolContext = scope.context;
      const native = (await ctx.tool.list()).find(tool => tool.id === "subagent");
      if (!native) throw new Error("[model-router] OpenCode v2's native subagent tool is unavailable");
      const controller = new AbortController();
      // Deferred verification outlives its originating tool call. Its own
      // deadline and plugin lifetime govern cancellation once that call ends.
      const signal = AbortSignal.any([
        lifetime.signal, controller.signal,
        ...(scope.active ? [toolContext.signal] : []),
        ...(request.signal ? [request.signal] : []),
      ]);
      signal.throwIfAborted();
      let childID = request.sessionID;
      const model = request.model;
      if (childID && request.system) childSystems.set(childID, request.system);
      if (childID) activeChildren.set(childID, controller);
      if (childID && request.omitTemperature) temperatureOmissions.add(childID);
      try {
        const result = await native.execute({
          agent: request.agent ?? V2_GRADER_AGENT,
          description: request.agent ? `Router ${request.agent} delegation` : "Router result verification",
          prompt: request.prompt,
          ...(model ? { model: `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}` } : {}),
          ...(request.sessionID ? { sessionID: request.sessionID } : {}),
          background: false,
        }, {
          ...toolContext,
          signal,
          async progress(metadata) {
            const sessionID = metadata.sessionID;
            if (typeof sessionID === "string" && sessionID !== childID) {
              if (childID) throw new Error("[model-router] native subagent changed its child session ID");
              childID = sessionID;
              activeChildren.set(sessionID, controller);
              if (request.system) childSystems.set(sessionID, request.system);
              // The native subagent awaits progress after creating its child and
              // before prompting it. Register guards and scope graders here.
              await request.onCreated(sessionID);
              if (request.cwd) await ctx.session.move({ sessionID, directory: request.cwd }, { signal });
              signal.throwIfAborted();
            }
            await toolContext.progress(metadata);
          },
        });
        signal.throwIfAborted();
        const output = result.output as { sessionID?: unknown; status?: unknown; output?: unknown } | undefined;
        if (!childID || output?.sessionID !== childID || output.status !== "completed" || typeof output.output !== "string") {
          throw new Error("[model-router] native subagent did not return a completed child result; verification cannot use a pending result");
        }
        return { sessionID: childID, text: output.output };
      } catch (error) {
        controller.abort();
        if (childID) {
          try { await ctx.session.interrupt({ sessionID: childID }); } catch { /* keep the original dispatch failure */ }
        }
        throw error;
      } finally {
        if (childID) {
          childSystems.delete(childID);
          activeChildren.delete(childID);
          temperatureOmissions.delete(childID);
        }
      }
    },
    async dispose(sessionID) {
      childSystems.delete(sessionID);
      temperatureOmissions.delete(sessionID);
      await interrupt(sessionID);
      // The public v2 plugin context cannot remove sessions. Keep the native
      // child history for inspection; never turn it into an unparented session.
    },
  };

  return {
    client,
    childRunner,
    async withToolContext<T>(context: ToolContext, operation: () => Promise<T>): Promise<T> {
      lifetime.signal.throwIfAborted();
      const scope = { context, active: true };
      retainedContexts.delete(context.sessionID);
      retainedContexts.set(context.sessionID, scope);
      while (retainedContexts.size > RETAINED_CONTEXT_LIMIT) {
        retainedContexts.delete(retainedContexts.keys().next().value!);
      }
      try {
        return await currentTool.run(scope, operation);
      } finally {
        scope.active = false;
      }
    },
    applyChildSystem(sessionID: string, system: SessionContext["system"]): void {
      const text = childSystems.get(sessionID);
      if (text && !system.some(part => part.text === text)) system.push({ type: "text", text });
    },
    async applyChildRequest(sessionID: string, request: Request): Promise<Request> {
      if (!temperatureOmissions.has(sessionID) || !request.body) return request;
      // V2 context options are overrides: deleting one restores model/agent defaults.
      // Remove the rejected setting after protocol lowering instead, on an owned copy.
      const body = await request.clone().json().catch(() => undefined);
      if (!body || typeof body !== "object" || Array.isArray(body)) return request;
      const record = body as Record<string, unknown>;
      let changed = false;
      for (const settings of [record, record.generationConfig, record.inferenceConfig]) {
        if (settings && typeof settings === "object" && Object.hasOwn(settings, "temperature")) {
          delete (settings as Record<string, unknown>).temperature;
          changed = true;
        }
      }
      if (!changed) return request;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return new Request(request, { headers, body: JSON.stringify(body) });
    },
    applyChildWebSocket(sessionID: string, frame: string): string {
      if (!temperatureOmissions.has(sessionID)) return frame;
      let body: unknown;
      try { body = JSON.parse(frame); } catch { return frame; }
      // OpenAI's native WebSocket transport never invokes the HTTP request hook.
      if (!body || typeof body !== "object") return frame;
      const record = body as Record<string, unknown>;
      const response = record.response;
      if (record.type !== "response.create" || !response || typeof response !== "object"
        || !Object.hasOwn(response, "temperature")) return frame;
      delete (response as Record<string, unknown>).temperature;
      return JSON.stringify(body);
    },
    forgetSession(sessionID: string): void {
      retainedContexts.delete(sessionID);
      childSystems.delete(sessionID);
      temperatureOmissions.delete(sessionID);
      activeChildren.get(sessionID)?.abort();
    },
    async dispose(): Promise<void> {
      lifetime.abort();
      const sessions = [...activeChildren.keys()];
      retainedContexts.clear();
      childSystems.clear();
      for (const sessionID of sessions) temperatureOmissions.delete(sessionID);
      await Promise.allSettled(sessions.map(sessionID => interrupt(sessionID)));
      activeChildren.clear();
    },
  };
}

export type V2Runtime = ReturnType<typeof createV2Runtime>;
