import { Plugin, WorkspaceLeaf, Notice, MarkdownView } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  Conversation,
  LMStudioModel,
  CannedPrompt,
} from "./types";
import { AideSettingTab } from "./settings";
import { AideChatView, AIDE_VIEW_TYPE } from "./views/ChatView";
import { LMStudioClient } from "./api/lmStudioClient";
import { ChatHistoryModal } from "./views/HistoryModal";

interface PluginData {
  settings?: PluginSettings;
  conversations?: Conversation[]; // Legacy field in data.json for migration
}

type LegacyConversation = Conversation & { model?: string };

export default class AidePlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  conversations: Conversation[] = [];
  cannedPrompts: CannedPrompt[] = [];
  currentConversationId: string = "";
  cachedModels: LMStudioModel[] = [];
  private lastActiveMarkdownView: MarkdownView | null = null;

  private get historyFilePath(): string {
    return `${this.manifest.dir}/history.json`;
  }

  private get cannedPromptsFilePath(): string {
    return `${this.manifest.dir}/prompts.json`;
  }

  async onload(): Promise<void> {
    console.log("[Aide] Loading plugin");
    await this.loadPluginData();

    // Register Sidebar View
    this.registerView(AIDE_VIEW_TYPE, (leaf) => new AideChatView(leaf, this));

    // Ribbon Icon to open sidebar
    this.addRibbonIcon("bot", "Open Aide", () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-aide-chat",
      name: "New chat session",
      callback: async () => {
        await this.activateView();
        const view = this.getActiveChatView();
        if (view) {
          view.startNewChat();
        }
      },
    });

    this.addCommand({
      id: "view-aide-chat-history",
      name: "View chat history",
      callback: () => {
        new ChatHistoryModal(
          this.app,
          this,
          (chat) => {
            this.activateView().then(() => {
              const view = this.getActiveChatView();
              if (view) view.loadConversation(chat);
            });
          },
          () => {
            this.activateView().then(() => {
              const view = this.getActiveChatView();
              if (view) view.startNewChat();
            });
          },
        ).open();
      },
    });

    this.addCommand({
      id: "refresh-lm-studio-models",
      name: "Refresh available models from LM Studio",
      callback: async () => {
        try {
          const models = await LMStudioClient.fetchModels(
            this.settings.baseUrl,
          );
          this.cachedModels = models;
          new Notice(`Found ${models.length} model(s) from LM Studio`);
          this.updateModelInViews(this.settings.selectedModel);
        } catch (err: any) {
          new Notice(`Failed to fetch models: ${err.message}`);
        }
      },
    });

    // Settings Tab
    this.addSettingTab(new AideSettingTab(this.app, this));

    this.lastActiveMarkdownView =
      this.app.workspace.getActiveViewOfType(MarkdownView);

    // Listen to active leaf and editor changes to automatically update active note / selection context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.lastActiveMarkdownView = leaf.view;
        }
        this.updateContextInViews();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (_, view) => {
        if (view instanceof MarkdownView) {
          this.lastActiveMarkdownView = view;
        }
        this.updateContextInViews();
      }),
    );

    this.registerDomEvent(document, "selectionchange", () => {
      // Avoid firing when selection changes inside Aide chat textarea
      const activeEl = document.activeElement;
      if (activeEl && activeEl.closest(".lm-copilot-container")) {
        return;
      }
      this.updateContextInViews();
    });

    // Initial background model fetch if URL is configured
    this.fetchModelsInBackground();
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(AIDE_VIEW_TYPE);
  }

  // -------------------------------------------------------------
  // View Lifecycle & Helpers
  // -------------------------------------------------------------

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(AIDE_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // Open in right sidebar leaf
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: AIDE_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
      const view = this.getActiveChatView();
      if (view) {
        view.focusInput();
      }
    }
  }

  public getActiveChatView(): AideChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(AIDE_VIEW_TYPE);
    if (leaves.length > 0) {
      return leaves[0].view as AideChatView;
    }
    return null;
  }

  public getContextMarkdownView(): MarkdownView | null {
    return this.lastActiveMarkdownView;
  }

  public openSettings(): void {
    const settings = (
      this.app as typeof this.app & {
        setting: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  public updateContextInViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(AIDE_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof AideChatView) {
        leaf.view.updateActiveFileContext();
      }
    }
  }

  public updateModelInViews(modelId: string): void {
    const leaves = this.app.workspace.getLeavesOfType(AIDE_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof AideChatView) {
        leaf.view.updateModelDropdown(modelId);
      }
    }
  }

  public updateCannedPromptsInViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(AIDE_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof AideChatView) {
        leaf.view.updateCannedPromptsDropdown();
      }
    }
  }

  private async fetchModelsInBackground(): Promise<void> {
    try {
      const models = await LMStudioClient.fetchModels(this.settings.baseUrl);
      this.cachedModels = models;
      if (!this.settings.selectedModel && models.length > 0) {
        this.settings.selectedModel = models[0].id;
        await this.saveSettings();
      }
      this.updateModelInViews(this.settings.selectedModel);
    } catch (_) {
      // Silently ignore on startup if LM Studio is not currently running
    }
  }

  // -------------------------------------------------------------
  // Storage / Persistence
  // -------------------------------------------------------------

  async loadPluginData(): Promise<void> {
    const data: PluginData | null = await this.loadData();
    if (data && data.settings) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    } else if (
      data &&
      !data.settings &&
      typeof (data as any).baseUrl === "string"
    ) {
      // Legacy flat settings object in data.json
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data as any);
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    }

    // Load private, plugin-local data files.
    await this.loadConversations(data);
    await this.loadCannedPrompts();
  }

  private async loadConversations(
    legacyData: PluginData | null,
  ): Promise<void> {
    const adapter = this.app.vault.adapter;
    const historyPath = this.historyFilePath;

    try {
      if (await adapter.exists(historyPath)) {
        const raw = await adapter.read(historyPath);
        const parsed = JSON.parse(raw);
        this.conversations = Array.isArray(parsed) ? parsed : [];
        if (this.migrateConversationModels()) {
          await this.saveConversations();
        }
        return;
      }
    } catch (err) {
      console.error("[Aide] Error reading history.json:", err);
    }

    // Migration: If history.json does not exist yet, check legacy data.json
    if (
      legacyData &&
      Array.isArray(legacyData.conversations) &&
      legacyData.conversations.length > 0
    ) {
      console.log(
        `[Aide] Migrating ${legacyData.conversations.length} conversation(s) from data.json to history.json`,
      );
      this.conversations = legacyData.conversations;
      this.migrateConversationModels();
      await this.saveConversations();
      // Clean up data.json so conversations aren't duplicated in data.json
      await this.saveSettings();
    } else {
      this.conversations = [];
    }
  }

  /** Moves the legacy conversation model onto each historical assistant message. */
  private migrateConversationModels(): boolean {
    let changed = false;

    for (const conversation of this.conversations as LegacyConversation[]) {
      if (conversation.model) {
        for (const message of conversation.messages || []) {
          if (message.role === "assistant" && !message.model) {
            message.model = conversation.model;
            changed = true;
          }
        }
        delete conversation.model;
        changed = true;
      }
    }

    return changed;
  }

  async saveSettings(): Promise<void> {
    // Only persist settings in data.json
    const data = {
      settings: this.settings,
    };
    await this.saveData(data);
  }

  async saveConversations(): Promise<void> {
    if (!this.settings.saveChatHistory) {
      return;
    }
    const adapter = this.app.vault.adapter;
    const historyPath = this.historyFilePath;
    try {
      await adapter.write(
        historyPath,
        JSON.stringify(this.conversations, null, 2),
      );
    } catch (err) {
      console.error("[Aide] Error writing history.json:", err);
    }
  }

  private async loadCannedPrompts(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.cannedPromptsFilePath))) {
        this.cannedPrompts = [];
        return;
      }
      const raw = await adapter.read(this.cannedPromptsFilePath);
      const parsed = JSON.parse(raw);
      this.cannedPrompts = Array.isArray(parsed)
        ? parsed.filter(
            (prompt): prompt is CannedPrompt =>
              typeof prompt?.id === "string" &&
              typeof prompt?.title === "string" &&
              typeof prompt?.content === "string",
          )
        : [];
    } catch (err) {
      console.error("[Aide] Error reading prompts.json:", err);
      this.cannedPrompts = [];
    }
  }

  async saveCannedPrompts(): Promise<void> {
    try {
      await this.app.vault.adapter.write(
        this.cannedPromptsFilePath,
        JSON.stringify(this.cannedPrompts, null, 2),
      );
    } catch (err) {
      console.error("[Aide] Error writing prompts.json:", err);
    }
  }
}
