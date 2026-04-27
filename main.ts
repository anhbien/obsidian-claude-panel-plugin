import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ToolUseBlock } from "@anthropic-ai/sdk/resources/messages";
import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Modal,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  setIcon,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_CLAUDE = "claude-chat-view";

interface AnthropicModel {
  id: string;
  display_name: string;
}

const FALLBACK_MODELS: AnthropicModel[] = [
  { id: "claude-opus-4-7",            display_name: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6",          display_name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001",  display_name: "Claude Haiku 4.5" },
];

// ── Interfaces ───────────────────────────────────────────────────────────────

interface ClaudeSettings {
  apiKey: string;
  model: string;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: ClaudeSettings = {
  apiKey: "",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "You are a helpful assistant embedded in Obsidian. You have access to tools that let you read, create, edit, and search files in the vault. Use them when the user asks you to work with notes or organize their vault.",
};

interface DisplayMessage {
  role: "user" | "assistant";
  text: string;
  attachedFileNames?: string[];
}

interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface ChatSession extends SessionMeta {
  messages: MessageParam[];
  displayMessages: DisplayMessage[];
}

// ── Vault tools ──────────────────────────────────────────────────────────────

const VAULT_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_files",
    description: "List files and folders at a given path in the vault. Use an empty string for the vault root.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Folder path relative to vault root, or empty string for root" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file in the vault.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "File path relative to vault root, e.g. 'Notes/todo.md'" } },
      required: ["path"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file in the vault with the given markdown content. Fails if the file already exists.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path, e.g. 'Projects/plan.md'" },
        content: { type: "string", description: "Markdown content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "modify_file",
    description: "Overwrite the full content of an existing file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to vault root" },
        content: { type: "string", description: "New content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_to_file",
    description: "Append text to the end of an existing file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path relative to vault root" },
        content: { type: "string", description: "Text to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "create_folder",
    description: "Create a new folder (and any missing parent folders) in the vault.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "Folder path, e.g. 'Projects/2024'" } },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Move a file or folder to the system trash.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "File or folder path relative to vault root" } },
      required: ["path"],
    },
  },
  {
    name: "search_vault",
    description: "Search for files whose name or path contains the query string.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string", description: "Case-insensitive substring to search for" } },
      required: ["query"],
    },
  },
  {
    name: "fetch_webpage",
    description: "Fetch the text content of a public web page. Use this to read articles, documentation, or any URL the user provides. Returns extracted readable text, not raw HTML.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The full URL to fetch, e.g. 'https://example.com/article'" },
      },
      required: ["url"],
    },
  },
];

const TOOL_LABELS: Record<string, string> = {
  list_files: "Listing",
  read_file: "Reading",
  create_file: "Creating",
  modify_file: "Editing",
  append_to_file: "Appending to",
  create_folder: "Creating folder",
  delete_file: "Deleting",
  search_vault: "Searching",
  fetch_webpage: "Fetching",
};

// ── File picker modal ────────────────────────────────────────────────────────

class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search for a file to add as context…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getItemText(item: TFile): string { return item.path; }
  onChooseItem(item: TFile): void { this.onChoose(item); }
}

// ── Chat history modal ───────────────────────────────────────────────────────

class ChatHistoryModal extends Modal {
  constructor(
    app: App,
    private sessions: SessionMeta[],
    private currentId: string | null,
    private onLoad: (id: string) => Promise<void>,
    private onDelete: (id: string) => Promise<void>
  ) {
    super(app);
    this.setTitle("Chat history");
  }

  onOpen(): void {
    const { contentEl } = this;

    if (this.sessions.length === 0) {
      contentEl.createEl("p", { text: "No saved chats yet.", cls: "claude-history-empty" });
      return;
    }

    const list = contentEl.createDiv("claude-history-list");

    for (const s of this.sessions) {
      const row = list.createDiv(
        "claude-history-row" + (s.id === this.currentId ? " claude-history-active" : "")
      );

      const info = row.createDiv("claude-history-info");
      info.createDiv({ text: s.title, cls: "claude-history-title" });
      info.createDiv({
        text: `${new Date(s.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ${s.messageCount} msg`,
        cls: "claude-history-meta",
      });

      const btns = row.createDiv("claude-history-btns");

      const loadBtn = btns.createEl("button", {
        text: s.id === this.currentId ? "Current" : "Load",
        cls: s.id === this.currentId ? "" : "mod-cta",
      });
      loadBtn.disabled = s.id === this.currentId;
      loadBtn.addEventListener("click", async () => {
        await this.onLoad(s.id);
        this.close();
      });

      const delBtn = btns.createEl("button", { cls: "claude-icon-btn", attr: { "aria-label": "Delete chat" } });
      setIcon(delBtn, "trash-2");
      delBtn.addEventListener("click", async () => {
        await this.onDelete(s.id);
        row.remove();
        if (list.children.length === 0) {
          list.remove();
          contentEl.createEl("p", { text: "No saved chats yet.", cls: "claude-history-empty" });
        }
      });
    }
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Main view ────────────────────────────────────────────────────────────────

export class ClaudeView extends ItemView {
  // API state
  private messages: MessageParam[] = [];
  private client: Anthropic | null = null;
  settings: ClaudeSettings;
  private onSaveSettings: (update?: Partial<ClaudeSettings>) => Promise<void>;

  // Context files
  private contextFiles: TFile[] = [];

  // Session state
  private readonly sessionsDir = ".obsidian/plugins/claude-panel/sessions";
  private readonly indexPath   = ".obsidian/plugins/claude-panel/sessions-index.json";
  private currentSessionId: string | null = null;
  private sessionCreatedAt = 0;
  private displayMessages: DisplayMessage[] = [];

  // Model list cache
  private cachedModels: AnthropicModel[] | null = null;

  // DOM refs
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelectEl: HTMLSelectElement | null = null;
  private chipsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, settings: ClaudeSettings, onSave: (update?: Partial<ClaudeSettings>) => Promise<void>) {
    super(leaf);
    this.settings = { ...settings };
    this.onSaveSettings = onSave;
  }

  getViewType(): string  { return VIEW_TYPE_CLAUDE; }
  getDisplayText(): string { return "Claude"; }
  getIcon(): string       { return "bot"; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("claude-root");

    // ── Toolbar ──────────────────────────────────────────────────────────────
    const toolbar = root.createDiv("claude-toolbar");

    const historyBtn = toolbar.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "Chat history" },
    });
    setIcon(historyBtn, "history");
    historyBtn.addEventListener("click", () => {
      this.openHistory().catch((e) => { console.error("[Claude Panel]", e); });
    });

    const newChatBtn = toolbar.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatBtn, "square-pen");
    newChatBtn.addEventListener("click", () => {
      this.newChat().catch((e) => { console.error("[Claude Panel]", e); });
    });

    // ── Messages ──────────────────────────────────────────────────────────────
    this.messagesEl = root.createDiv("claude-messages");

    // ── Footer ────────────────────────────────────────────────────────────────
    const footer = root.createDiv("claude-footer");

    this.chipsEl = footer.createDiv("claude-chips");
    this.renderChips();

    this.inputEl = footer.createEl("textarea", {
      cls: "claude-input",
      attr: { placeholder: "Message Claude… (Enter to send, Shift+Enter for newline)" },
    });

    // ── Bottom bar: model switcher (left) + actions (right) ──────────────────
    const bottomBar = footer.createDiv("claude-bottom-bar");

    const modelWrapper = bottomBar.createDiv("claude-model-wrapper");
    this.modelSelectEl = modelWrapper.createEl("select", { cls: "claude-model-select" });
    modelWrapper.createSpan({ cls: "claude-model-chevron", text: "▾" });
    this.modelSelectEl.addEventListener("change", async () => {
      const model = this.modelSelectEl!.value;
      this.settings.model = model;
      this.client = null;
      await this.onSaveSettings({ model });
    });
    this.populateModelSelect(this.cachedModels ?? FALLBACK_MODELS);

    const actions = bottomBar.createDiv("claude-actions");

    const attachBtn = actions.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "Attach file as context" },
    });
    setIcon(attachBtn, "paperclip");
    attachBtn.addEventListener("click", () => this.openFilePicker());

    this.sendBtn = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendBtn.addEventListener("click", () => {
      this.send().catch((e) => { console.error("[Claude Panel]", e); });
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send().catch((err) => { console.error("[Claude Panel]", err); });
      }
    });

    // Fetch live models in the background (updates select when ready)
    this.loadModels();
  }

  updateSettings(settings: ClaudeSettings): void {
    const apiKeyChanged = settings.apiKey !== this.settings.apiKey;
    this.settings = { ...settings };
    this.client = null;
    if (this.modelSelectEl) this.modelSelectEl.value = settings.model;
    if (apiKeyChanged) {
      this.cachedModels = null;
      this.loadModels();
    }
  }

  // ── Session management ───────────────────────────────────────────────────

  async newChat(): Promise<void> {
    if (this.messages.length > 0) {
      try { await this.autoSave(); } catch (e) { console.error("[Claude Panel] autoSave:", e); }
    }
    this.messages = [];
    this.displayMessages = [];
    this.currentSessionId = null;
    this.sessionCreatedAt = 0;
    this.messagesEl?.empty();
    this.inputEl?.focus();
  }

  clearHistory(): void {
    this.messages = [];
    this.displayMessages = [];
    this.currentSessionId = null;
    this.sessionCreatedAt = 0;
    this.messagesEl?.empty();
  }

  private async openHistory(): Promise<void> {
    if (this.messages.length > 0) {
      try { await this.autoSave(); } catch (e) { console.error("[Claude Panel] autoSave:", e); }
    }

    const index = await this.loadIndex();
    const sessions = Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);

    new ChatHistoryModal(
      this.app,
      sessions,
      this.currentSessionId,
      (id) => this.loadSession(id),
      (id) => this.deleteSessionById(id)
    ).open();
  }

  private async loadSession(id: string): Promise<void> {
    if (this.messages.length > 0) await this.autoSave();

    const path = `${this.sessionsDir}/${id}.json`;
    if (!(await this.app.vault.adapter.exists(path))) return;

    const raw = await this.app.vault.adapter.read(path);
    const session = JSON.parse(raw) as ChatSession;

    this.messages = session.messages;
    this.displayMessages = session.displayMessages;
    this.currentSessionId = session.id;
    this.sessionCreatedAt = session.createdAt;

    this.messagesEl.empty();
    for (const dm of this.displayMessages) {
      await this.renderMessageToDOM(dm.role, dm.text, dm.attachedFileNames);
    }
    this.scrollToBottom();
  }

  private async autoSave(): Promise<void> {
    if (!this.currentSessionId || this.displayMessages.length === 0) return;

    const title = this.displayMessages[0].text.slice(0, 80);
    const session: ChatSession = {
      id: this.currentSessionId,
      title: title.length < this.displayMessages[0].text.length ? title + "…" : title,
      createdAt: this.sessionCreatedAt,
      updatedAt: Date.now(),
      messageCount: this.displayMessages.length,
      messages: this.messages,
      displayMessages: this.displayMessages,
    };

    await this.ensureSessionsDir();
    await this.app.vault.adapter.write(
      `${this.sessionsDir}/${session.id}.json`,
      JSON.stringify(session)
    );

    const index = await this.loadIndex();
    index[session.id] = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
    };
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(index));
  }

  private async deleteSessionById(id: string): Promise<void> {
    const path = `${this.sessionsDir}/${id}.json`;
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
    const index = await this.loadIndex();
    delete index[id];
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify(index));
    if (id === this.currentSessionId) this.currentSessionId = null;
  }

  private async loadIndex(): Promise<Record<string, SessionMeta>> {
    if (!(await this.app.vault.adapter.exists(this.indexPath))) return {};
    try {
      return JSON.parse(await this.app.vault.adapter.read(this.indexPath));
    } catch {
      return {};
    }
  }

  private async ensureSessionsDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.sessionsDir))) {
      await this.app.vault.adapter.mkdir(this.sessionsDir);
    }
  }

  // ── Dynamic model loading ─────────────────────────────────────────────────

  private async loadModels(): Promise<void> {
    if (!this.settings.apiKey) return;
    try {
      const page = await this.getClient().models.list({ limit: 100 });
      const models = (page.data as AnthropicModel[])
        .filter((m) => (m as unknown as { type: string }).type === "model")
        .sort((a, b) => {
          const da = (a as unknown as { created_at: string }).created_at;
          const db = (b as unknown as { created_at: string }).created_at;
          return new Date(db).getTime() - new Date(da).getTime();
        });
      if (models.length > 0) {
        this.cachedModels = models;
        this.populateModelSelect(models);
      }
    } catch (err) {
      console.warn("[Claude Panel] Could not fetch models:", err);
    }
  }

  private populateModelSelect(models: AnthropicModel[]): void {
    if (!this.modelSelectEl) return;
    this.modelSelectEl.empty();
    for (const m of models) {
      const opt = this.modelSelectEl.createEl("option", {
        value: m.id,
        text: m.display_name,
      });
      if (m.id === this.settings.model) opt.selected = true;
    }
    // If the saved model isn't in the list, add it so nothing breaks
    if (!models.find((m) => m.id === this.settings.model) && this.settings.model) {
      const opt = this.modelSelectEl.createEl("option", {
        value: this.settings.model,
        text: this.settings.model,
      });
      opt.selected = true;
    }
  }

  // ── File picker ──────────────────────────────────────────────────────────

  private openFilePicker(): void {
    new FileSuggestModal(this.app, (file) => {
      if (!this.contextFiles.find((f) => f.path === file.path)) {
        this.contextFiles.push(file);
        this.renderChips();
      }
    }).open();
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    this.chipsEl.style.display = this.contextFiles.length ? "flex" : "none";

    for (const file of this.contextFiles) {
      const chip = this.chipsEl.createDiv("claude-chip");
      chip.createSpan({ text: file.name, cls: "claude-chip-name" });
      const removeBtn = chip.createEl("button", {
        cls: "claude-chip-remove",
        attr: { "aria-label": "Remove file" },
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        this.contextFiles = this.contextFiles.filter((f) => f.path !== file.path);
        this.renderChips();
      });
    }
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.settings.apiKey, dangerouslyAllowBrowser: true });
    }
    return this.client;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.settings.apiKey) {
      this.appendMessage("error", "No API key set — open Settings → Claude Panel.");
      return;
    }

    this.inputEl.value = "";
    this.setInputEnabled(false);

    // Initialise session on first message
    if (!this.currentSessionId) {
      this.currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.sessionCreatedAt = Date.now();
    }

    // Snapshot and clear context files
    const attachedFiles = [...this.contextFiles];
    this.contextFiles = [];
    this.renderChips();

    // Build API content with optional file context
    let apiContent = text;
    if (attachedFiles.length > 0) {
      const parts = await Promise.all(
        attachedFiles.map(async (f) => {
          const content = await this.app.vault.read(f);
          return `<file path="${f.path}">\n${content}\n</file>`;
        })
      );
      apiContent = parts.join("\n\n") + "\n\n" + text;
    }

    await this.appendMessage("user", text, attachedFiles);
    this.messages.push({ role: "user", content: apiContent });

    let currentThinkingEl = this.showThinking();

    try {
      while (true) {
        let streamRow: HTMLElement | null = null;
        let streamBubble: HTMLElement | null = null;
        let accumulatedText = "";
        let thinkingRemovedThisRound = false;

        const stream = this.getClient().messages.stream({
          model: this.settings.model,
          max_tokens: 4096,
          system: this.settings.systemPrompt || undefined,
          tools: VAULT_TOOLS,
          messages: this.messages,
        });

        stream.on("text", (chunk: string) => {
          if (!thinkingRemovedThisRound) {
            currentThinkingEl.remove();
            thinkingRemovedThisRound = true;
            streamRow = this.messagesEl.createDiv("claude-row claude-row-assistant");
            streamBubble = streamRow.createDiv("claude-bubble claude-bubble-assistant");
          }
          accumulatedText += chunk;
          this.scrollToBottom();
        });

        // Re-render as markdown every 80ms during streaming
        let renderActive = false;
        const renderInterval = setInterval(async () => {
          if (!streamBubble || !accumulatedText || renderActive) return;
          renderActive = true;
          try {
            streamBubble.empty();
            await MarkdownRenderer.render(this.app, accumulatedText, streamBubble, "", this);
            this.scrollToBottom();
          } catch { /* ignore mid-stream errors */ }
          renderActive = false;
        }, 80);

        const finalResponse = await stream.finalMessage();
        clearInterval(renderInterval);

        if (!thinkingRemovedThisRound) {
          currentThinkingEl.remove();
        }

        // Wait for any in-progress mid-stream render before doing the final pass
        while (renderActive) {
          await new Promise<void>((r) => setTimeout(r, 5));
        }

        // Final markdown render with enhancements (copy buttons, link handlers)
        if (streamBubble && accumulatedText.trim()) {
          streamBubble.empty();
          await MarkdownRenderer.render(this.app, accumulatedText, streamBubble, "", this);
          this.addPostRenderEnhancements(streamBubble, streamRow!, accumulatedText);
          this.displayMessages.push({ role: "assistant", text: accumulatedText });
          this.scrollToBottom();
        }

        this.messages.push({ role: "assistant", content: finalResponse.content });

        if (finalResponse.stop_reason === "tool_use") {
          const toolUseBlocks = finalResponse.content.filter(
            (b): b is ToolUseBlock => b.type === "tool_use"
          );
          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

          for (const toolUse of toolUseBlocks) {
            const input = toolUse.input as Record<string, string>;
            const label = TOOL_LABELS[toolUse.name] ?? toolUse.name;
            const detail = input.path ?? input.query ?? input.url ?? "";
            this.appendToolStatus(`${label}: ${detail}`);
            const result = await this.executeTool(toolUse.name, input);
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
          }

          this.messages.push({ role: "user", content: toolResults });
          currentThinkingEl = this.showThinking();
        } else {
          await this.autoSave();
          break;
        }
      }
    } catch (err: unknown) {
      currentThinkingEl.remove();
      const msg =
        err instanceof Error
          ? (err.message || err.name || "Unknown error")
          : (String(err) || "Unknown error");
      console.error("[Claude Panel]", err);
      this.appendMessage("error", `Error: ${msg}`);
    } finally {
      this.setInputEnabled(true);
    }
  }

  // ── Tool execution ───────────────────────────────────────────────────────

  private async executeTool(name: string, input: Record<string, string>): Promise<string> {
    const { vault } = this.app;
    try {
      switch (name) {
        case "list_files": {
          const folder = input.path ? vault.getFolderByPath(input.path) : vault.getRoot();
          if (!folder) return `Error: folder not found: "${input.path}"`;
          const entries = folder.children.map(
            (f) => `${f instanceof TFolder ? "[folder]" : "[file]"} ${f.name}`
          );
          return entries.length ? entries.join("\n") : "(empty)";
        }
        case "read_file": {
          const file = vault.getFileByPath(input.path);
          if (!(file instanceof TFile)) return `Error: file not found: "${input.path}"`;
          return await vault.read(file);
        }
        case "create_file": {
          if (vault.getFileByPath(input.path)) return `Error: file already exists: "${input.path}"`;
          await vault.create(input.path, input.content);
          return `Created: ${input.path}`;
        }
        case "modify_file": {
          const file = vault.getFileByPath(input.path);
          if (!(file instanceof TFile)) return `Error: file not found: "${input.path}"`;
          await vault.modify(file, input.content);
          return `Modified: ${input.path}`;
        }
        case "append_to_file": {
          const file = vault.getFileByPath(input.path);
          if (!(file instanceof TFile)) return `Error: file not found: "${input.path}"`;
          const existing = await vault.read(file);
          await vault.modify(file, existing + "\n" + input.content);
          return `Appended to: ${input.path}`;
        }
        case "create_folder": {
          if (vault.getFolderByPath(input.path)) return `Folder already exists: ${input.path}`;
          await vault.createFolder(input.path);
          return `Created folder: ${input.path}`;
        }
        case "delete_file": {
          const target = vault.getAbstractFileByPath(input.path);
          if (!target) return `Error: not found: "${input.path}"`;
          await vault.trash(target, true);
          return `Deleted: ${input.path}`;
        }
        case "search_vault": {
          const q = input.query.toLowerCase();
          const hits = vault.getFiles().filter(
            (f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)
          );
          return hits.length ? hits.map((f) => f.path).join("\n") : "No files found.";
        }
        case "fetch_webpage": {
          const resp = await requestUrl({ url: input.url, method: "GET" });
          if (resp.status < 200 || resp.status >= 300) {
            return `Error: server returned status ${resp.status}`;
          }
          const contentType = resp.headers["content-type"] ?? "";
          if (!contentType.includes("html")) {
            return resp.text.slice(0, 50000);
          }
          const extracted = this.extractPageText(resp.text);
          const MAX = 50000;
          if (extracted.length > MAX) {
            return extracted.slice(0, MAX) + `\n\n[Truncated — ${extracted.length} chars total]`;
          }
          return extracted || "(No readable text found on page)";
        }
        default:
          return `Error: unknown tool "${name}"`;
      }
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Web helpers ──────────────────────────────────────────────────────────

  private extractPageText(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Strip noise
    doc.querySelectorAll(
      "script, style, noscript, nav, footer, header, aside, iframe, [aria-hidden='true'], .ad, .ads, .advertisement"
    ).forEach((el) => el.remove());

    // Prefer semantic content containers
    const main =
      doc.querySelector("article, main, [role='main']") ??
      doc.querySelector(".content, .post-content, .entry-content, #content, #main") ??
      doc.body;

    if (!main) return "";

    // Walk the tree and build readable text preserving headings/paragraphs
    const lines: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        if (t) lines.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (["h1","h2","h3","h4","h5","h6"].includes(tag)) {
        lines.push("\n## " + el.textContent?.trim());
      } else if (tag === "li") {
        lines.push("- " + el.textContent?.trim());
      } else if (tag === "br") {
        lines.push("");
      } else {
        el.childNodes.forEach(walk);
        if (["p","div","section","blockquote","tr"].includes(tag)) lines.push("");
      }
    };
    walk(main);

    return lines
      .join(" ")
      .replace(/ {2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ── UI helpers ───────────────────────────────────────────────────────────

  private showThinking(): HTMLElement {
    const el = this.messagesEl.createDiv("claude-thinking");
    el.setText("●●●");
    this.scrollToBottom();
    return el;
  }

  private appendToolStatus(text: string): void {
    const el = this.messagesEl.createDiv("claude-tool-status");
    el.setText(text);
    this.scrollToBottom();
  }

  private async renderMessageToDOM(
    role: "user" | "assistant" | "error",
    text: string,
    attachedFileNames?: string[]
  ): Promise<void> {
    const row = this.messagesEl.createDiv(`claude-row claude-row-${role}`);
    const bubble = row.createDiv(`claude-bubble claude-bubble-${role}`);
    if (role === "assistant") {
      await MarkdownRenderer.render(this.app, text, bubble, "", this);
      this.addPostRenderEnhancements(bubble, row, text);
    } else if (role === "error") {
      bubble.createSpan({ text });
      const dismissBtn = bubble.createEl("button", {
        cls: "claude-error-dismiss",
        attr: { "aria-label": "Dismiss" },
      });
      setIcon(dismissBtn, "x");
      dismissBtn.addEventListener("click", () => row.remove());
    } else {
      bubble.setText(text);
      const actions = row.createDiv("claude-msg-actions");
      const copyBtn = actions.createEl("button", {
        cls: "claude-icon-btn claude-msg-copy",
        attr: { "aria-label": "Copy" },
      });
      setIcon(copyBtn, "copy");
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(text).catch(() => {});
      });
    }
    if (attachedFileNames?.length) {
      const label = row.createDiv("claude-attach-label");
      label.appendText("📎 ");
      for (let i = 0; i < attachedFileNames.length; i++) {
        const name = attachedFileNames[i];
        const fileSpan = label.createEl("span", { cls: "claude-attach-filename", text: name });
        fileSpan.addEventListener("click", () => {
          const file = this.app.vault.getFiles().find((f) => f.name === name);
          if (file) this.app.workspace.getLeaf(false).openFile(file).catch(() => {});
        });
        if (i < attachedFileNames.length - 1) label.appendText(", ");
      }
    }
  }

  private addPostRenderEnhancements(bubble: HTMLElement, row: HTMLElement, rawText: string): void {
    // Copy buttons on code blocks
    bubble.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      const btn = document.createElement("button");
      btn.className = "claude-copy-code-btn";
      btn.textContent = "Copy";
      pre.appendChild(btn);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(code?.textContent ?? "").catch(() => {});
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
      });
    });

    // Message copy button
    const actions = row.createDiv("claude-msg-actions");
    const copyBtn = actions.createEl("button", {
      cls: "claude-icon-btn claude-msg-copy",
      attr: { "aria-label": "Copy" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(rawText).catch(() => {});
    });

    // External link handling
    bubble.querySelectorAll("a.external-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        window.open((a as HTMLAnchorElement).href, "_blank");
      });
    });

    // Internal (vault) link handling
    bubble.querySelectorAll("a.internal-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
        if (href) this.app.workspace.openLinkText(href, "", false);
      });
    });
  }

  private async appendMessage(
    role: "user" | "assistant" | "error",
    text: string,
    attachedFiles?: TFile[]
  ): Promise<void> {
    if (role !== "error") {
      this.displayMessages.push({
        role,
        text,
        attachedFileNames: attachedFiles?.map((f) => f.name),
      });
    }
    await this.renderMessageToDOM(role, text, attachedFiles?.map((f) => f.name));
    this.scrollToBottom();
  }

  private setInputEnabled(enabled: boolean): void {
    this.inputEl.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
    if (enabled) this.inputEl.focus();
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async onClose(): Promise<void> {}
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class ClaudePlugin extends Plugin {
  settings: ClaudeSettings = { ...DEFAULT_SETTINGS };
  private view: ClaudeView | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_CLAUDE, (leaf) => {
      this.view = new ClaudeView(leaf, this.settings, async (update) => {
        if (update) Object.assign(this.settings, update);
        await this.saveSettings();
      });
      return this.view;
    });

    this.addRibbonIcon("bot", "Open Claude panel", () => this.activateView());

    this.addCommand({
      id: "open-claude-panel",
      name: "Open Claude panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-chat",
      name: "New Claude chat",
      callback: () => this.view?.newChat(),
    });

    this.addCommand({
      id: "clear-claude-history",
      name: "Clear Claude chat (without saving)",
      callback: () => this.view?.clearHistory(),
    });

    this.addSettingTab(new ClaudeSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CLAUDE);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_CLAUDE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.view?.updateSettings(this.settings);
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────

class ClaudeSettingTab extends PluginSettingTab {
  plugin: ClaudePlugin;

  constructor(app: App, plugin: ClaudePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Claude Panel" });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc("Get yours at console.anthropic.com")
      .addText((t) =>
        t
          .setPlaceholder("sk-ant-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Can also be changed directly in the panel")
      .addDropdown((d) =>
        d
          .addOption("claude-haiku-4-5-20251001", "Haiku 4.5 — fast & cheap")
          .addOption("claude-sonnet-4-6", "Sonnet 4.6 — balanced")
          .addOption("claude-opus-4-7", "Opus 4.7 — most capable")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Instructions for Claude's behavior")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
      });
  }
}
