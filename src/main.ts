import { Plugin, WorkspaceLeaf, Notice } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  Conversation,
  LMStudioModel,
} from "./types";
import { LMStudioSettingTab } from "./settings";
import { LMStudioChatView, LM_STUDIO_VIEW_TYPE } from "./views/ChatView";
import { LMStudioClient } from "./api/lmStudioClient";
import { ChatHistoryModal } from "./views/HistoryModal";

interface PluginData {
  settings: PluginSettings;
  conversations: Conversation[];
}

export default class LMStudioPersonalPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  conversations: Conversation[] = [];
  currentConversationId: string = "";
  cachedModels: LMStudioModel[] = [];

  async onload(): Promise<void> {
    console.log("[LM Studio Personal] Loading plugin");
    await this.loadPluginData();

    // Register Sidebar View
    this.registerView(
      LM_STUDIO_VIEW_TYPE,
      (leaf) => new LMStudioChatView(leaf, this),
    );

    // Ribbon Icon to open sidebar
    this.addRibbonIcon("bot", "Open LM Studio Personal", () => {
      this.activateView();
    });

    // Commands
    this.addCommand({
      id: "open-lm-studio-personal-view",
      name: "Open sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-lm-studio-chat",
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
      id: "view-lm-studio-chat-history",
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
    this.addSettingTab(new LMStudioSettingTab(this.app, this));

    // Listen to active leaf change to automatically update active note context
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.updateContextInViews();
      }),
    );

    // Initial background model fetch if URL is configured
    this.fetchModelsInBackground();
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(LM_STUDIO_VIEW_TYPE);
  }

  // -------------------------------------------------------------
  // View Lifecycle & Helpers
  // -------------------------------------------------------------

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(LM_STUDIO_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      // Open in right sidebar leaf
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: LM_STUDIO_VIEW_TYPE,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  public getActiveChatView(): LMStudioChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(LM_STUDIO_VIEW_TYPE);
    if (leaves.length > 0) {
      return leaves[0].view as LMStudioChatView;
    }
    return null;
  }

  public updateContextInViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(LM_STUDIO_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof LMStudioChatView) {
        leaf.view.updateActiveFileContext();
      }
    }
  }

  public updateModelInViews(modelId: string): void {
    const leaves = this.app.workspace.getLeavesOfType(LM_STUDIO_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof LMStudioChatView) {
        leaf.view.updateModelDropdown(modelId);
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
    const data: PluginData = await this.loadData();
    if (data) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
      this.conversations = Array.isArray(data.conversations)
        ? data.conversations
        : [];
    } else {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      this.conversations = [];
    }
  }

  async saveSettings(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      conversations: this.conversations,
    };
    await this.saveData(data);
  }

  async saveConversations(): Promise<void> {
    const data: PluginData = {
      settings: this.settings,
      conversations: this.conversations,
    };
    await this.saveData(data);
  }
}
