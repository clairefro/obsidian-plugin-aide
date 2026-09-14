import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  DropdownComponent,
} from "obsidian";
import type LMStudioCopilotPlugin from "./main";
import { DEFAULT_SETTINGS } from "./types";
import { LMStudioClient } from "./api/lmStudioClient";

export class LMStudioSettingTab extends PluginSettingTab {
  plugin: LMStudioCopilotPlugin;
  private modelDropdown: DropdownComponent | null = null;
  private connectionStatusEl: HTMLElement | null = null;

  constructor(app: App, plugin: LMStudioCopilotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "LM Studio Copilot Settings" });

    // Server Configuration
    new Setting(containerEl)
      .setName("LM Studio Base URL")
      .setDesc(
        "The base URL of your local LM Studio server (usually http://127.0.0.1:1234/v1).",
      )
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:1234/v1")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl =
              value.trim() || DEFAULT_SETTINGS.baseUrl;
            await this.plugin.saveSettings();
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Test & Refresh Models")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            btn.setButtonText("Connecting...");
            await this.refreshModelsList();
            btn.setDisabled(false);
            btn.setButtonText("Test & Refresh Models");
          }),
      );

    this.connectionStatusEl = containerEl.createDiv({
      cls: "lm-copilot-settings-status",
    });

    // Model Selection
    const modelSetting = new Setting(containerEl)
      .setName("Default Model")
      .setDesc("The active or loaded model to query in LM Studio.")
      .addDropdown((dropdown) => {
        this.modelDropdown = dropdown;
        this.populateModelDropdown(dropdown);
        dropdown.onChange(async (val) => {
          this.plugin.settings.selectedModel = val;
          await this.plugin.saveSettings();
          // Notify view if open
          this.plugin.updateModelInViews(val);
        });
      });

    // System Prompt
    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc(
        "The initial system instructions given to the model for every conversation.",
      )
      .addTextArea((text) => {
        text
          .setPlaceholder("Enter system prompt...")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (val) => {
            this.plugin.settings.systemPrompt = val;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
      });

    // Reasoning Models
    new Setting(containerEl)
      .setName("Show Reasoning & Thinking")
      .setDesc(
        "Display reasoning thought chains in collapsible blocks for reasoning models (DeepSeek R1, GPT-OSS, QwQ, etc.).",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showReasoning)
          .onChange(async (val) => {
            this.plugin.settings.showReasoning = val;
            await this.plugin.saveSettings();
          }),
      );

    // Context Settings
    new Setting(containerEl)
      .setName("Include Active Note by Default")
      .setDesc(
        "Automatically attach the current active note as context for new queries. You can always dismiss it with the 'X' button on the context pill in the chat.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeActiveNoteByDefault)
          .onChange(async (val) => {
            this.plugin.settings.includeActiveNoteByDefault = val;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max Context Characters")
      .setDesc(
        "Maximum characters of the active note to send to the model to avoid exceeding context window limits.",
      )
      .addText((text) =>
        text
          .setPlaceholder("24000")
          .setValue(String(this.plugin.settings.maxContextChars))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxContextChars = num;
              await this.plugin.saveSettings();
            }
          }),
      );

    // Advanced Parameters
    containerEl.createEl("h3", { text: "Model Parameters" });

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(
        "Sampling temperature (0.0 = deterministic and focused, 1.0 = creative).",
      )
      .addSlider((slider) =>
        slider
          .setLimits(0.0, 1.5, 0.05)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.temperature = val;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max Output Tokens")
      .setDesc(
        "Maximum tokens to generate per response (-1 or 0 for unlimited / model default).",
      )
      .addText((text) =>
        text
          .setPlaceholder("4096")
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num)) {
              this.plugin.settings.maxTokens = num;
              await this.plugin.saveSettings();
            }
          }),
      );

    // Chat History Settings
    containerEl.createEl("h3", { text: "Chat History" });

    new Setting(containerEl)
      .setName("Save Chat History")
      .setDesc(
        "Automatically persist conversation history across sessions. When disabled, chats exist only in memory during the session.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.saveChatHistory)
          .onChange(async (val) => {
            this.plugin.settings.saveChatHistory = val;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Clear All Chat History")
      .setDesc(
        `Permanently delete all saved chat sessions (${this.plugin.conversations.length} currently saved).`,
      )
      .addButton((btn) =>
        btn
          .setButtonText("Clear History")
          .setWarning()
          .onClick(async () => {
            if (
              confirm(
                "Are you sure you want to delete all chat history? This cannot be undone.",
              )
            ) {
              this.plugin.conversations = [];
              await this.plugin.saveConversations();
              const view = this.plugin.getActiveChatView();
              if (view) {
                view.startNewChat();
              }
              new Notice("Chat history has been cleared.");
              this.display(); // Refresh settings UI to update count
            }
          }),
      );
  }

  private populateModelDropdown(dropdown: DropdownComponent): void {
    dropdown.selectEl.empty();
    if (this.plugin.cachedModels.length === 0) {
      dropdown.addOption("", "No models loaded (click Test & Refresh)");
    } else {
      let found = false;
      for (const model of this.plugin.cachedModels) {
        dropdown.addOption(model.id, model.id);
        if (model.id === this.plugin.settings.selectedModel) {
          found = true;
        }
      }
      if (!found && this.plugin.cachedModels.length > 0) {
        this.plugin.settings.selectedModel = this.plugin.cachedModels[0].id;
        dropdown.setValue(this.plugin.cachedModels[0].id);
      } else {
        dropdown.setValue(this.plugin.settings.selectedModel);
      }
    }
  }

  private async refreshModelsList(): Promise<void> {
    if (!this.connectionStatusEl) return;
    this.connectionStatusEl.empty();

    try {
      const models = await LMStudioClient.fetchModels(
        this.plugin.settings.baseUrl,
      );
      this.plugin.cachedModels = models;

      if (models.length === 0) {
        this.connectionStatusEl.createSpan({
          text: "⚠️ Connected to server, but no models found. Make sure a model is loaded in LM Studio.",
          cls: "lm-copilot-status-warning",
        });
        new Notice("LM Studio connected, but no models found.");
      } else {
        this.connectionStatusEl.createSpan({
          text: `✅ Connected! Found ${models.length} model(s).`,
          cls: "lm-copilot-status-success",
        });
        new Notice(`Found ${models.length} model(s) from LM Studio!`);
        if (
          !this.plugin.settings.selectedModel ||
          !models.some((m) => m.id === this.plugin.settings.selectedModel)
        ) {
          this.plugin.settings.selectedModel = models[0].id;
          await this.plugin.saveSettings();
        }
      }

      if (this.modelDropdown) {
        this.populateModelDropdown(this.modelDropdown);
      }
      this.plugin.updateModelInViews(this.plugin.settings.selectedModel);
    } catch (err: any) {
      this.connectionStatusEl.createSpan({
        text: `❌ Connection failed: ${err.message || "Make sure LM Studio local server is running."}`,
        cls: "lm-copilot-status-error",
      });
      new Notice(
        `Failed to connect to LM Studio at ${this.plugin.settings.baseUrl}`,
      );
    }
  }
}
