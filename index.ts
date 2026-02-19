/**
 * MUST-have-plugin (Replacer Plugin)
 *
 * Performs case-insensitive string replacements on user-typed prompts
 * before they're sent to the LLM.
 *
 * Config: ~/.config/opencode/MUST-have-plugin.jsonc (JSONC format)
 * Logs: ~/.local/share/opencode/log/dev.log (filter by service=MUST-have-plugin)
 *
 * Features:
 * - Case-insensitive matching with word boundaries
 * - Multi-word phrase support (longest-first matching)
 * - Hot reload: config re-read on every message
 * - Auto-generates RFC2119 defaults if no config exists
 * - JSONC support (comments and trailing commas allowed in config)
 *
 * Scope:
 * - Only replaces in user-typed prompts
 * - Does NOT modify file content attached via @ mentions
 * - Does NOT modify slash command output
 */
import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve } from "path"

const CONFIG_PATH = resolve(process.env.HOME || "", ".config", "opencode", "MUST-have-plugin.jsonc")
const SERVICE_NAME = "MUST-have-plugin"

// Track debug state (loaded from config)
let debugEnabled = false

// SDK client reference for logging (set during plugin init)
let sdkClient: Parameters<Plugin>[0]["client"] | null = null

// Track sessions that just executed a slash command (to skip replacement)
const sessionsWithCommand = new Set<string>()

/**
 * RFC2119 default replacements
 * These keywords are used in technical specifications to indicate requirement levels.
 * See: https://datatracker.ietf.org/doc/html/rfc2119
 */
const RFC2119_DEFAULTS: Record<string, string> = {
  "must": "MUST",
  "must not": "MUST NOT",
  "required": "REQUIRED",
  "shall": "SHALL",
  "shall not": "SHALL NOT",
  "should": "SHOULD",
  "should not": "SHOULD NOT",
  "recommended": "RECOMMENDED",
  "not recommended": "NOT RECOMMENDED",
  "may": "MAY",
  "optional": "OPTIONAL",
}

/**
 * Default config file content (JSONC format)
 */
const DEFAULT_CONFIG = `{
  // Uncomment to enable debug logging (view in: ~/.local/share/opencode/log/dev.log)
  // Filter with: grep "service=${SERVICE_NAME}" ~/.local/share/opencode/log/dev.log
  // "debug": true,

  "replacements": {
    "must": "MUST",
    "must not": "MUST NOT",
    "required": "REQUIRED",
    "shall": "SHALL",
    "shall not": "SHALL NOT",
    "should": "SHOULD",
    "should not": "SHOULD NOT",
    "recommended": "RECOMMENDED",
    "not recommended": "NOT RECOMMENDED",
    "may": "MAY",
    "optional": "OPTIONAL"
  }
}
`

/**
 * Log a message using the OpenCode SDK logging system
 * Logs appear in ~/.local/share/opencode/log/dev.log
 */
async function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!debugEnabled && level === "debug") return
  if (!sdkClient) return

  try {
    await sdkClient.app.log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    })
  } catch {
    // Silently fail - logging should never break the plugin
  }
}

/**
 * Parse JSONC (JSON with Comments) by stripping comments before parsing
 */
function parseJSONC(content: string): any {
  // Strip single-line comments (// ...) - but not inside strings
  // This is a simplified approach that works for typical config files
  const lines = content.split("\n")
  const strippedLines = lines.map((line) => {
    // Find // that's not inside a string
    let inString = false
    let escapeNext = false
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (escapeNext) {
        escapeNext = false
        continue
      }
      if (char === "\\") {
        escapeNext = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (!inString && char === "/" && line[i + 1] === "/") {
        return line.substring(0, i)
      }
    }
    return line
  })

  const stripped = strippedLines.join("\n")
  // Also strip multi-line comments /* ... */
  const noMultiLine = stripped.replace(/\/\*[\s\S]*?\*\//g, "")

  // Strip trailing commas before ] or } (for JSONC compatibility)
  const noTrailingCommas = noMultiLine.replace(/,(\s*[}\]])/g, "$1")

  return JSON.parse(noTrailingCommas)
}

/**
 * Create default config file with RFC2119 keywords if it doesn't exist
 */
function ensureConfigExists(): void {
  if (!existsSync(CONFIG_PATH)) {
    try {
      writeFileSync(CONFIG_PATH, DEFAULT_CONFIG, "utf-8")
      // Fire-and-forget log - don't block init
      log("info", "Created default config", { path: CONFIG_PATH })
    } catch (error) {
      // Fire-and-forget log - don't block init
      log("error", "Failed to create default config", { error: String(error) })
    }
  }
}

interface Config {
  debug: boolean
  replacements: Record<string, string>
}

/**
 * Load and parse the config file
 * Returns debug flag and replacements map
 */
function loadConfig(): Config {
  const defaultConfig: Config = {
    debug: false,
    replacements: RFC2119_DEFAULTS,
  }

  try {
    if (!existsSync(CONFIG_PATH)) {
      return defaultConfig
    }

    const content = readFileSync(CONFIG_PATH, "utf-8")
    const parsed = parseJSONC(content)

    return {
      debug: parsed.debug === true,
      replacements: parsed.replacements || {},
    }
  } catch (error) {
    // Log to stderr since SDK client might not be ready yet
    process.stderr.write(`MUST-have-plugin: [WARN] Failed to parse config: ${error}\n`)
    return defaultConfig
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Apply all replacements to the given text
 * - Case-insensitive matching
 * - Word boundary aware (won't replace "must" inside "customer")
 * - Won't match inside markdown formatting (won't replace MUST inside **MUST**)
 * - Single-pass: all patterns matched at once to prevent re-replacement
 */
function applyReplacements(
  text: string,
  replacements: Record<string, string>,
): { result: string; counts: Map<string, number> } {
  if (Object.keys(replacements).length === 0) {
    return { result: text, counts: new Map() }
  }

  // Sort keys by length descending (longest first) for proper matching priority
  const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length)

  // Build a single regex that matches any of the patterns
  // Uses negative lookbehind/lookahead to exclude matches inside markdown formatting
  // (?<![a-zA-Z*_]) = not preceded by letter, asterisk, or underscore
  // (?![a-zA-Z*_]) = not followed by letter, asterisk, or underscore
  const patternStrings = sortedKeys.map((key) => `(?<![a-zA-Z*_])${escapeRegex(key)}(?![a-zA-Z*_])`)
  const combinedPattern = new RegExp(`(${patternStrings.join("|")})`, "gi")

  // Build a case-insensitive lookup map
  const lookup = new Map<string, string>()
  for (const key of sortedKeys) {
    lookup.set(key.toLowerCase(), replacements[key])
  }

  const counts = new Map<string, number>()

  // Single-pass replacement: each match is replaced exactly once
  let lastIndex = 0
  let result = ""
  let match: RegExpExecArray | null

  while ((match = combinedPattern.exec(text)) !== null) {
    const replacement = lookup.get(match[0].toLowerCase())
    if (replacement) {
      counts.set(match[0].toLowerCase(), (counts.get(match[0].toLowerCase()) || 0) + 1)
      result += text.slice(lastIndex, match.index) + replacement
      lastIndex = match.index + match[0].length
      // If replacement ends with whitespace, consume trailing space from original text
      if (/\s$/.test(replacement) && text[lastIndex] === " ") {
        lastIndex++
      }
    } else {
      result += text.slice(lastIndex, match.index) + match[0]
      lastIndex = match.index + match[0].length
    }
  }
  result += text.slice(lastIndex)

  return { result, counts }
}

/**
 * MUST-have-plugin (Replacer Plugin)
 */
const Replacer: Plugin = async ({ client }) => {
  // Store SDK client for logging
  sdkClient = client

  // Ensure default config exists (synchronous)
  ensureConfigExists()

  // Initial config load to get debug state
  const initialConfig = loadConfig()
  debugEnabled = initialConfig.debug

  // Fire-and-forget log during init - don't await to avoid blocking startup
  log("info", "Plugin loaded", {
    configPath: CONFIG_PATH,
    replacementCount: Object.keys(initialConfig.replacements).length,
  })

  return {
    "command.execute.before": async (input) => {
      sessionsWithCommand.add(input.sessionID)
      await log("debug", "Tracking command execution", { sessionID: input.sessionID, command: input.command })
    },

    "chat.message": async (input, output) => {
      // Skip processing if this message came from a slash command execution
      if (sessionsWithCommand.has(input.sessionID)) {
        sessionsWithCommand.delete(input.sessionID)
        await log("debug", "Skipping replacements - message from slash command", { sessionID: input.sessionID })
        return
      }

      // Hot reload: re-read config on every message
      const config = loadConfig()
      debugEnabled = config.debug

      if (Object.keys(config.replacements).length === 0) {
        await log("debug", "No replacements configured, skipping")
        return
      }

      let totalReplacements = 0
      const allCounts = new Map<string, number>()

      // Apply to user-typed text only (not file content, not slash command output, not synthetic)
      // User-typed content: type === "text" && synthetic !== true
      for (const part of output.parts) {
        if (part.type === "text" && "text" in part && typeof part.text === "string" && !part.synthetic) {
          const { result, counts } = applyReplacements(part.text, config.replacements)
          ;(part as { text: string }).text = result

          // Merge counts
          for (const [key, count] of counts) {
            allCounts.set(key, (allCounts.get(key) || 0) + count)
            totalReplacements += count
          }
        }
      }

      // Log replacements made
      if (totalReplacements > 0) {
        const replacements: Record<string, { value: string; count: number }> = {}
        for (const [key, count] of allCounts) {
          replacements[key] = { value: config.replacements[key], count }
        }
        await log("info", `Applied ${totalReplacements} replacement(s)`, { replacements })
      }
    },
  }
}

export default Replacer
