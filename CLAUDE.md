# Claude Panel — Obsidian Plugin

## What this is

An Obsidian sidebar plugin that embeds a Claude AI chat panel. Users can have multi-turn conversations with Claude, attach vault files as context, and Claude can read, write, and search files in the vault via tools.

## Build & dev

```bash
npm run dev       # watch mode — bundles straight into the vault plugin dir
npm run build     # production build (no sourcemap)
```

The build output goes directly to the live vault plugin directory hardcoded in `esbuild.config.mjs`:
```
/Users/anhbien/Library/Mobile Documents/iCloud~md~obsidian/Documents/AB Obsidian Vault - iCloud/.obsidian/plugins/claude-panel/
```

After a build, reload the plugin in Obsidian with **Cmd+R** (or toggle it off/on in Community Plugins settings) to pick up changes.

There is no test suite. Verification is done by loading the plugin in Obsidian and exercising the UI.

## Key files

| File | Purpose |
|---|---|
| `main.ts` | Entire plugin: plugin class, chat view, modals, tool definitions, API calls |
| `styles.css` | All UI styles (scoped to `.claude-*` class names) |
| `manifest.json` | Obsidian plugin metadata (id: `claude-panel`, version: `1.0.0`) |
| `esbuild.config.mjs` | Build config — entry `main.ts`, output CJS, target ES2018 |

## Architecture

Everything lives in `main.ts`. No external UI framework — Obsidian's own DOM helpers (`createEl`, `createDiv`, etc.) are used throughout.

### Classes

**`ClaudePlugin`** (extends `Plugin`)
- Entry point. Registers the view type, ribbon icon, and commands.
- Holds settings and a single `ClaudeView` instance reference.
- `activateView()` creates or reveals the sidebar leaf.

**`ClaudeView`** (extends `ItemView`)
- The main chat panel. Renders into a sidebar leaf.
- `onOpen()` — builds the full DOM (toolbar, messages area, footer). Called once when the leaf is created; does NOT re-render existing messages.
- `onClose()` — empty (no cleanup needed).
- Key state: `messages: MessageParam[]` (full API history), `displayMessages: DisplayMessage[]` (UI-only, excludes error messages), `currentSessionId`, `contextFiles`.

**`ChatHistoryModal`** (extends `Modal`)
- Lists saved sessions, allows loading or deleting.

**`FileSuggestModal`** (extends `FuzzySuggestModal<TFile>`)
- Fuzzy file picker for attaching vault files as context.

### Data flow for sending a message

1. User types and hits Enter or clicks Send → `send()` is called.
2. Context files are read and prepended to the API content (not the displayed text).
3. User message is appended to both `messages` and `displayMessages`; rendered to DOM.
4. Thinking indicator (`●●●`) appears.
5. `getClient().messages.create(...)` is called with full message history and `VAULT_TOOLS`.
6. If `stop_reason === "tool_use"`: tools are executed, results pushed back, loop continues.
7. If `stop_reason !== "tool_use"`: final text blocks are rendered, `autoSave()` is called.
8. Errors are caught and rendered as a dismissible red error bubble.

### Session persistence

Sessions are stored as JSON files in the vault at:
```
.obsidian/plugins/claude-panel/sessions/<id>.json
```
An index file at `.obsidian/plugins/claude-panel/sessions-index.json` holds metadata for the history list.

`autoSave()` runs after every successful response and when switching sessions. It only saves if `currentSessionId` is set and `displayMessages` is non-empty.

Error messages are intentionally excluded from `displayMessages` and therefore never persisted.

### Vault tools available to Claude

| Tool | What it does |
|---|---|
| `list_files` | List folder contents |
| `read_file` | Read a file's content |
| `create_file` | Create a new file |
| `modify_file` | Overwrite a file |
| `append_to_file` | Append to a file |
| `create_folder` | Create a folder |
| `delete_file` | Trash a file/folder |
| `search_vault` | Search files by name/path substring |
| `fetch_webpage` | Fetch and extract text from a URL |

### Settings

Stored via Obsidian's `loadData()`/`saveData()` (in `.obsidian/plugins/claude-panel/data.json`):
- `apiKey` — Anthropic API key
- `model` — default `claude-sonnet-4-6`
- `systemPrompt` — editable in plugin settings tab

The model list is fetched live from the Anthropic API on panel open and cached in memory (`cachedModels`). Falls back to `FALLBACK_MODELS` if the fetch fails.

## Important constraints & gotchas

- **All event listeners calling async methods must use `.catch()`** — unhandled rejections from plugin code cause Obsidian to display its own red error overlay. This was a past bug.
- **`autoSave()` must be wrapped in try/catch** wherever it's called (`newChat`, `openHistory`) — file system errors would otherwise produce unhandled rejections.
- **Error messages are not saved to `displayMessages`** — they only live in the DOM. This is intentional so errors don't pollute session history.
- **`onOpen()` does not re-render existing messages** — if the view is re-opened (e.g. after a workspace reload), in-memory `displayMessages` won't be shown. The user needs to load a saved session via the history button.
- **The Anthropic client is created lazily** in `getClient()` and reset to `null` when the API key or model changes.
- **`dangerouslyAllowBrowser: true`** is required on the Anthropic client because Obsidian runs in Electron/browser context.
- **`thinkingEl.remove()` is safe to call multiple times** — DOM's `.remove()` on a detached element is a no-op. The thinking element is created once per `send()` call and removed in whichever branch completes first.
- **MarkdownRenderer is used for assistant messages only** — user and error messages use `setText()` to avoid rendering user input as markdown.

## CSS conventions

All classes are prefixed with `claude-`. The layout is a flex column: toolbar → messages (scrollable, flex: 1) → footer. No external CSS framework.

Key classes:
- `.claude-root` — top-level flex container
- `.claude-messages` — scrollable message list
- `.claude-row-{user|assistant|error}` — message row, controls alignment
- `.claude-bubble-{user|assistant|error}` — the styled bubble
- `.claude-error-dismiss` — the × button inside error bubbles
- `.claude-thinking` — animated `●●●` indicator
- `.claude-tool-status` — small italic pill shown during tool execution
