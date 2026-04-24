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
  Setting,
  setIcon,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";

const VIEW_TYPE_CLAUDE = "claude-chat-view";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-6",          label: "Sonnet 4.6" },
  { id: "claude-opus-4-7",            label: "Opus 4.7" },
] as const;

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
  private onSaveSettings: () => Promise<void>;

  // Context files
  private contextFiles: TFile[] = [];

  // Session state
  private readonly sessionsDir = ".obsidian/plugins/claude-panel/sessions";
  private readonly indexPath   = ".obsidian/plugins/claude-panel/sessions-index.json";
  private currentSessionId: string | null = null;
  private sessionCreatedAt = 0;
  private displayMessages: DisplayMessage[] = [];

  // DOM refs
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelectEl: HTMLSelectElement | null = null;
  private chipsEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, settings: ClaudeSettings, onSave: () => Promise<void>) {
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

    this.modelSelectEl = toolbar.createEl("select", { cls: "claude-model-select" });
    for (const m of MODELS) {
      const opt = this.modelSelectEl.createEl("option", { value: m.id, text: m.label });
      if (m.id === this.settings.model) opt.selected = true;
    }
    this.modelSelectEl.addEventListener("change", async () => {
      this.settings.model = this.modelSelectEl!.value;
      this.client = null;
      await this.onSaveSettings();
    });

    const historyBtn = toolbar.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "Chat history" },
    });
    setIcon(historyBtn, "history");
    historyBtn.addEventListener("click", () => this.openHistory());

    const newChatBtn = toolbar.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatBtn, "square-pen");
    newChatBtn.addEventListener("click", () => this.newChat());

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

    const actions = footer.createDiv("claude-actions");

    const attachBtn = actions.createEl("button", {
      cls: "claude-icon-btn",
      attr: { "aria-label": "Attach file as context" },
    });
    setIcon(attachBtn, "paperclip");
    attachBtn.addEventListener("click", () => this.openFilePicker());

    this.sendBtn = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendBtn.addEventListener("click", () => this.send());

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
  }

  updateSettings(settings: ClaudeSettings): void {
    this.settings = { ...settings };
    this.client = null;
    if (this.modelSelectEl) this.modelSelectEl.value = settings.model;
  }

  // ── Session management ───────────────────────────────────────────────────

  async newChat(): Promise<void> {
    if (this.messages.length > 0) await this.autoSave();
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
    if (this.messages.length > 0) await this.autoSave();

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

    const thinkingEl = this.showThinking();

    try {
      while (true) {
        const response = await this.getClient().messages.create({
          model: this.settings.model,
          max_tokens: 4096,
          system: this.settings.systemPrompt || undefined,
          tools: VAULT_TOOLS,
          messages: this.messages,
        });

        this.messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason === "tool_use") {
          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              thinkingEl.remove();
              await this.appendMessage("assistant", block.text);
            }
          }

          const toolUseBlocks = response.content.filter(
            (b): b is ToolUseBlock => b.type === "tool_use"
          );
          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

          for (const toolUse of toolUseBlocks) {
            const input = toolUse.input as Record<string, string>;
            const label = TOOL_LABELS[toolUse.name] ?? toolUse.name;
            const detail = input.path ?? input.query ?? "";
            this.appendToolStatus(`${label}: ${detail}`);
            const result = await this.executeTool(toolUse.name, input);
            toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
          }

          this.messages.push({ role: "user", content: toolResults });
        } else {
          thinkingEl.remove();
          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              await this.appendMessage("assistant", block.text);
            }
          }
          await this.autoSave();
          break;
        }
      }
    } catch (err: unknown) {
      thinkingEl.remove();
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
        default:
          return `Error: unknown tool "${name}"`;
      }
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
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
    } else {
      bubble.setText(text);
    }
    if (attachedFileNames?.length) {
      const label = row.createDiv("claude-attach-label");
      label.setText("📎 " + attachedFileNames.join(", "));
    }
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
      this.view = new ClaudeView(leaf, this.settings, () => this.saveSettings());
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
