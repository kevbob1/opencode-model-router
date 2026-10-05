import type { PluginInput } from "@opencode-ai/plugin";

/** A host-owned child lifecycle, so v2 never fabricates REST sessions or IDs. */
export interface ChildSessionRequest {
  parentSessionID?: string;
  /** Resume an existing child for a bounded grader retry. */
  sessionID?: string;
  /** Strip the explicitly rejected option from the retry's final provider request. */
  omitTemperature?: boolean;
  cwd?: string;
  agent?: string;
  model?: { providerID: string; modelID: string; variant?: string };
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  /** Runs before the child can start its first model request. */
  onCreated(sessionID: string): Promise<void>;
}

export interface ChildSessionRunner {
  run(request: ChildSessionRequest): Promise<{ sessionID: string; text: string }>;
  dispose(sessionID: string): Promise<void>;
}

export type RouterPluginInput = PluginInput & {
  routerChildRunner?: ChildSessionRunner;
};
