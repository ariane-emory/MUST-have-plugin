import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
const CONFIG_PATH = resolve(process.env.HOME || "", ".config", "opencode", "MUST-have-plugin.jsonc");
const SERVICE_NAME = "MUST-have-plugin";
// Track debug state (loaded from config)
let debugEnabled = false;
// SDK client reference for logging (set during plugin init)
let sdkClient = null;
/**
 * RFC2119 default replacements
 * These keywords are used in technical specifications to indicate requirement levels.
 * See: https://datatracker.ietf.org/doc/html/rfc2119
 */
const RFC2119_DEFAULTS = {
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
};
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
`;
/**
 * Log a message using the OpenCode SDK logging system
 * Logs appear in ~/.local/share/opencode/log/dev.log
 */
async function log(level, message, extra) {
    if (!debugEnabled && level === "debug")
        return;
    if (!sdkClient)
        return;
    try {
        await sdkClient.app.log({
            body: {
                service: SERVICE_NAME,
                level,
                message,
                extra,
            },
        });
    }
    catch {
        // Silently fail - logging should never break the plugin
    }
}
/**
 * Parse JSONC (JSON with Comments) by stripping comments before parsing
 */
function parseJSONC(content) {
    // Strip single-line comments (// ...) - but not inside strings
    // This is a simplified approach that works for typical config files
    const lines = content.split("\n");
    const strippedLines = lines.map((line) => {
        // Find // that's not inside a string
        let inString = false;
        let escapeNext = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (char === "\\") {
                escapeNext = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (!inString && char === "/" && line[i + 1] === "/") {
                return line.substring(0, i);
            }
        }
        return line;
    });
    const stripped = strippedLines.join("\n");
    // Also strip multi-line comments /* ... */
    const noMultiLine = stripped.replace(/\/\*[\s\S]*?\*\//g, "");
    // Strip trailing commas before ] or } (for JSONC compatibility)
    const noTrailingCommas = noMultiLine.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(noTrailingCommas);
}
/**
 * Create default config file with RFC2119 keywords if it doesn't exist
 */
function ensureConfigExists() {
    if (!existsSync(CONFIG_PATH)) {
        try {
            writeFileSync(CONFIG_PATH, DEFAULT_CONFIG, "utf-8");
            // Fire-and-forget log - don't block init
            log("info", "Created default config", { path: CONFIG_PATH });
        }
        catch (error) {
            // Fire-and-forget log - don't block init
            log("error", "Failed to create default config", { error: String(error) });
        }
    }
}
/**
 * Load and parse the config file
 * Returns debug flag and replacements map
 */
function loadConfig() {
    const defaultConfig = {
        debug: false,
        replacements: RFC2119_DEFAULTS,
    };
    try {
        if (!existsSync(CONFIG_PATH)) {
            return defaultConfig;
        }
        const content = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = parseJSONC(content);
        return {
            debug: parsed.debug === true,
            replacements: parsed.replacements || {},
        };
    }
    catch (error) {
        // Log to stderr since SDK client might not be ready yet
        process.stderr.write(`MUST-have-plugin: [WARN] Failed to parse config: ${error}\n`);
        return defaultConfig;
    }
}
/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Apply all replacements to the given text
 * - Case-insensitive matching
 * - Word boundary aware (won't replace "must" inside "customer")
 * - Single-pass: all patterns matched at once to prevent re-replacement
 *   (e.g., "must not" → "**MUST NOT**" should NOT then match "must" and "not")
 */
function applyReplacements(text, replacements) {
    if (Object.keys(replacements).length === 0) {
        return { result: text, counts: new Map() };
    }
    // Sort keys by length descending (longest first) for proper matching priority
    const sortedKeys = Object.keys(replacements).sort((a, b) => b.length - a.length);
    // Build a single regex that matches any of the patterns
    // Uses a capture group to identify which pattern matched
    const patternStrings = sortedKeys.map((key) => `\\b${escapeRegex(key)}\\b`);
    const combinedPattern = new RegExp(`(${patternStrings.join("|")})`, "gi");
    // Build a case-insensitive lookup map
    const lookup = new Map();
    for (const key of sortedKeys) {
        lookup.set(key.toLowerCase(), replacements[key]);
    }
    const counts = new Map();
    // Single-pass replacement: each match is replaced exactly once
    const result = text.replace(combinedPattern, (match) => {
        const replacement = lookup.get(match.toLowerCase());
        if (replacement) {
            counts.set(match.toLowerCase(), (counts.get(match.toLowerCase()) || 0) + 1);
            return replacement;
        }
        return match;
    });
    return { result, counts };
}
/**
 * MUST-have-plugin (Replacer Plugin)
 */
const Replacer = async ({ client }) => {
    // Store SDK client for logging
    sdkClient = client;
    // Ensure default config exists (synchronous)
    ensureConfigExists();
    // Initial config load to get debug state
    const initialConfig = loadConfig();
    debugEnabled = initialConfig.debug;
    // Fire-and-forget log during init - don't await to avoid blocking startup
    log("info", "Plugin loaded", {
        configPath: CONFIG_PATH,
        replacementCount: Object.keys(initialConfig.replacements).length,
    });
    return {
        "chat.message": async (input, output) => {
            // Hot reload: re-read config on every message
            const config = loadConfig();
            debugEnabled = config.debug;
            if (Object.keys(config.replacements).length === 0) {
                await log("debug", "No replacements configured, skipping");
                return;
            }
            let totalReplacements = 0;
            const allCounts = new Map();
            // Apply to text-type parts only (not file content, not other part types)
            // User-typed content comes through as TextPart with type === "text"
            for (const part of output.parts) {
                if (part.type === "text" && "text" in part && typeof part.text === "string") {
                    const { result, counts } = applyReplacements(part.text, config.replacements);
                    part.text = result;
                    // Merge counts
                    for (const [key, count] of counts) {
                        allCounts.set(key, (allCounts.get(key) || 0) + count);
                        totalReplacements += count;
                    }
                }
            }
            // Log replacements made
            if (totalReplacements > 0) {
                const replacements = {};
                for (const [key, count] of allCounts) {
                    replacements[key] = { value: config.replacements[key], count };
                }
                await log("info", `Applied ${totalReplacements} replacement(s)`, { replacements });
            }
        },
    };
};
export default Replacer;
