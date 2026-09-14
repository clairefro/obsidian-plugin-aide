import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  setIcon,
  Notice,
  TFile,
  MarkdownView,
} from "obsidian";
import type LMStudioCopilotPlugin from "../main";
import { ChatMessage, Conversation, ChatContextItem } from "../types";
import { LMStudioClient } from "../api/lmStudioClient";
import { ChatHistoryModal } from "./HistoryModal";

export const LM_STUDIO_VIEW_TYPE = "lm-studio-copilot-view";

export class LMStudioChatView extends ItemView {
  plugin: LMStudioCopilotPlugin;

  // UI Elements
  private headerEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private contextBarEl!: HTMLElement;
  private messagesContainerEl!: HTMLElement;
  private inputContainerEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  // State
  private currentConversation: Conversation;
  private isGenerating: boolean = false;
  private currentAbortController: AbortController | null = null;
  private activeContext: ChatContextItem | null = null;
  private isContextManuallyRemoved: boolean = false;

  constructor(leaf: WorkspaceLeaf, plugin: LMStudioCopilotPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentConversation = this.createNewConversation();
  }

  getViewType(): string {
    return LM_STUDIO_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "LM Studio Copilot";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("lm-copilot-container");

    this.buildHeader(container);
    this.buildContextBar(container);
    this.buildMessagesArea(container);
    this.buildInputArea(container);

    // Load active file context initially
    this.updateActiveFileContext();

    // Auto-fetch models on view open
    this.refreshModelsDropdown();

    // Render initial welcome or conversation
    this.renderConversation();
  }

  async onClose(): Promise<void> {
    this.stopGeneration();
  }

  // -------------------------------------------------------------
  // UI Builder Methods
  // -------------------------------------------------------------

  private buildHeader(parent: HTMLElement): void {
    this.headerEl = parent.createDiv({ cls: "lm-copilot-header" });

    // Left side: Model dropdown and refresh button
    const modelGroup = this.headerEl.createDiv({
      cls: "lm-copilot-model-group",
    });

    this.modelSelectEl = modelGroup.createEl("select", {
      cls: "lm-copilot-model-select",
    });
    this.modelSelectEl.onchange = async () => {
      this.plugin.settings.selectedModel = this.modelSelectEl.value;
      this.currentConversation.model = this.modelSelectEl.value;
      await this.plugin.saveSettings();
    };

    const refreshBtn = modelGroup.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Refresh Models from LM Studio" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.onclick = async () => {
      refreshBtn.addClass("lm-spinning");
      await this.refreshModelsDropdown();
      refreshBtn.removeClass("lm-spinning");
    };

    // Right side: New Chat & History buttons
    const headerActions = this.headerEl.createDiv({
      cls: "lm-copilot-header-actions",
    });

    const newChatBtn = headerActions.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "New Chat" },
    });
    setIcon(newChatBtn, "plus");
    newChatBtn.onclick = () => this.startNewChat();

    const historyBtn = headerActions.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Chat History" },
    });
    setIcon(historyBtn, "history");
    historyBtn.onclick = () => {
      new ChatHistoryModal(
        this.app,
        this.plugin,
        (selectedChat) => this.loadConversation(selectedChat),
        () => this.startNewChat(),
      ).open();
    };
  }

  private buildContextBar(parent: HTMLElement): void {
    this.contextBarEl = parent.createDiv({ cls: "lm-copilot-context-bar" });
    this.renderContextPill();
  }

  private buildMessagesArea(parent: HTMLElement): void {
    this.messagesContainerEl = parent.createDiv({
      cls: "lm-copilot-messages-container",
    });
  }

  private buildInputArea(parent: HTMLElement): void {
    this.inputContainerEl = parent.createDiv({
      cls: "lm-copilot-input-container",
    });

    this.statusEl = this.inputContainerEl.createDiv({
      cls: "lm-copilot-status-bar",
    });

    const inputWrapper = this.inputContainerEl.createDiv({
      cls: "lm-copilot-input-wrapper",
    });

    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "lm-copilot-textarea",
      attr: {
        placeholder: "Ask Copilot... (Shift+Enter for newline)",
        rows: "1",
      },
    });

    // Auto-resize input textarea
    this.inputEl.oninput = () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height =
        Math.min(this.inputEl.scrollHeight, 180) + "px";
    };

    // Keydown handlers (Enter to submit, Shift+Enter for newline)
    this.inputEl.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSendMessage();
      }
    };

    const buttonsWrapper = inputWrapper.createDiv({
      cls: "lm-copilot-buttons-wrapper",
    });

    this.sendBtnEl = buttonsWrapper.createEl("button", {
      cls: "clickable-icon lm-copilot-send-btn",
      attr: { "aria-label": "Send Message" },
    });
    setIcon(this.sendBtnEl, "send");
    this.sendBtnEl.onclick = () => this.handleSendMessage();

    this.stopBtnEl = buttonsWrapper.createEl("button", {
      cls: "clickable-icon lm-copilot-stop-btn is-hidden",
      attr: { "aria-label": "Stop Generation" },
    });
    setIcon(this.stopBtnEl, "square");
    this.stopBtnEl.onclick = () => this.stopGeneration();
  }

  // -------------------------------------------------------------
  // Context Management
  // -------------------------------------------------------------

  /**
   * Called by main plugin whenever active leaf / file changes.
   */
  public async updateActiveFileContext(): Promise<void> {
    if (this.isContextManuallyRemoved) return;
    if (!this.plugin.settings.includeActiveNoteByDefault) {
      this.activeContext = null;
      this.renderContextPill();
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      try {
        let content = await this.app.vault.cachedRead(activeFile);
        if (content.length > this.plugin.settings.maxContextChars) {
          content =
            content.slice(0, this.plugin.settings.maxContextChars) +
            "\n...[Context truncated]";
        }
        this.activeContext = {
          type: "active_note",
          title: activeFile.basename,
          path: activeFile.path,
          content: content,
        };
      } catch (err) {
        console.error("Error reading active note context:", err);
        this.activeContext = null;
      }
    } else {
      this.activeContext = null;
    }

    this.renderContextPill();
  }

  private renderContextPill(): void {
    this.contextBarEl.empty();

    if (this.activeContext) {
      const pill = this.contextBarEl.createDiv({
        cls: "lm-copilot-context-pill",
      });

      const iconSpan = pill.createSpan({ cls: "lm-copilot-context-icon" });
      setIcon(iconSpan, "file-text");

      const titleSpan = pill.createSpan({
        cls: "lm-copilot-context-title",
        text: `${this.activeContext.title}.md`,
      });
      titleSpan.title = `Context from ${this.activeContext.path}`;

      const removeBtn = pill.createSpan({
        cls: "lm-copilot-context-remove",
        attr: { "aria-label": "Remove note context" },
      });
      setIcon(removeBtn, "x");
      removeBtn.onclick = (e) => {
        e.stopPropagation();
        this.activeContext = null;
        this.isContextManuallyRemoved = true;
        this.renderContextPill();
      };
    } else {
      // Show re-attach button if note is available in workspace
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension === "md") {
        const attachBtn = this.contextBarEl.createDiv({
          cls: "lm-copilot-context-attach-btn",
        });
        const iconSpan = attachBtn.createSpan({
          cls: "lm-copilot-context-icon",
        });
        setIcon(iconSpan, "paperclip");
        attachBtn.createSpan({ text: `Attach ${activeFile.basename}.md` });

        attachBtn.onclick = () => {
          this.isContextManuallyRemoved = false;
          this.updateActiveFileContext();
        };
      }
    }
  }

  // -------------------------------------------------------------
  // Models Management
  // -------------------------------------------------------------

  public async refreshModelsDropdown(): Promise<void> {
    try {
      const models = await LMStudioClient.fetchModels(
        this.plugin.settings.baseUrl,
      );
      this.plugin.cachedModels = models;
      this.updateModelDropdown(this.plugin.settings.selectedModel);
    } catch (err) {
      this.updateModelDropdown(this.plugin.settings.selectedModel);
    }
  }

  public updateModelDropdown(selectedModelId?: string): void {
    if (!this.modelSelectEl) return;
    this.modelSelectEl.empty();

    const models = this.plugin.cachedModels;
    if (models.length === 0) {
      const opt = this.modelSelectEl.createEl("option", {
        value: "",
        text: "No models found (check LM Studio)",
      });
      opt.disabled = true;
      opt.selected = true;
      return;
    }

    let selectedExists = false;
    for (const m of models) {
      const opt = this.modelSelectEl.createEl("option", {
        value: m.id,
        text: m.id,
      });
      if (selectedModelId && m.id === selectedModelId) {
        opt.selected = true;
        selectedExists = true;
      }
    }

    if (!selectedExists && models.length > 0) {
      this.modelSelectEl.value = models[0].id;
      this.plugin.settings.selectedModel = models[0].id;
      this.plugin.saveSettings();
    }
  }

  // -------------------------------------------------------------
  // Conversation Flow & Rendering
  // -------------------------------------------------------------

  private createNewConversation(): Conversation {
    const newConv: Conversation = {
      id:
        "conv_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7),
      title: "New Chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: this.plugin.settings.selectedModel || "",
    };
    this.plugin.currentConversationId = newConv.id;
    return newConv;
  }

  public startNewChat(): void {
    if (this.isGenerating) {
      this.stopGeneration();
    }
    this.isContextManuallyRemoved = false;
    this.currentConversation = this.createNewConversation();
    this.updateActiveFileContext();
    this.renderConversation();
    this.inputEl.value = "";
    this.inputEl.focus();
  }

  public loadConversation(conv: Conversation): void {
    if (this.isGenerating) {
      this.stopGeneration();
    }
    this.currentConversation = conv;
    this.plugin.currentConversationId = conv.id;
    if (
      conv.model &&
      this.plugin.cachedModels.some((m) => m.id === conv.model)
    ) {
      this.modelSelectEl.value = conv.model;
      this.plugin.settings.selectedModel = conv.model;
    }
    this.renderConversation();
  }

  private renderConversation(): void {
    this.messagesContainerEl.empty();

    if (this.currentConversation.messages.length === 0) {
      const emptyStateEl = this.messagesContainerEl.createDiv({
        cls: "lm-copilot-empty-state",
      });
      const iconEl = emptyStateEl.createDiv({ cls: "lm-copilot-empty-icon" });
      setIcon(iconEl, "sparkles");
      emptyStateEl.createEl("h3", { text: "LM Studio Copilot" });
      emptyStateEl.createEl("p", {
        text: "Ask questions, brainstorm ideas, analyze notes, or write content with your local LLMs.",
      });
      return;
    }

    for (const msg of this.currentConversation.messages) {
      this.renderMessageElement(msg);
    }

    this.scrollToBottom();
  }

  private renderMessageElement(msg: ChatMessage): HTMLElement {
    const msgEl = this.messagesContainerEl.createDiv({
      cls: `lm-copilot-message lm-copilot-message-${msg.role}`,
    });
    msgEl.dataset.messageId = msg.id;

    // Header / badge
    const headerEl = msgEl.createDiv({ cls: "lm-copilot-message-header" });
    const roleName = msg.role === "user" ? "You" : "Copilot";
    headerEl.createSpan({ cls: "lm-copilot-message-author", text: roleName });

    // Context badge on user message if applicable
    if (msg.role === "user" && msg.contextIncluded) {
      const contextBadge = headerEl.createSpan({
        cls: "lm-copilot-message-context-badge",
      });
      setIcon(contextBadge, "file-text");
      contextBadge.createSpan({ text: msg.contextIncluded.title });
      contextBadge.title = `Attached note: ${msg.contextIncluded.path}`;
    }

    // Reasoning / Thinking block for Assistant
    if (
      msg.role === "assistant" &&
      (msg.reasoningContent || this.isGenerating)
    ) {
      const reasoningContainer = msgEl.createDiv({
        cls: "lm-copilot-reasoning-container",
      });
      if (!this.plugin.settings.showReasoning && !this.isGenerating) {
        reasoningContainer.addClass("is-hidden");
      }

      const detailsEl = reasoningContainer.createEl("details", {
        cls: "lm-copilot-reasoning-details",
      });
      // Open reasoning block by default during active thinking
      if (this.isGenerating && !msg.content) {
        detailsEl.open = true;
      }

      const summaryEl = detailsEl.createEl("summary", {
        cls: "lm-copilot-reasoning-summary",
      });
      const brainIcon = summaryEl.createSpan({
        cls: "lm-copilot-reasoning-icon",
      });
      setIcon(brainIcon, "cpu");
      summaryEl.createSpan({
        cls: "lm-copilot-reasoning-title",
        text: "Thinking Process",
      });

      const reasoningBodyEl = detailsEl.createDiv({
        cls: "lm-copilot-reasoning-body",
        text: msg.reasoningContent || "",
      });
    }

    // Message content markdown body
    const bodyEl = msgEl.createDiv({
      cls: "lm-copilot-message-body markdown-rendered",
    });
    if (msg.content) {
      MarkdownRenderer.render(
        this.app,
        msg.content,
        bodyEl,
        this.activeContext?.path || "",
        this,
      );
    }

    // Action bar (Copy, etc.)
    const actionsEl = msgEl.createDiv({ cls: "lm-copilot-message-actions" });

    const copyBtn = actionsEl.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Copy Markdown" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(msg.content);
      new Notice("Copied message to clipboard!");
      setIcon(copyBtn, "check");
      setTimeout(() => setIcon(copyBtn, "copy"), 1500);
    };

    return msgEl;
  }

  private scrollToBottom(): void {
    this.messagesContainerEl.scrollTop = this.messagesContainerEl.scrollHeight;
  }

  // -------------------------------------------------------------
  // Chat Generation Logic
  // -------------------------------------------------------------

  private async handleSendMessage(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isGenerating) return;

    const model =
      this.modelSelectEl.value || this.plugin.settings.selectedModel;
    if (!model) {
      new Notice("Please select or load a model in LM Studio first.");
      return;
    }

    // If this is the first message, remove empty state
    if (this.currentConversation.messages.length === 0) {
      this.messagesContainerEl.empty();
    }

    // 1. Prepare User Message with optional context
    const userMsg: ChatMessage = {
      id: "msg_" + Date.now() + "_u",
      role: "user",
      content: text,
      timestamp: Date.now(),
      contextIncluded: this.activeContext
        ? {
            title: this.activeContext.title,
            path: this.activeContext.path,
            preview: this.activeContext.content.slice(0, 300),
          }
        : undefined,
    };

    this.currentConversation.messages.push(userMsg);
    this.renderMessageElement(userMsg);
    this.scrollToBottom();

    // Auto-title conversation from first query
    if (
      this.currentConversation.messages.length === 1 &&
      this.currentConversation.title === "New Chat"
    ) {
      const generatedTitle = text.slice(0, 32).replace(/[\r\n]+/g, " ");
      this.currentConversation.title = generatedTitle;
    }

    // Clear input box
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";

    // 2. Prepare API message history with context injection
    const apiMessages: Array<{ role: string; content: string }> = [];

    // System prompt
    if (this.plugin.settings.systemPrompt) {
      apiMessages.push({
        role: "system",
        content: this.plugin.settings.systemPrompt,
      });
    }

    // Map conversation history
    for (let i = 0; i < this.currentConversation.messages.length; i++) {
      const m = this.currentConversation.messages[i];
      if (m.role === "user") {
        let messageContent = m.content;
        // If this message had context attached, format context block
        if (
          m.contextIncluded &&
          i === this.currentConversation.messages.length - 1 &&
          this.activeContext
        ) {
          messageContent = `[Current Note: "${this.activeContext.title}" (${this.activeContext.path})]\n\`\`\`markdown\n${this.activeContext.content}\n\`\`\`\n\nUser Question:\n${m.content}`;
        }
        apiMessages.push({
          role: "user",
          content: messageContent,
        });
      } else if (m.role === "assistant") {
        apiMessages.push({
          role: "assistant",
          content: m.content,
        });
      }
    }

    // 3. Prepare Assistant Message Placeholder in UI
    const assistantMsg: ChatMessage = {
      id: "msg_" + Date.now() + "_a",
      role: "assistant",
      content: "",
      reasoningContent: "",
      timestamp: Date.now(),
    };

    this.currentConversation.messages.push(assistantMsg);
    const assistantMsgEl = this.renderMessageElement(assistantMsg);
    const reasoningContainer = assistantMsgEl.querySelector(
      ".lm-copilot-reasoning-container",
    ) as HTMLElement;
    const reasoningDetails = assistantMsgEl.querySelector(
      ".lm-copilot-reasoning-details",
    ) as HTMLDetailsElement;
    const reasoningBody = assistantMsgEl.querySelector(
      ".lm-copilot-reasoning-body",
    ) as HTMLElement;
    const bodyEl = assistantMsgEl.querySelector(
      ".lm-copilot-message-body",
    ) as HTMLElement;

    this.scrollToBottom();

    // 4. Start Streaming Request
    this.isGenerating = true;
    this.setGeneratingUI(true);
    this.currentAbortController = new AbortController();

    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastRenderTime = 0;

    try {
      this.statusEl.setText("Generating response...");

      const result = await LMStudioClient.streamChat({
        baseUrl: this.plugin.settings.baseUrl,
        model: model,
        messages: apiMessages,
        temperature: this.plugin.settings.temperature,
        maxTokens: this.plugin.settings.maxTokens,
        signal: this.currentAbortController.signal,
        onToken: (contentChunk, reasoningChunk) => {
          if (reasoningChunk) {
            accumulatedReasoning += reasoningChunk;
            if (reasoningBody) {
              reasoningBody.setText(accumulatedReasoning);
            }
            if (reasoningDetails && !reasoningDetails.open) {
              reasoningDetails.open = true;
            }
          }

          if (contentChunk) {
            accumulatedContent += contentChunk;
            // Throttle markdown rendering during stream for responsiveness
            const now = Date.now();
            if (now - lastRenderTime > 80) {
              bodyEl.empty();
              MarkdownRenderer.render(
                this.app,
                accumulatedContent,
                bodyEl,
                this.activeContext?.path || "",
                this,
              );
              lastRenderTime = now;
              this.scrollToBottom();
            }
          }
        },
      });

      assistantMsg.content = result.fullContent || accumulatedContent;
      assistantMsg.reasoningContent =
        result.fullReasoning || accumulatedReasoning;

      // Final clean Markdown render
      bodyEl.empty();
      await MarkdownRenderer.render(
        this.app,
        assistantMsg.content,
        bodyEl,
        this.activeContext?.path || "",
        this,
      );

      // Collapse reasoning details after completion if there is content
      if (reasoningDetails && assistantMsg.content) {
        reasoningDetails.open = false;
      }
    } catch (err: any) {
      if (
        err.name === "AbortError" ||
        this.currentAbortController?.signal.aborted
      ) {
        assistantMsg.content =
          accumulatedContent + "\n\n*[Generation stopped by user]*";
      } else {
        console.error("[LM Studio Copilot] Stream error:", err);
        assistantMsg.content =
          accumulatedContent +
          `\n\n> ⚠️ **Error:** ${err.message || "Failed to communicate with LM Studio."}`;
      }
      bodyEl.empty();
      await MarkdownRenderer.render(
        this.app,
        assistantMsg.content,
        bodyEl,
        this.activeContext?.path || "",
        this,
      );
    } finally {
      this.isGenerating = false;
      this.currentAbortController = null;
      this.setGeneratingUI(false);
      this.statusEl.empty();

      this.currentConversation.updatedAt = Date.now();
      await this.saveActiveConversation();
      this.scrollToBottom();
    }
  }

  private stopGeneration(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
    this.isGenerating = false;
    this.setGeneratingUI(false);
    this.statusEl.empty();
  }

  private setGeneratingUI(isGenerating: boolean): void {
    if (isGenerating) {
      this.sendBtnEl.addClass("is-hidden");
      this.stopBtnEl.removeClass("is-hidden");
    } else {
      this.sendBtnEl.removeClass("is-hidden");
      this.stopBtnEl.addClass("is-hidden");
    }
  }

  private async saveActiveConversation(): Promise<void> {
    if (!this.plugin.settings.saveChatHistory) {
      return;
    }
    const idx = this.plugin.conversations.findIndex(
      (c) => c.id === this.currentConversation.id,
    );
    if (idx >= 0) {
      this.plugin.conversations[idx] = this.currentConversation;
    } else {
      this.plugin.conversations.push(this.currentConversation);
    }
    await this.plugin.saveConversations();
  }
}
