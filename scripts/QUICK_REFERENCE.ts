/**
 * QUICK REFERENCE: Custom Slash Commands in OpenCode Plugins
 * 
 * Source: D:\git\opencode-model-router\src\index.ts
 * Reference Documentation: COMMAND_PATTERNS.md
 */

// ============================================================================
// 1. COMMAND REGISTRATION (native V2 command transform)
// ============================================================================

const registerCommands = async (ctx: Plugin.Context) => {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "preset",
      description: "Show or switch model presets",
      execute: async ({ sessionID, prompt }) => {
        await ctx.session.synthetic({ sessionID, text: `Arguments: ${prompt.text}` });
      },
    });
  });
};

// ============================================================================
// 2. COMMAND HANDLER (native V2 command executor)
// ============================================================================

// Command invocations receive `{ sessionID, prompt, delivery }`; return
// results through `ctx.session.synthetic` when a command is informational.

// ============================================================================
// 3. ARGUMENT PARSING PATTERN
// ============================================================================

// Lines 443-481 in src/index.ts
function buildBudgetOutput(cfg: RouterConfig, args: string): string {
  const requested = args.trim().toLowerCase();  // Normalize

  // Empty args: show help/current state
  if (!requested) {
    return ["# Current State", "...", `Usage: /budget <mode>`].join("\n");
  }

  // Validate input
  if (!cfg.modes?.[requested]) {
    return `Unknown mode: "${requested}". Available: ${Object.keys(cfg.modes || {}).join(", ")}`;
  }

  // Process valid input
  saveActiveMode(requested);
  return `Switched to mode: ${requested}`;
}

// ============================================================================
// 4. STATE PERSISTENCE & CACHE INVALIDATION
// ============================================================================

// Lines 66-73 (cache), 227-232 (persistence), 234-248 (save & invalidate)
let _cachedConfig: RouterConfig | null = null;
let _configDirty = true;

function invalidateConfigCache(): void {
  _configDirty = true;
}

function loadConfig(): RouterConfig {
  // Return cached version if valid
  if (_cachedConfig && !_configDirty) {
    return _cachedConfig;
  }
  // Otherwise reload from disk
  const raw = JSON.parse(readFileSync(configPath(), "utf-8"));
  _cachedConfig = validateConfig(raw);
  _configDirty = false;
  return _cachedConfig;
}

function saveActivePreset(presetName: string): void {
  const cfg = loadConfig();
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) return;

  cfg.activePreset = resolved;

  // Persist to state file (separate from tiers.json)
  writeState({ activePreset: resolved });

  // Force cache invalidation so next loadConfig() re-reads
  invalidateConfigCache();
}

function writeState(patch: Partial<RouterState>): void {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

// ============================================================================
// 5. SYSTEM PROMPT INJECTION (every message)
// ============================================================================

const systemPromptInjection = async (ctx: Plugin.Context) => {
  await ctx.session.hook("context", (_event: any) => {
    try {
      cfg = loadConfig();  // Uses cache (invalidated by /preset, /budget)
    } catch {
      // Gracefully use last known config on error
    }

    // V2 context events contain structured system text parts.
    const protocolText = buildDelegationProtocol(cfg);
    _event.system.push({ type: "text", text: protocolText });
  });
};

// ============================================================================
// 6. USER FEEDBACK FORMAT (Markdown)
// ============================================================================

// Lines 513-521 in src/index.ts
function buildPresetOutput(cfg: RouterConfig, args: string): string {
  if (!args) {
    // Show available options
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      lines.push(`- **${name}**${active}: ${description}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolved = resolvePresetName(cfg, args);
  if (resolved) {
    saveActivePreset(resolved);
    return [
      `Preset switched to **${resolved}**.`,  // Bold markdown
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-model-router.state.json.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${args}". Available: ${Object.keys(cfg.presets).join(", ")}`;
}

// ============================================================================
// 7. COMPLETE MINIMAL EXAMPLE
// ============================================================================

import type { Plugin } from "@opencode/plugin";

const MinimalPlugin: Plugin.Plugin = {
  id: "minimal-plugin",
  setup: async (ctx) => {
  let state = { mode: "normal" };

  await ctx.command.transform((editor) => {
    editor.add({
      name: "mycommand",
      description: "Show or change the current mode",
      execute: async ({ prompt, sessionID }) => {
        const args = (prompt?.text ?? "").trim();

        if (!args) {
          await ctx.session.synthetic({ sessionID, text: `Current mode: ${state.mode}\nUsage: /mycommand <mode>` });
          return;
        }

        if (!["normal", "fast", "slow"].includes(args)) {
          await ctx.session.synthetic({ sessionID, text: "Unknown mode. Available: normal, fast, slow" });
          return;
        }

        state.mode = args;
        await ctx.session.synthetic({ sessionID, text: `Mode changed to: **${args}**` });
      },
    });
  });
};

// ============================================================================
// KEY TAKEAWAYS
// ============================================================================
/*
1. REGISTER: ctx.command.transform(editor => editor.add({ name, description, execute }))
   - Commands receive `{ sessionID, prompt }`; read arguments from `prompt.text`.

2. HANDLE: use `ctx.session.synthetic({ sessionID, text })` for user-visible output.
   
3. PARSE ARGS: Trim, normalize, validate, provide helpful errors
   
4. PERSIST STATE: Use separate state file, cache config with invalidation
   
5. INJECT SYSTEM: Use `ctx.session.hook("context", handler)` to modify the V2 event.
   
6. USER FEEDBACK: Markdown format (bold **text**, code `text`, bullets -), no tui.showToast
*/
