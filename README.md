# A MUST-have plugin

Automatically replaces text patterns in your prompts before they're sent to the LLM.

## What It Does

Performs case-insensitive string replacements on user-typed prompts. The primary use case is auto-capitalizing RFC2119 keywords (MUST, SHOULD, MAY, etc.) in technical specifications.

**Example**: Typing `"the system must validate input"` becomes `"the system MUST validate input"`.

### Features

- **Case-insensitive matching**: `must`, `Must`, and `MUST` all match
- **Word boundary aware**: Won't replace `may` inside `maybe`
- **Multi-word phrases**: `must not` is matched as a unit (before `must` alone)
- **Hot reload**: Config changes take effect immediately (no restart needed)
- **JSONC support**: Comments and trailing commas allowed in config file

### Scope

- Only replaces text in user-typed prompts
- Does NOT modify file content attached via `@` mentions
- Does NOT modify slash command output

## Configuration

**Config file**: `~/.config/opencode/MUST-have-plugin.jsonc`

If the config file doesn't exist, it's automatically created with RFC2119 defaults.

### Default Configuration

```jsonc
{
  // Uncomment to enable debug logging (logs appear in OpenCode's log file)
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
```

### Custom Replacements

Add your own replacement pairs to the `replacements` object:

```jsonc
{
  // Uncomment to enable debug logging (view with: tail -f /tmp/opencode-replacer-debug.log)
  // "debug": true,

  "replacements": {
    "rfc": "The key words \"**MUST**\", \"**MUST NOT**\", \"**REQUIRED**\", \"**SHALL**\", \"**SHALL NOT**\", \"**SHOULD**\", \"**SHOULD NOT**\", \"**RECOMMENDED**\", \"**MAY**\", and \"**OPTIONAL**\" in this message are to be interpreted as described in RFC2119.\n\n",
    "dfp": "Diagnose and fix this problem:",
    "mnm": "Make no mistakes!",
"always": "**ALWAYS**",
    "may": "**MAY**",
    "must always": "**MUST ALWAYS**",
    "must never" : "**MUST NEVER**",
    "must not" : "**MUST NOT**",
    "mustn't" : "**MUST NOT**",
    "must": "**MUST**",
    "never": "**NEVER**",
    "not recommended": "**NOT RECOMMENDED**",
    "not": "**NOT**",
    "optional": "**OPTIONAL**",
    "ought": "**SHOULD**",
    "oughtn't": "**SHOULD NOT**",
    "recommended": "**RECOMMENDED**",
    "required": "**REQUIRED**",
    "shall not": "**SHALL NOT**",
    "shan'st": "**SHALL NOT**",
    "shall": "**SHALL**",
    "should not": "**SHOULD NOT**",
    "shouldn't": "**SHOULD NOT**",
    "should": "**SHOULD**",
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `debug` | boolean | `false` | Enable debug logging to OpenCode's log file |
| `replacements` | object | RFC2119 keywords | Key-value pairs for text replacement |

## Debug Logging

Logs are written to OpenCode's unified log file using the SDK logging system.

**Log location**: `~/.local/share/opencode/log/dev.log`

Enable debug mode to see what replacements are being made:

1. Edit `~/.config/opencode/MUST-have-plugin.jsonc`
2. Uncomment or add `"debug": true`
3. View logs in real-time (filtering by this plugin):

```bash
tail -f ~/.local/share/opencode/log/dev.log | grep "MUST-have-plugin"
```

Or view all recent plugin logs:

```bash
grep "MUST-have-plugin" ~/.local/share/opencode/log/dev.log | tail -20
```

### Log Format

Logs use OpenCode's standard format with structured metadata:

```
INFO  2026-01-20T15:30:42 +2ms service=MUST-have-plugin Plugin loaded
INFO  2026-01-20T15:31:05 +5ms service=MUST-have-plugin Applied 3 replacement(s) replacements={"must":{"value":"MUST","count":2},"should":{"value":"SHOULD","count":1}}
```

## RFC2119 Keywords

The default configuration includes all keywords from [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119), which defines requirement levels for use in technical specifications:

| Keyword | Meaning |
|---------|---------|
| MUST / REQUIRED / SHALL | Absolute requirement |
| MUST NOT / SHALL NOT | Absolute prohibition |
| SHOULD / RECOMMENDED | Recommended, but valid reasons may exist to ignore |
| SHOULD NOT / NOT RECOMMENDED | Not recommended, but may be acceptable in some cases |
| MAY / OPTIONAL | Truly optional |

## Troubleshooting

### Replacements not working

1. Check that the config file exists: `cat ~/.config/opencode/MUST-have-plugin.jsonc`
2. Verify JSONC syntax is valid (comments and trailing commas are allowed)
3. Enable debug mode and check the log file

### Unexpected replacements

- Replacements use word boundaries, so `must` won't match inside `customer`
- Multi-word phrases are matched first, so `must not` won't become `MUST not`
- Check for typos in your replacement keys

### Config changes not taking effect

The plugin re-reads the config on every message, so changes should be immediate. If not:

1. Verify you saved the config file
2. Check for JSONC syntax errors
3. Restart OpenCode as a last resort
