import type { Plugin, PluginInput } from "@opencode-ai/plugin";

// Imports for internal use within this module
import {
  loadConfig,
  resolvePresetName,
  writeState,
  invalidateConfigCache,
  overridePath,
  localOverridePath,
  findProjectOverride,
} from "./router/config";
import type { RouterConfig, TierConfig, Preset, ModeConfig } from "./router/config";
import { buildAgentOptions, warnAgentOptionsEffortOnce } from "./router/agent-options";
import { selectTierPrompt } from "./router/prompts";
import {
  buildTiersOutput,
  buildPresetList,
  buildPresetSwitched,
  buildUnknownPreset,
  buildNoModes,
  buildBudgetList,
  buildBudgetSwitched,
  buildUnknownMode,
  buildBypassMessage,
  buildEnforceSet,
  buildEnforceStatus,
  buildOverridesOutput,
  buildRouterHelp,
  buildModelsOutput,
  formatModelIssues,
} from "./commands/output";
import {
  resolveSubagentOverrides,
  mergeSubagentOverride,
} from "./router/subagents";
import { fingerprintToolCall } from "./guard/fingerprint";
import { detectNarration } from "./guard/narration";
import {
  getActiveTiers,
  buildDelegationProtocol,
  isClaudeModel,
  CLAUDE_TIER_PREFIX,
  CLAUDE_ORCHESTRATOR_PREFIX,
  CLAUDE_ANTI_NARRATION,
  assembleSystemPrompt,
} from "./router/protocol";
import { resolveEnforcementMode } from "./router/enforcement";
import { createPluginLogger } from "./router/logger";
import {
  findOrphanedStrongPatterns,
  normalizeCatalog,
  validateModels,
} from "./router/catalog";
import type { Catalog } from "./router/catalog";
import {
  createSessionStore,
  parseCapDirective,
  buildCapBanner,
  DEFAULT_TIER_CAPS,
  READ_ONLY_TOOLS,
} from "./router/sessions";
import type { Cap, SubagentState } from "./router/sessions";
import { createTrajectoryStore } from "./telemetry/trajectory";
import { createGuardStore } from "./guard/store";
import { createIdleTtlSweeper } from "./router/idle-sweep";
import { guardBeforeCall, guardAfterCall, formatScorecard } from "./guard/enforce";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { exec as nodeExec } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { scrubText } from "./guard/scrub";
import { accept } from "./verify/gate";
import { createVerificationWiring, extractAssistantText } from "./verify/wiring";
import {
  DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
  DEFAULT_GATE_BUDGET_MS,
  RouterTimeoutError,
  timeoutMs,
  withTimeout,
} from "./verify/timeout";
import {
  createChangedFileStore,
  parseTaskResult,
  buildDelegationDoD,
  tierModel,
  shouldVerifyTask,
  buildForcingNote,
  buildAcceptedSuffix,
} from "./verify/dispatch";
import { newLadderState, recordAttempt, nextAction, advance, buildEscalatePolicy, formatLadderScorecard } from "./escalate/ladder";

// ---------------------------------------------------------------------------
// Re-exports — type-only re-exports for IDE/test consumers.
// NOTE: value re-exports are intentionally absent. opencode's plugin loader
// calls every function export as a factory (Ck iterates Object.values(mod));
// adding named function exports would cause spurious factory calls.
// Tests import from their specific source files instead of this entry point.
// ---------------------------------------------------------------------------

export type { RouterConfig, TierConfig, Preset, ModeConfig, FallbackConfig, EnforcementConfig } from "./router/config";
export type { Cap, SubagentState };
export type { TrajectoryState, TrajectoryToolEvent } from "./telemetry/trajectory";
export type { EnforcementMode } from "./router/enforcement";
export type { GuardPolicy, GuardState, GuardCall, GuardDecision } from "./guard/guards";

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  cfg.activePreset = resolved;

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });

  // Invalidate cache so next read picks up the new active preset
  invalidateConfigCache();
}

function saveActiveMode(modeName: string): void {
  const cfg = loadConfig();
  if (!cfg.modes?.[modeName]) {
    return;
  }

  cfg.activeMode = modeName;
  writeState({ activeMode: modeName });
  invalidateConfigCache();
}

function saveEnforcementMode(mode: "off" | "advisory" | "enforced"): void {
  writeState({ enforcementMode: mode });
  invalidateConfigCache();
}

/**
 * `/router` dispatch. Decides and persists here; rendering lives in
 * src/commands/output.ts.
 */
function buildRouterOutput(cfg: RouterConfig, args: string): string {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      saveEnforcementMode(mode);
      return buildEnforceSet(mode);
    }
    return buildEnforceStatus(
      resolveEnforcementMode({ config: cfg, env: process.env }).mode,
    );
  }

  if (sub === "overrides") {
    const globalPath = overridePath();
    const foundLocal = findProjectOverride();
    const localPath = foundLocal ?? localOverridePath();
    return buildOverridesOutput({
      globalPath,
      globalPresent: existsSync(globalPath),
      localPath,
      localPresent: existsSync(localPath),
      localFound: foundLocal !== undefined,
      activePreset: cfg.activePreset,
    });
  }

  return buildRouterHelp(
    resolveEnforcementMode({ config: cfg, env: process.env }).mode,
  );
}

/** `/budget` dispatch. Persists the switch, then renders. */
function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) return buildNoModes();

  const requested = args.trim().toLowerCase();
  if (!requested) return buildBudgetList(cfg);

  const mode = modes[requested];
  if (mode) {
    saveActiveMode(requested);
    return buildBudgetSwitched(mode, requested);
  }

  return buildUnknownMode(modes, requested);
}

/** `/preset` dispatch. Persists the switch, then renders. */
function buildPresetOutput(cfg: RouterConfig, args: string): string {
  const requestedPreset = args.trim();
  if (!requestedPreset) return buildPresetList(cfg);

  const resolvedPreset = resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    saveActivePreset(resolvedPreset);
    cfg.activePreset = resolvedPreset;
    return buildPresetSwitched(cfg, resolvedPreset);
  }

  return buildUnknownPreset(cfg, requestedPreset);
}

const ModelRouterPlugin: Plugin = async (ctx: PluginInput) => {
  let cfg = loadConfig();
  const activeTiers = getActiveTiers(cfg);

  // Per-plugin-instance session store: owns subagentSessionIDs and subagentCapState.
  const sessionStore = createSessionStore();

  // Per-plugin-instance trajectory store (Phase 0.3 scaffolding — RECORD-ONLY).
  // Observes subagent tool activity to build a per-session scorecard. It emits
  // NOTHING into any model-visible output; the only externally observable effect
  // is an opt-in debug dump gated behind MODEL_ROUTER_TRAJECTORY_DEBUG=1.
  const trajectoryStore = createTrajectoryStore();

  // Per-plugin-instance guard state (Layer 1 hard-block). Only engaged for
  // subagent sessions when enforcement mode is advisory/enforced; in "off"
  // mode no guard state is ever created, so behaviour stays byte-identical.
  const guardStore = createGuardStore();

  const changedFileStore = createChangedFileStore();

  // Idle-TTL maintenance for the four per-instance stores. No timer is
  // scheduled: the sweeper is invoked opportunistically from chat.message and
  // self-throttles, so a long-lived plugin instance cannot accumulate state for
  // sessions that went away without a teardown hook.
  const sweepIdleStores = createIdleTtlSweeper([
    () => sessionStore.sweep(),
    () => guardStore.sweep(),
    () => trajectoryStore.sweep(),
    () => changedFileStore.sweep(),
  ]);

  // Layer-2's impure corner: exec, fs, and the opencode client, built once and
  // read back through getConfig so a reloaded cfg (from /preset, /budget or
  // /router enforce) applies to graded work too.
  const { graderSessions, dispatchGrader, buildGateDeps, disposeChildSession } =
    createVerificationWiring({
      client: ctx.client,
      directory: ctx.directory,
      getConfig: () => cfg,
    });

  // Best-effort, secret-free delegate scorecard dump (counts only).
  const dumpDelegateScorecard = (
    sid: string,
    st: Parameters<typeof formatLadderScorecard>[0],
    accepted: boolean,
    method: string,
  ): void => {
    try {
      const line = formatLadderScorecard(st, accepted, method);
      const dir = join(tmpdir(), "opencode-model-router-trajectory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${sid}.delegate.log`), line + "\n", { flag: "a" });
    } catch {
      // best-effort only
    }
  };

  // Bypass mode: when true, the router skips all system prompt injection,
  // subagent tracking, cap enforcement, and narration detection for the
  // current plugin lifetime (i.e., until OpenCode is restarted).
  let bypassed = false;

  // Passive warnings go to opencode's log rather than stderr: console output
  // from a plugin paints over the TUI. Falls back to console when the server
  // has no /log endpoint. See src/router/logger.ts.
  const logger = createPluginLogger(ctx.client);

  // Fetch and normalize opencode's live provider/model catalog. Best-effort:
  // returns null when the client call fails, e.g. the server is not ready yet.
  // The pure analysis (validateModels) lives in src/router/catalog.ts.
  const fetchCatalog = async (): Promise<Catalog | null> => {
    try {
      const res: any = await ctx.client.config.providers();
      return normalizeCatalog(res?.data);
    } catch {
      return null;
    }
  };

  // Deferred passive catalog check. The first orchestrator turn only STARTS the
  // fetch (fire-and-forget, never awaited on the chat.message hot path) and
  // parks the result in a local; the warning is emitted on the first LATER turn
  // that finds the promise already settled — normally turn 2. Deliberate
  // tradeoff: a report-only diagnostic showing up one turn late costs nothing,
  // while awaiting a network round-trip in front of every session's first
  // message costs every user every session. No timers (banned in src/), and the
  // continuation writes to a local variable only — it never touches an
  // output.parts of a message the hook has already returned.
  //
  // Command handlers deliberately keep their own fresh fetchCatalog() call, so a
  // turn-1 failure (server not ready yet) is never cached into `/router models`.
  let catalogFetchStarted = false;
  /** undefined = not started or still in flight; null = the fetch failed. */
  let deferredCatalog: Catalog | null | undefined;
  // One-shot guard so the passive warnings run at most once per plugin
  // lifetime; re-validate on demand with /router.
  let catalogWarned = false;

  const startCatalogFetch = (): void => {
    if (catalogFetchStarted) return;
    catalogFetchStarted = true;
    // fetchCatalog already swallows its own errors; the .catch is belt-and-
    // braces so this fire-and-forget promise can never reject unhandled.
    void fetchCatalog()
      .then((c) => {
        deferredCatalog = c;
      })
      .catch(() => {
        deferredCatalog = null;
      });
  };

  const enableDelegateTool =
    cfg.experimental?.verifiedDelegateTool === true ||
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE === "1";

  return {
    // Warnings post to /log fire-and-forget, which loses the message when the
    // process is about to exit — `opencode run` and `opencode debug` are short
    // enough for that to be the normal case. Verified against opencode 1.18.16
    // that dispose is both called and awaited, so flushing here is enough.
    dispose: async () => {
      await logger.flush();
    },
    tool: {
      ...(enableDelegateTool ? { delegate: tool({
        description:
          "Delegate a task to a tier subagent (fast | medium | heavy). The subagent's result is INDEPENDENTLY VERIFIED (deterministic checks, or an independent grader at >= the producer tier in a fresh session) before it is returned. Returns an accepted result on PASS, or an honest 'unmet' status on FAIL — never a self-reported completion. Optionally pass an [acceptance]...[/acceptance] block to define the Definition of Done.",
        args: {
          task: tool.schema
            .string()
            .describe("The task for the subagent to perform."),
          tier: tool.schema
            .string()
            .optional()
            .describe("fast | medium | heavy. Defaults to the router default tier."),
          acceptance: tool.schema
            .string()
            .optional()
            .describe(
              "Optional [acceptance]...[/acceptance] block defining the Definition of Done (check: / criteria: / deliverable: directives).",
            ),
          cwd: tool.schema
            .string()
            .optional()
            .describe(
              "Optional working directory used to VERIFY the result: relative check paths resolve against it and the grader session runs in it. It does NOT scope the producer subagent, so the task text must still tell the producer where to work.",
            ),
        },
        async execute(
          args: {
            task: string;
            tier?: string;
            acceptance?: string;
            cwd?: string;
          },
          toolCtx?: { sessionID?: string },
        ): Promise<string> {
          // Every ladder iteration creates its own producer session. Tracked out
          // here (not inside the try) so the finally below can dispose any that an
          // early return or a throw skipped — otherwise each retry leaks another.
          const producerSessions: string[] = [];
          try {
            let activeCfg = cfg;
            try {
              activeCfg = loadConfig();
            } catch {
              activeCfg = cfg;
            }
            const initialTier =
              typeof args.tier === "string" && args.tier.trim()
                ? args.tier.trim()
                : activeCfg.defaultTier || "medium";
            const dod = buildDelegationDoD({
              prompt: args.task,
              acceptance: args.acceptance,
            });

            const policy = buildEscalatePolicy(activeCfg);
            let state = newLadderState(initialTier, policy);
            const tiersForCost: any = getActiveTiers(activeCfg);

            // Independent safety net: even a policy bug cannot loop unbounded.
            const safetyMax =
              Math.max(
                policy.maxTotalAttempts,
                policy.ladder.length * (policy.maxAttemptsPerTier + 1),
              ) + 2;
            let safety = 0;

            let producerText = "";
            let forcing: string | null = null;

            /**
             * One turn of the escalation ladder: create a producer session, run
             * the task on it, put the result through the acceptance gate, then
             * tear the session down. Returns null when the backend refused to
             * create a session, the one failure the caller cannot retry.
             *
             * Split out because the loop is about when to *stop* — safety net,
             * attempt accounting, tier advancement — and a ninety-line attempt
             * in the middle of it obscured both halves.
             */
            const runProducerAttempt = async (
              tier: string,
              forcingNote: string | null,
            ): Promise<{
              sessionID: string;
              text: string;
              gateRes: Awaited<ReturnType<typeof accept>>;
            } | null> => {
              const taskText = forcingNote
                ? `${scrubText(forcingNote)}\n\n${args.task}`
                : args.task;

              const model = tierModel(activeCfg, tier) ?? undefined;
              const created: any = await (ctx.client.session.create as any)({
                body: {
                  ...(toolCtx?.sessionID ? { parentID: toolCtx.sessionID } : {}),
                  ...(model ? { model } : {}),
                  agent: `omr-${tier}`,
                },
              });
              const producerSid: string | undefined = created?.data?.id;
              if (!producerSid) return null;
              producerSessions.push(producerSid);
              // Compose with Layer 1: guard the plugin-created producer session.
              try {
                sessionStore.registerProducerSession(producerSid, tier, activeCfg);
              } catch {
                // non-fatal
              }

              let producerText = "";
              // Provider-failover vs quality-escalation precedence (Phase 3.3):
              // Provider-failover is advisory only — a text chain injected into the orchestrator
              // system prompt (buildFallbackInstructions). It is orthogonal to this runtime ladder.
              // A transport/API error here becomes an explicit failed attempt and is treated as
              // exactly ONE failed attempt by the quality-escalation ladder (no provider swap, no
              // double-counted attempt). API error => (advisory) provider failover; verification
              // FAIL => (runtime) quality escalation.
              //
              // The prompt is time-boxed: a model that never answers would
              // otherwise hang the delegate forever. A timeout is folded into
              // the same failed-attempt path as any other producer error — it
              // is never an empty artefact that a lenient DoD could pass.
              let producerError: string | null = null;
              try {
                const res: any = await withTimeout(
                  ctx.client.session.prompt({
                    path: { id: producerSid },
                    body: {
                      // The internal core keeps the legacy tier metadata for
                      // its test seam; the V2 shim strips it before calling
                      // session.prompt(), where agent/model are unsupported.
                      agent: tier,
                      parts: [{ type: "text", text: taskText }],
                    },
                  }),
                  timeoutMs(
                    activeCfg.enforcement?.verify?.delegateTimeoutMs,
                    DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
                  ),
                  "delegate producer prompt",
                );
                producerText = extractAssistantText(res);
              } catch (error) {
                producerError =
                  error instanceof Error ? error.message : String(error);
                producerText = "";
              }

              const artefact = {
                changedFiles: changedFileStore.get(producerSid),
                finalReturnText: producerText,
                declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
                producerSessionID: producerSid,
                producerTier: tier,
              };

              const gateBudgetMs = timeoutMs(
                activeCfg.enforcement?.verify?.gateBudgetMs,
                DEFAULT_GATE_BUDGET_MS,
              );
              // Grader sessions opened by THIS accept() call, and only those.
              const gateGraderSessions = new Set<string>();
              let gateRes;
              try {
                gateRes = producerError
                  ? {
                      accepted: false,
                      verdict: {
                        pass: false,
                        method: "none" as const,
                        reasons: [`producer failed: ${producerError}`],
                      },
                      dodSource: dod.source,
                    }
                  : await withTimeout(
                      accept(
                        {
                          dod,
                          trivial: false,
                          mode: "modeA",
                          ...(args.cwd ? { cwd: args.cwd } : {}),
                        },
                        artefact,
                        buildGateDeps(toolCtx?.sessionID, gateGraderSessions),
                      ),
                      gateBudgetMs,
                      "verification gate",
                    );
              } catch (error) {
                // A gate that ran out of budget is UNMET, never accepted: the
                // one thing worse than a slow verifier is a fast fabricated
                // pass. Abort any grader still in flight so the ceiling is a
                // real cancellation and not just a stopped wait.
                //
                // Scoped to THIS gate invocation's graders. The wiring-global
                // graderSessions set is shared by every concurrent delegation,
                // so aborting it here would kill a healthy grader belonging to
                // someone else's delegation — reachable with the shipped
                // config, where a deterministic check may run a command for up
                // to 120s against a 90s gate budget.
                if (error instanceof RouterTimeoutError) {
                  for (const gsid of gateGraderSessions) {
                    try {
                      await ctx.client.session.abort({ path: { id: gsid } });
                    } catch {
                      // best-effort: the gate result stands either way
                    }
                  }
                }
                gateRes = {
                  accepted: false,
                  verdict: {
                    pass: false,
                    method: "none" as const,
                    reasons: [
                      error instanceof RouterTimeoutError
                        ? `verification gate timed out after ${gateBudgetMs}ms`
                        : "verification failed (fail-closed)",
                    ],
                  },
                  dodSource: dod.source,
                };
              }

              // Per-attempt cleanup (drop producer session tracking + state).
              changedFileStore.clear(producerSid);
              try {
                sessionStore.unregister(producerSid);
              } catch {
                // non-fatal
              }
              try {
                guardStore.clear(producerSid);
              } catch {
                // non-fatal
              }
              // Dispose this attempt's backend session before the next iteration
              // so a long ladder never accumulates live sessions.
              await disposeChildSession(producerSid);

              return { sessionID: producerSid, text: producerText, gateRes };
            };

            while (true) {
              if (safety++ > safetyMax) {
                return (
                  `[router status: unmet] delegation stopped by the safety net after ` +
                  `${state.totalAttempts} attempt(s).\n\n${scrubText(producerText)}`
                );
              }
              const tier = state.currentTier;
              const attempt = await runProducerAttempt(tier, forcing);
              if (!attempt) {
                return "[router] delegate failed: could not create a producer session.";
              }
              producerText = attempt.text;
              const producerSid = attempt.sessionID;
              const gateRes = attempt.gateRes;

              const costRatio =
                typeof tiersForCost?.[tier]?.costRatio === "number"
                  ? tiersForCost[tier].costRatio
                  : 1;
              state = recordAttempt(state, costRatio);

              const action = nextAction(
                state,
                { pass: gateRes.accepted, reasons: gateRes.verdict.reasons },
                policy,
              );

              if (action.action === "accept") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  true,
                  gateRes.verdict.method,
                );
                return producerText + buildAcceptedSuffix(gateRes.verdict.method);
              }
              if (action.action === "give_up") {
                dumpDelegateScorecard(
                  producerSid,
                  state,
                  false,
                  gateRes.verdict.method,
                );
                const note = scrubText(buildForcingNote(gateRes.verdict.reasons));
                return (
                  `[router status: unmet] The delegated result was not accepted after ` +
                  `${state.totalAttempts} attempt(s) across ${state.escalations} escalation(s) ` +
                  `(final tier ${state.currentTier}; ${action.reason ?? "verification failed"}).\n\n` +
                  `${scrubText(producerText)}\n\n${note}`
                );
              }
              // retry or escalate
              forcing = action.forcingMessage ?? null;
              state = advance(state, action);
            }
          } catch {
            return "[router] delegate failed (fail-closed): the delegation or verification could not complete.";
          } finally {
            // Safety net for every exit path an end-of-iteration dispose cannot
            // reach: accept/give-up returns, the safety-net return, and throws.
            // disposeChildSession is fail-soft, so re-disposing an already
            // disposed session is harmless.
            for (const sid of producerSessions) {
              await disposeChildSession(sid);
            }
          }
        },
      }) } : {}),
    },

    // -----------------------------------------------------------------------
    // Detect subagent calls via chat.message. When the agent name matches a
    // registered tier, record the sessionID so system.transform can skip
    // delegation-protocol injection.
    //
    // IMPORTANT: must be chat.message, NOT chat.params. The opencode hook
    // order is chat.message -> system.transform -> chat.params, so populating
    // the Set in chat.params is always one step too late — system.transform
    // already ran with an empty Set and leaked the "Delegate with Task(...)"
    // instructions into the subagent's system prompt. Sonnet subagents like
    // @explore silently ignore that noise, but literal-minded Haiku (@fast)
    // emits malformed XML tool calls for the nonexistent Task tool, which
    // surface in the UI as "<parameter>...</parameter>" leakage.
    //
    // chat.message fires inside SessionPrompt.createUserMessage() BEFORE the
    // loop -> LLM.stream path, so by the time system.transform runs the Set
    // is fully populated and await-safe (yield* on the plugin trigger).
    // -----------------------------------------------------------------------
    "chat.params": async (input: any, output: any) => {
      try {
        if (input?.sessionID && graderSessions.has(input.sessionID)) {
          const graderTemperature = cfg.enforcement?.verify?.graderTemperature;
          if (graderTemperature !== undefined) {
            output.temperature = graderTemperature;
          }
        }
      } catch {
        // best-effort: never crash a real session
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (bypassed) return;
      // Re-read cfg so /preset switches take effect without restart
      try {
        cfg = loadConfig();
      } catch {}
      try {
        sweepIdleStores();
      } catch {
        // best-effort maintenance: never break a real turn
      }
      const tierNames = Object.keys(getActiveTiers(cfg));
      const sid = input?.sessionID;
      try {
        const registration = sessionStore.registerFromChatMessage(
          input,
          output,
          cfg,
          tierNames,
        );
        // A same-session same-tier re-registration is a resumed dispatch
        // (how an opencode task_id resume reaches this hook): start a new
        // per-dispatch guard round and count it in telemetry.
        if (registration.resumed === true && typeof sid === "string") {
          guardStore.beginDispatch(sid);
          trajectoryStore.recordResume(sid, input?.agent ?? null);
        }
        // KNOWN RESIDUAL: a fresh registration over an EXISTING session (same
        // sessionID, different tier) resets session cap state but leaves guard
        // state alone, so the guard keeps counting from the old dispatch. The
        // desync can only make the guard stricter, never laxer, and opencode
        // assigns one agent per subagent session — so this is documented in
        // docs/CONFIG_REFERENCE.md rather than fixed by clearing guard state,
        // which would also drop deliverable and fingerprint history.
      } catch {
        // best-effort: never crash a real session during registration
      }

      // Record-only: initialise a trajectory scorecard for tracked subagents.
      if (sid && sessionStore.isSubagent(sid)) {
        trajectoryStore.ensure(sid, input?.agent ?? null);
      }

      // Once per lifetime, warn in the plugin log when the active preset points
      // at models opencode's catalog says are missing or deprecated, or when a
      // strong-model pattern matches nothing the configured providers serve.
      // This is the whole point of the catalog: both failures are otherwise
      // silent on every subagent dispatch. Orchestrator sessions only, never
      // throws, and deferred (see startCatalogFetch): turn 1 starts the fetch,
      // a later turn reports what it found.
      if (sid && !sessionStore.isSubagent(sid)) {
        try {
          if (!catalogFetchStarted) {
            // Turn 1: kick the fetch off and move on. NO await here.
            startCatalogFetch();
          } else if (!catalogWarned && deferredCatalog !== undefined) {
            // A later turn found the turn-1 fetch already settled: report now.
            catalogWarned = true;
            const catalog = deferredCatalog;
            if (catalog) {
              // User-authored strong-model patterns matching nothing any
              // configured provider serves. Shipped defaults are never reported
              // (see findOrphanedStrongPatterns), so reaching here means the
              // user wrote a claim about this environment that is false.
              // Catalog-dependent, so it rides the same deferred path — it is
              // NOT emitted on turn 1.
              for (const p of findOrphanedStrongPatterns(cfg, catalog)) {
                logger.warn(
                  `strong-model pattern '${p}' from your modelGenerations.strong matches no model your providers serve, so it decides nothing — separator style is already ignored when matching`,
                  { pattern: p },
                );
              }
              for (const it of validateModels(cfg, catalog)) {
                const hint =
                  it.suggestions.length > 0
                    ? ` — try ${it.suggestions.join(", ")}`
                    : "";
                // Fallback issues are keyed by the chain's provider, not a tier.
                const where =
                  it.scope === "fallback"
                    ? `${it.tier}[${it.providerId}]`
                    : `@${it.tier}`;
                logger.warn(`${where} ${it.ref}: ${it.kind}${hint}`, {
                  tier: it.tier,
                  ref: it.ref,
                  kind: it.kind,
                  suggestions: it.suggestions,
                });
              }
            }
          }
        } catch {
          // best-effort: never disrupt a real session
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hard-block enforcement (Layer 1). Fires before tool execution; only
    // engaged for subagent sessions when enforcement mode is advisory/enforced.
    // Throws to abort the tool call when a guard fires; never throws for
    // non-subagent sessions or when enforcement is off (GA-1 preserved).
    // -----------------------------------------------------------------------
    "tool.execute.before": async (input: any, output: any) => {
      if (bypassed) return;
      const sid = input?.sessionID;
      if (!sid || !sessionStore.isSubagent(sid) || typeof input?.tool !== "string") {
        return;
      }
      // Start-of-call refresh: the idle TTL must cover the tool's runtime, not
      // just the moment it finished.
      sessionStore.touchIfTracked(sid);
      let res;
      try {
        res = guardBeforeCall({
          cfg,
          tier: sessionStore.getTier(sid),
          trivial: sessionStore.isTrivial(sid),
          sessionID: sid,
          tool: input.tool,
          toolArgs: output?.args,
          store: guardStore,
          env: process.env,
        });
      } catch {
        return; // never break a real session on a guard-internal error
      }
      if (res.block) {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
          blocked: true,
          selfScript: res.guard === "anti_self_script",
        });
        throw new Error(res.message);
      }
    },

    // -----------------------------------------------------------------------
    // Runtime cap + redundancy enforcement (subagents only).
    // Appends `[cap: N/MAX]` and `[⚠ REDUNDANT]` / `[⚠ CAP REACHED]` banners
    // to every read-only tool result the subagent sees. Because these land
    // inside `output.output` — the tool's own response text — the model
    // treats them as ground truth rather than advisory system noise.
    // -----------------------------------------------------------------------
    "tool.execute.after": async (input: any, output: any) => {
      if (bypassed) return;
      sessionStore.recordToolCall(input, output);

      // Record-only trajectory observation (mutates internal maps only; never
      // touches output, so emitted banners/observations stay byte-identical).
      const sid = input?.sessionID;

      // Attribute changed files to whichever session made the edit (any session).
      if (sid && typeof input?.tool === "string") {
        changedFileStore.record(sid, input.tool, input?.args);
      }

      if (sid && sessionStore.isSubagent(sid) && typeof input?.tool === "string") {
        trajectoryStore.recordToolEvent(sid, {
          tool: input.tool,
          readOnly: READ_ONLY_TOOLS.has(input.tool),
        });
        try {
          guardAfterCall({
            cfg,
            tier: sessionStore.getTier(sid),
            sessionID: sid,
            tool: input.tool,
            toolArgs: input?.args,
            output,
            store: guardStore,
          });
        } catch {
          // best-effort: enforcement must never crash a real session
        }
      }

      // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
      // we observe the finished task result and append a forcing note if it is not
      // accepted; we cannot retry a task call that already finished).
      if (typeof input?.tool === "string") {
        let mode = "off";
        try {
          mode = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
        } catch {
          // fall through with mode "off"
        }
        const requireMode = cfg.enforcement?.verify?.require;
        if (shouldVerifyTask(input.tool, mode, requireMode)) {
          try {
            const { finalReturnText, childSessionID } = parseTaskResult(output);
            const producerTier =
              typeof input?.args?.subagent_type === "string"
                ? input.args.subagent_type
                : "";
            const dod = buildDelegationDoD({
              prompt: input?.args?.prompt,
              description: input?.args?.description,
            });
            const artefact = {
              changedFiles: childSessionID
                ? changedFileStore.get(childSessionID)
                : [],
              finalReturnText,
              declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
              producerSessionID: childSessionID ?? "",
              producerTier,
            };
            const trivial = childSessionID
              ? sessionStore.isTrivial(childSessionID)
              : false;

            // Read-only / research delegation: an auto-inferred, criteria-only DoD on a
            // native Task() that changed no files is exploration, not implementation.
            // There is nothing concrete to verify, so skip rather than grade the
            // findings against the task's own summary, which otherwise appends false
            // "not accepted" notes to legitimate read-only research delegations.
            // Explicit [acceptance] blocks (source != "inferred") and inferred
            // deterministic checks (dod.kind === "deterministic") still verify normally.
            if (
              dod.source === "inferred" &&
              dod.kind === "checker" &&
              artefact.changedFiles.length === 0
            ) {
              if (childSessionID) changedFileStore.clear(childSessionID);
              return;
            }

            const res = await accept(
              {
                dod,
                trivial,
                mode: "modeA",
                // The built-in task tool declares no cwd of its own, but if a
                // caller supplies one it scopes verification the same way the
                // delegate tool's does.
                ...(typeof input?.args?.cwd === "string" && input.args.cwd
                  ? { cwd: input.args.cwd }
                  : {}),
              },
              artefact,
              buildGateDeps(),
            );
            if (!res.accepted && !res.verdict.skipped) {
              const ladder = cfg.enforcement?.escalate?.ladder ?? ["fast", "medium", "heavy"];
              const li = ladder.indexOf(producerTier);
              const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
              const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
              output.output =
                typeof output.output === "string"
                  ? output.output + "\n\n" + note
                  : note;
            }
            if (childSessionID) changedFileStore.clear(childSessionID);
          } catch {
            // fail-closed: a verification error must NEVER throw out of the after-hook
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // Narration detector — flags progress-commentary-without-production.
    //
    // Fires per completed text part. Scans for narration patterns; if any
    // match, logs a warning to the plugin console and appends a visible
    // banner to the text so the user sees the detection in the UI. This is
    // telemetry, not blocking — we cannot modify mid-stream generation, only
    // post-hoc signal.
    // -----------------------------------------------------------------------
    "experimental.text.complete": async (input: any, output: any) => {
      if (bypassed || !cfg.antiNarration) return;
      const text = output?.text;
      if (typeof text !== "string" || text.length < 20) return;

      const found = detectNarration(text);
      if (found.length === 0) return;

      const quoted = found
        .map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`)
        .join(", ");
      output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
    },

    // -----------------------------------------------------------------------
    // Gated trajectory debug dump (Phase 0.3, T0.3.3) — RECORD-ONLY, OPT-IN.
    // No-op unless MODEL_ROUTER_TRAJECTORY_DEBUG=1. On session.idle, writes the
    // session's trajectory scorecard to a throwaway file under the OS temp dir
    // for manual inspection. Best-effort; never throws into the session.
    // Emits nothing model-visible, so GA-1 (no-regression) is preserved.
    // -----------------------------------------------------------------------
    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return;
      const sid = event?.properties?.sessionID;
      if (typeof sid !== "string") return;

      // Per-delegation scorecard: only when enforcement was active (guard state exists).
      try {
        const gstate = guardStore.get(sid);
        if (gstate) {
          const line = formatScorecard(gstate, sessionStore.getTier(sid));
          const dir = join(tmpdir(), "opencode-model-router-trajectory");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${sid}.scorecard.log`), line + "\n", { flag: "a" });
        }
      } catch {
        // best-effort: a scorecard must never crash a real session
      }

      // Opt-in full trajectory dump (unchanged gating).
      if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
      const dump = trajectoryStore.dump(sid);
      if (!dump) return;
      try {
        const dir = join(tmpdir(), "opencode-model-router-trajectory");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${sid}.log`), dump + "\n", { flag: "a" });
      } catch {
        // best-effort
      }
    },

    // -----------------------------------------------------------------------
    // Register tier agents + commands at load time
    // -----------------------------------------------------------------------
    config: async (opencodeConfig: any) => {
      opencodeConfig.agent ??= {};

      for (const [name, tier] of Object.entries(activeTiers)) {
        // Resolve prompt: per-tier override wins; otherwise fall back to the
        // style-appropriate default (goal-oriented or global tierPrompts[name]).
        const resolvedPrompt = tier.prompt ?? selectTierPrompt(name, tier, cfg);

        // For Claude-backed tiers, prepend an adversarial opener that revokes
        // the cached "Claude Code exploratory agent" priming for this dispatch.
        // Detection is by model string, so hybrid presets get the override
        // only on their Claude-backed tiers.
        const claudePrefix = isClaudeModel(tier.model)
          ? cfg.antiNarration
            ? `${CLAUDE_TIER_PREFIX[name]}\n\n${CLAUDE_ANTI_NARRATION}`
            : CLAUDE_TIER_PREFIX[name]
          : undefined;
        const finalPrompt =
          claudePrefix && resolvedPrompt
            ? `${claudePrefix}\n\n---\n\n${resolvedPrompt}`
            : resolvedPrompt;

        const agentDef: Record<string, unknown> = {
          model: tier.model,
          mode: "subagent",
          description: tier.description ?? `@${name} tier (${tier.model})`,
          maxSteps: tier.steps,
          prompt: finalPrompt,
          color: tier.color,
        };

        // Apply variant (thinking/reasoning mode)
        if (tier.variant) {
          agentDef.variant = tier.variant;
        }

        // Apply provider-specific options
        const opts = buildAgentOptions(tier, name, logger);
        if (Object.keys(opts).length > 0) {
          agentDef.options = opts;
        }
        if (typeof opts.effort === "string") {
          warnAgentOptionsEffortOnce(
            "anthropic-effort-dependency",
            "effort on Anthropic models requires the opencode-anthropic-fix plugin (commit 307aea9+ for fable/mythos); non-adaptive Claude models (e.g. haiku) silently strip effort at the API layer, and without the plugin a top-level effort can break Claude-Code billing fingerprinting",
            logger,
          );
        }

        opencodeConfig.agent[name] = agentDef;
      }

      // Repoint pre-existing subagents listed in `subagentTiers` at the active
      // preset's models. Opt-in: with no map, nothing here runs and the agent
      // record is left exactly as opencode built it. Runs after tier
      // registration so the tier-name collision guard sees the real tiers.
      const subagentOverrides = resolveSubagentOverrides({
        subagentTiers: cfg.subagentTiers,
        tiers: activeTiers,
        existingAgents: opencodeConfig.agent,
      });
      for (const [agentName, override] of Object.entries(subagentOverrides)) {
        opencodeConfig.agent[agentName] = mergeSubagentOverride(
          opencodeConfig.agent[agentName],
          override,
        );
      }

      // Register commands
      opencodeConfig.command ??= {};
      opencodeConfig.command["tiers"] = {
        template: "",
        description: "Show model delegation tiers and rules",
      };
      opencodeConfig.command["preset"] = {
        template: "$ARGUMENTS",
        description: "Show or switch model presets (e.g., /preset openai)",
      };
      opencodeConfig.command["budget"] = {
        template: "$ARGUMENTS",
        description:
          "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
      };
      opencodeConfig.command["bypass"] = {
        template: "$ARGUMENTS",
        description:
          "Toggle model-router bypass (disables delegation protocol for this session)",
      };
      opencodeConfig.command["annotate-plan"] = {
        template: [
          "Annotate the plan with tier directives for model delegation.",
          "",
          'Plan file: "$ARGUMENTS"',
          "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
          "",
          "## Available tiers",
          "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
          "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
          "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
          "",
          "## Annotation rules",
          "1. Place `[tier:X]` at the START of each step, before the description",
          "2. Research/exploration -> `[tier:fast]` (preferred)",
          "3. Implementation/code -> `[tier:medium]` (preferred)",
          "4. Architecture/security/hard debugging -> `[tier:heavy]`",
          "5. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
          "6. Verification (run tests, build) -> `[tier:medium]`",
          "7. Trivial (single grep or file read) -> `[tier:fast]`",
          "8. Final review of the complete plan -> `[tier:heavy]`",
          "",
          "## Output",
          "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
          "",
          "## Acceptance blocks (for enforcement)",
          "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
          "[acceptance]",
          "check: <testsPass | buildPasses | lintClean | fileExists path=... | run command=\"...\" expect=...>",
          "criteria: <plain-language success condition, when no deterministic check applies>",
          "deliverable: <path or short description>",
          "[/acceptance]",
          "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
        ].join("\n"),
        description:
          "Annotate a plan with [tier:fast/medium/heavy] delegation tags",
      };
      opencodeConfig.command["router"] = {
        template: "$ARGUMENTS",
        description:
          "Model-router controls (e.g., /router enforce off|advisory|enforced, /router overrides, /router models)",
      };
    },

    // -----------------------------------------------------------------------
    // Inject delegation protocol — uses cached config (invalidated on /preset or /budget)
    // Only inject for the primary orchestrator, NOT for subagent calls.
    // Subagents get confused by delegation instructions when they should
    // just execute a task (especially smaller models like Haiku).
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input: any, output: any) => {
      if (bypassed) return;
      try {
        cfg = loadConfig(); // Returns cache unless invalidated
      } catch {
        // Use last known config if file read fails
      }

      // Skip injection for child (subagent) sessions.
      // Child sessions are detected via session.created events with a parentID.
      const sessionID = _input?.sessionID;
      if (sessionID && sessionStore.isSubagent(sessionID)) return;

      // For Claude-backed orchestrators, prepend an adversarial opener that
      // revokes the cached "Claude Code explorer" priming for the routing
      // role. Detection is by orchestrator model, not preset.
      const providerID = _input?.model?.providerID ?? "";
      const modelID = _input?.model?.modelID ?? "";
      const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

      let enfOn = false;
      try { enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off"; } catch {}
      output.system.push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
    },

    // -----------------------------------------------------------------------
    // Handle /tiers, /preset, and /budget commands
    // -----------------------------------------------------------------------
    "command.execute.before": async (input: any, output: any) => {
      if (input.command === "tiers") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildTiersOutput(cfg),
        });
      }

      if (input.command === "preset") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildPresetOutput(cfg, input.arguments ?? ""),
        });
      }

      if (input.command === "bypass") {
        const arg = (input.arguments ?? "").trim().toLowerCase();
        if (arg === "on") {
          bypassed = true;
        } else if (arg === "off") {
          bypassed = false;
        } else {
          bypassed = !bypassed;
        }
        output.parts.push({
          type: "text" as const,
          text: buildBypassMessage(bypassed),
        });
      }

      if (input.command === "budget") {
        try {
          cfg = loadConfig();
        } catch {}
        output.parts.push({
          type: "text" as const,
          text: buildBudgetOutput(cfg, input.arguments ?? ""),
        });
      }

      if (input.command === "router") {
        try {
          cfg = loadConfig();
        } catch {}
        const args = (input.arguments ?? "").trim();
        const parts = args.split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        let text: string;
        if (sub === "models") {
          const catalog = await fetchCatalog();
          const orphans = catalog ? findOrphanedStrongPatterns(cfg, catalog) : [];
          text = buildModelsOutput(catalog, parts.slice(1).join(" "), orphans);
        } else {
          text = buildRouterOutput(cfg, args);
          // On the bare status view, surface stale or missing models inline.
          if (sub === "") {
            const catalog = await fetchCatalog();
            if (catalog) {
              const issues = validateModels(cfg, catalog);
              if (issues.length > 0) {
                text += "\n\n" + formatModelIssues(issues);
              }
            }
          }
        }
        output.parts.push({ type: "text" as const, text });
      }
    },
  };
};

// Internal compatibility seam for the existing core test suite. This is not
// part of the default V2 plugin export and is never discovered by OpenCode.
export const ModelRouterPluginV1 = ModelRouterPlugin;


/**
 * Convert a V1-style agent definition (what the `config` hook builds for tier
 * agents) into the V2 `Agent.Info` shape served by opencode >= 2.0
 * (GET /openapi.json → components.schemas["Agent.Info"]).
 *
 * Mapping:
 *  - `model: "provider/model"` string → `Model.Ref` `{ providerID, id }`. A
 *    `#variant` suffix on the string or a top-level `variant` becomes
 *    `Model.Ref.variant`. Passing the V1 string through verbatim makes the
 *    server reject the whole /api/agent response encoding ("Expected
 *    Model.Ref | undefined at data[N].model") and every agent-list call 400s.
 *  - `maxSteps` → `steps`
 *  - `prompt` → `system`
 *  - `options` (raw provider body fields like `reasoning_effort`,
 *    `budget_tokens`) → `request.body`
 *  - Required Agent.Info fields (`id`, `name`, `request`, `mode`, `hidden`,
 *    `permissions`) are filled in. Agent.Info is additionalProperties:false,
 *    so V1-only keys (`variant`, `maxSteps`, `prompt`, `options`) must be
 *    dropped rather than passed through.
 */
function toV2AgentInfo(name: string, def: any): any {
  const info: any = {
    id: name,
    name,
    mode: def?.mode ?? "subagent",
    hidden: def?.hidden ?? false,
    permissions: Array.isArray(def?.permissions) ? def.permissions : [],
    request: {
      settings: {},
      headers: {},
      body: { ...(def?.options ?? {}) },
    },
  };
  if (typeof def?.model === "string" && def.model.includes("/")) {
    const slash = def.model.indexOf("/");
    const providerID = def.model.slice(0, slash);
    let id = def.model.slice(slash + 1);
    let variant: string | undefined =
      typeof def.variant === "string" && def.variant ? def.variant : undefined;
    const hash = id.indexOf("#");
    if (hash >= 0) {
      variant = variant ?? id.slice(hash + 1);
      id = id.slice(0, hash);
    }
    info.model = variant ? { providerID, id, variant } : { providerID, id };
  }
  if (typeof def?.description === "string") info.description = def.description;
  if (typeof def?.prompt === "string") info.system = def.prompt;
  if (typeof def?.color === "string") info.color = def.color;
  const steps = def?.maxSteps ?? def?.steps;
  if (typeof steps === "number" && steps > 0) info.steps = steps;
  return info;
}

const OMR_AGENT_BEGIN = "<!-- BEGIN opencode-model-router managed -->";
const OMR_AGENT_END = "<!-- END opencode-model-router managed -->";
const OMR_AGENT_MARKER = "managedBy: opencode-model-router";

function managedTierAgent(name: string, def: any): string {
  const description = String(def?.description ?? `@${name} router tier`)
    .replaceAll("\n", " ")
    .replaceAll("\"", "'");
  const prompt = typeof def?.prompt === "string" ? def.prompt.trim() : "";
  const steps = typeof def?.maxSteps === "number" ? `steps: ${def.maxSteps}\n` : "";
  return [
    OMR_AGENT_BEGIN,
    "---",
    `name: omr-${name}`,
    `description: "${description}"`,
    "mode: subagent",
    steps ? `${steps.trimEnd()}` : "",
    OMR_AGENT_MARKER,
    "---",
    prompt,
    OMR_AGENT_END,
    "",
  ].filter(Boolean).join("\n");
}

/** Create/update only router-owned global agents; never overwrite user files. */
function syncGlobalTierAgents(
  defs: Record<string, any>,
  warn: (message: string) => void,
): Set<string> {
  const directory = join(homedir(), ".config", "opencode", "agents");
  mkdirSync(directory, { recursive: true });
  const available = new Set<string>();
  for (const [name, def] of Object.entries(defs)) {
    const file = join(directory, `omr-${name}.md`);
    const content = managedTierAgent(name, def);
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8");
      if (!existing.includes(OMR_AGENT_MARKER)) {
        warn(`global agent collision: preserving ${file}; tier ${name} is disabled`);
        continue;
      }
      const start = existing.indexOf(OMR_AGENT_BEGIN);
      const end = existing.indexOf(OMR_AGENT_END);
      if (start >= 0 && end >= start) {
        writeFileSync(file, `${existing.slice(0, start)}${content}${existing.slice(end + OMR_AGENT_END.length)}`);
      } else {
        warn(`router-managed agent ${file} has an invalid managed section; tier ${name} is disabled`);
        continue;
      }
    } else {
      writeFileSync(file, content);
    }
    available.add(name);
  }
  return available;
}

// ---------------------------------------------------------------------------
// OpenCode V2 plugin definition.
//
// V2 loaders round-trip the default export through a schema that requires an
// object with `id` and a `setup(ctx)` function, and V1 hook objects do not run
// in V2 (docs/opencode migrate-v1: "V1 plugin implementations do not run in
// V2"). The V1 factory above is left intact and all of its returned hooks are
// re-registered through the V2 plugin context below, with shape adapters at
// each seam.
//
// Confidence notes (ported from the 1.10.0 local patch — verify behaviors live
// before trusting):
//  - ctx.session.hook("context")  → system-prompt injection + grader temp
//  - ctx.session.hook("prompt")   → subagent session registration/caps
//  - ctx.tool.hook                → guard + cap banners
//  - ctx.agent/command.transform  → tier agents + commands
//  - experimental.text.complete has NO V2 hook (dropped; feature is opt-in/off)
// ---------------------------------------------------------------------------
const V2Plugin = {
  id: "opencode-model-router",
  async setup(ctx2: any): Promise<(() => void) | undefined> {
    const availableTierAgents = new Set<string>();
    const safe = async (label: string, fn: () => unknown | Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        console.warn(`[model-router] ${label} registration failed:`, e);
      }
    };

    // ---- V1 PluginInput shim built over the V2 context --------------------
    const shimClient = {
      app: {
        log: async (p: any) => {
          try {
            console.log(`[model-router] ${p?.body?.level ?? "info"}: ${p?.body?.message ?? ""}`);
          } catch {}
        },
      },
      config: {
        providers: async () => {
          try {
            const res: any =
              (typeof (ctx2.provider?.list === "function")
                ? await ctx2.provider.list()
                : null) ?? (typeof ctx2.model?.list === "function"
                ? await ctx2.model.list()
                : null);
            return { data: res };
          } catch (e) {
            return { data: null, ...(e as object) };
          }
        },
      },
      session: {
        create: async (a: any) => {
          try {
            const body = a?.body ?? {};
            const s: any = await ctx2.session.create({
              ...(body.parentID ? { parentID: body.parentID } : {}),
              ...(body.agent && availableTierAgents.has(String(body.agent).replace(/^omr-/, ""))
                ? { agent: body.agent }
                : {}),
              ...(body.model ? { model: body.model } : {}),
            });
            return { data: { id: s?.id ?? s?.sessionID ?? "" } };
          } catch {
            return { data: undefined };
          }
        },
        prompt: async (p: any) => {
          try {
            const parts = p?.body?.parts ?? [];
            const text = parts
              .map((x: any) => (typeof x === "string" ? x : (x?.text ?? "")))
              .join("\n");
            return await ctx2.session.prompt({
              sessionID: p?.path?.id,
              text,
            } as never);
          } catch (e) {
            return { error: e };
          }
        },
        abort: async (p: any) => {
          try {
            await ctx2.session.interrupt({ sessionID: p?.path?.id });
          } catch {}
        },
        delete: async (p: any) => {
          try {
            await (ctx2.session as any).delete?.({ sessionID: p?.path?.id });
          } catch {}
        },
      },
    };

    let hooks: Record<string, any>;
    try {
      hooks = (await ModelRouterPlugin({
        client: shimClient,
        directory: ctx2.location?.directory ?? process.cwd(),
        project: ctx2.location?.project ?? {},
        options: ctx2.options,
      } as never)) as Record<string, any>;
    } catch (e) {
      console.warn("[model-router] failed to initialise V1 core in V2 setup:", e);
      return;
    }

    // ---- system prompt + grader temperature (chat.params + system.transform)
    await safe("context-hook", () =>
      ctx2.session.hook("context", async (event: any) => {
        try {
          const pOut: any = { temperature: undefined };
          await hooks["chat.params"]({ sessionID: event?.sessionID }, pOut);
          if (pOut.temperature !== undefined && event?.options) {
            event.options.temperature = pOut.temperature;
          }
          const sOut: any = { system: [] };
          await hooks["experimental.chat.system.transform"](
            {
              sessionID: event?.sessionID,
              model: event?.model,
            },
            sOut,
          );
          if (Array.isArray(event?.system) && Array.isArray(sOut.system)) {
            // ChatParams/system-transform push string prompts in V1; V2 wants {type,text}
            for (const s of sOut.system) {
              if (typeof s === "string") event.system.push({ type: "text" as const, text: s });
              else if (s && typeof s === "object" && typeof (s as any).text === "string") {
                event.system.push({ type: "text" as const, text: (s as any).text });
              }
            }
          }
        } catch {}
      }),
    );

    // ---- subagent dispatch registration (chat.message) ---------------------
    await safe("prompt-hook", () =>
      ctx2.session.hook("prompt", async (event: any) => {
        try {
          const agentName =
            (event as any)?.agent ??
            (event as any)?.agentName ??
            ((event as any)?.agents?.[0] ?? undefined);
          const dispatchText = event?.prompt?.text ?? "";
          await hooks["chat.message"](
            { sessionID: event?.sessionID, agent: agentName },
            {
              parts: [{ type: "text", text: dispatchText }],
              prompt: event?.prompt,
              metadata: event?.metadata,
            },
          );
        } catch {}
      }),
    );

    // ---- guard before / cap banners after ----------------------------------
    await safe("tool-hooks", () => ctx2.tool.hook("execute.before", async (event: any) => {
      try {
        await hooks["tool.execute.before"](
          { sessionID: event?.sessionID, tool: event?.tool, args: event?.input },
          { args: event?.input },
        );
      } catch (e) {
        throw e; // before-hook throws are the intended hard-block mechanism
      }
    }));
    await safe("tool-after-hook", () =>
      ctx2.tool.hook("execute.after", async (event: any) => {
        const original: unknown = event?.output ?? event?.result;
        const outRef: any = {
          output: original,
          input: event?.input,
        };
        await hooks["tool.execute.after"](
          { sessionID: event?.sessionID, tool: event?.tool, args: event?.input },
          outRef,
        );
        if (outRef.output !== undefined && outRef.output !== original && event) {
          if ("output" in event) (event as any).output = outRef.output;
          else if ("result" in event) {
            if (typeof event.result === "string") (event as any).result = outRef.output;
            else if (event.result && typeof event.result === "object") {
              (event.result as any).text = outRef.output;
            }
          }
        }
      }),
    );

    // V2 tools are registered through the tool transform. The V1 core still
    // owns the delegation implementation, but the public registration uses
    // the native V2 JSON-schema/result contract.
    const delegateTool = hooks.tool?.delegate;
    if (delegateTool && typeof ctx2.tool?.transform === "function") {
      await safe("delegate-tool", () =>
        ctx2.tool.transform((editor: any) => {
          editor.add({
            name: "delegate",
            description: String(delegateTool.description ?? "Delegate a task to a router tier."),
            input: {
              type: "object",
              properties: {
                task: { type: "string", description: "The task for the subagent." },
                tier: { type: "string", enum: ["fast", "medium", "heavy"] },
                acceptance: { type: "string" },
                cwd: { type: "string" },
              },
              required: ["task"],
              additionalProperties: false,
            },
            execute: async (input: any, toolContext: any) => ({
              content: await delegateTool.execute(input, { sessionID: toolContext.sessionID }),
            }),
          });
        }),
      );
    }

    // ---- agents + commands registration (V1 `config` hook + command shim) --
    const fakeConfig: any = { agent: {}, command: {} };
    try {
      await hooks.config(fakeConfig);
    } catch (e) {
      console.warn("[model-router] config registration failed:", e);
    }
    const tierDefinitions = Object.fromEntries(
      ["fast", "medium", "heavy"]
        .filter((name) => fakeConfig.agent?.[name])
        .map((name) => [name, fakeConfig.agent[name]]),
    );
    const generatedTierAgents = syncGlobalTierAgents(
      tierDefinitions,
      (message) => console.warn(`[model-router] ${message}`),
    );
    for (const name of generatedTierAgents) availableTierAgents.add(name);
    await safe("agent-transform", () =>
      ctx2.agent.transform(async (ed: any) => {
        for (const [name, def] of Object.entries(fakeConfig.agent ?? {})) {
          try {
            if (generatedTierAgents.has(name)) continue;
            // Agent.Info is additionalProperties:false and model must be a
            // Model.Ref object — never hand the raw V1 def to the editor.
            const info = toV2AgentInfo(name, def);
            if (typeof ed.add === "function") ed.add(name, info as never);
            else if (typeof ed.update === "function") {
              // V2 AgentEditor.update takes a mutation callback over an
              // existing agent; merge the converted tier def in, keeping the
              // existing agent's request settings/headers and permissions.
              ed.update(name, (agent: any) => {
                if (!agent || typeof agent !== "object")
                  throw new Error(`agent "${name}" does not exist to update`);
                info.request = {
                  settings: agent.request?.settings ?? {},
                  headers: agent.request?.headers ?? {},
                  body: { ...(agent.request?.body ?? {}), ...info.request.body },
                };
                if (Array.isArray(agent.permissions) && agent.permissions.length > 0)
                  info.permissions = agent.permissions;
                Object.assign(agent, info);
              });
            }
          } catch (e) {
            console.warn(`[model-router] agent "${name}" registration failed:`, e);
          }
        }
      }),
    );
    if (typeof ctx2.agent?.reload === "function") {
      await ctx2.agent.reload();
    }
    try {
      await ctx2.command.transform((ed: any) => {
        for (const [name, defC] of Object.entries(fakeConfig.command ?? {}) as [string, any][]) {
          ed.add({
            name,
            description: String(defC?.description ?? ""),
            execute: async ({ sessionID, prompt }: any) => {
              const args = (prompt?.text ?? "").trim();
              if (name === "annotate-plan") {
                const template = String((defC?.template as string) ?? "");
                try {
                  await ctx2.session.prompt({
                    sessionID,
                    text: template.replace("$ARGUMENTS", args),
                    delivery: "queue",
                  } as never);
                } catch {}
                return;
              }
              // Informational commands: mirror V1 command.execute.before by
              // routing its part-building body, then surface as a synthetic
              // message instead of pushed user-message parts.
              try {
                const out: any = { parts: [] };
                await hooks["command.execute.before"]({ command: name, arguments: args }, out);
                const text = (out?.parts ?? [])
                  .map((part: unknown) =>
                    typeof part === "string" ? part : (part as any)?.text ?? "",
                  )
                  .filter(Boolean)
                  .join("\n");
                if (text && typeof ctx2.session?.synthetic === "function") {
                  await ctx2.session.synthetic({ sessionID, text });
                } else if (text) {
                  console.log(`[model-router] /${name}\n${text}`);
                }
              } catch {}
            },
          });
        }
      });
    } catch (e) {
      console.warn("[model-router] command transform failed:", e);
    }

    // ---- session.idle scorecards via the public event stream ---------------
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const ev of ctx2.event.subscribe({ signal: controller.signal })) {
          if ((ev as any)?.type === "session.idle") {
            void hooks.event({ event: ev });
          }
        }
      } catch {}
    })();

    return () => {
      controller.abort();
      try {
        void hooks.dispose?.();
      } catch {}
    };
  },
};

export default {
  id: V2Plugin.id,
  setup: V2Plugin.setup,
};
