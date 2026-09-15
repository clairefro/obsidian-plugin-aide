import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  setIcon,
  Notice,
  TFile,
  MarkdownView,
} from "obsidian";
import {
  ChatMessage,
  Conversation,
  ChatContextItem,
  IAidePlugin,
} from "../types";
import { LMStudioClient } from "../api/lmStudioClient";
import { ChatHistoryModal } from "./HistoryModal";
import { CannedPromptPickerPopover } from "./CannedPromptsModal";

export const AIDE_VIEW_TYPE = "aide-chat-view";

export class AideChatView extends ItemView {
  plugin: IAidePlugin;

  // UI Elements
  private headerEl!: HTMLElement;
  private modelSelectEl!: HTMLSelectElement;
  private contextBarEl!: HTMLElement;
  private messagesContainerEl!: HTMLElement;
  private inputContainerEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private cannedPromptsBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  // State
  private currentConversation: Conversation;
  private isGenerating: boolean = false;
  private currentAbortController: AbortController | null = null;
  private activeContext: ChatContextItem | null = null;
  private isContextManuallyRemoved: boolean = false;
  private cannedPromptsPopover: CannedPromptPickerPopover | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: IAidePlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentConversation = this.createNewConversation();
  }

  getViewType(): string {
    return AIDE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Aide";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("lm-copilot-container");

    this.buildHeader(container);
    this.buildMessagesArea(container);
    this.buildInputArea(container);

    // Load the note that was active before the sidebar received focus.
    this.updateActiveFileContext();

    // Auto-fetch models on view open
    this.refreshModelsDropdown();

    // Render initial welcome or conversation
    this.renderConversation();

    // Auto focus the input textarea when the view is opened
    this.focusInput();
  }

  public focusInput(): void {
    if (this.inputEl) {
      setTimeout(() => {
        this.inputEl.focus();
      }, 50);
    }
  }

  async onClose(): Promise<void> {
    this.cannedPromptsPopover?.close();
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

    const settingsBtn = headerActions.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Open Aide Settings" },
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.onclick = () => this.plugin.openSettings();
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

    this.buildContextBar(this.inputContainerEl);

    const inputWrapper = this.inputContainerEl.createDiv({
      cls: "lm-copilot-input-wrapper",
    });

    this.inputEl = inputWrapper.createEl("textarea", {
      cls: "lm-copilot-textarea",
      attr: {
        placeholder: "Ask Aide...",
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

    this.cannedPromptsBtnEl = inputWrapper.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn lm-copilot-canned-prompts-btn",
      attr: { "aria-label": "Insert canned prompt" },
    });
    setIcon(this.cannedPromptsBtnEl, "list-plus");
    this.cannedPromptsBtnEl.onclick = (event) =>
      this.showCannedPromptsMenu(event);
    this.updateCannedPromptsDropdown();

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

    this.statusEl = this.inputContainerEl.createDiv({
      cls: "lm-copilot-status-bar",
    });
  }

  public updateCannedPromptsDropdown(): void {
    if (!this.cannedPromptsBtnEl) return;
    this.cannedPromptsBtnEl.disabled = false;
  }

  private showCannedPromptsMenu(event: MouseEvent): void {
    event.preventDefault();
    this.cannedPromptsPopover?.close();
    this.cannedPromptsPopover = new CannedPromptPickerPopover(
      this.app,
      this.plugin,
      (prompt) => {
        this.inputEl.value = prompt.content;
        this.inputEl.dispatchEvent(new Event("input"));
        this.inputEl.focus();
      },
      this.cannedPromptsBtnEl,
    );
    this.cannedPromptsPopover.open();
  }

  // -------------------------------------------------------------
  // Context Management
  // -------------------------------------------------------------

  /**
   * Called by main plugin whenever active leaf / file / selection changes.
   */
  public async updateActiveFileContext(): Promise<void> {
    if (this.isContextManuallyRemoved) return;
    if (!this.plugin.settings.includeActiveNoteByDefault) {
      this.activeContext = null;
      this.renderContextPill();
      return;
    }

    const mdView = this.plugin.getContextMarkdownView();
    const activeFile = mdView?.file || this.app.workspace.getActiveFile();

    if (activeFile && activeFile.extension === "md") {
      try {
        const selection = mdView?.editor?.getSelection()?.trim();
        if (selection && selection.length > 0) {
          let content = selection;
          if (content.length > this.plugin.settings.maxContextChars) {
            content =
              content.slice(0, this.plugin.settings.maxContextChars) +
              "\n...[Selection truncated]";
          }
          this.activeContext = {
            type: "selection",
            title: activeFile.basename,
            path: activeFile.path,
            content: content,
          };
        } else {
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
        }
      } catch (err) {
        console.error("Error reading active note / selection context:", err);
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

      const isSelection = this.activeContext.type === "selection";
      const iconSpan = pill.createSpan({ cls: "lm-copilot-context-icon" });
      setIcon(iconSpan, isSelection ? "highlighter" : "file-text");

      const titleSpan = pill.createSpan({
        cls: "lm-copilot-context-title",
        text: isSelection
          ? `${this.activeContext.title}.md (Selection)`
          : `${this.activeContext.title}.md`,
      });
      titleSpan.title = isSelection
        ? `Selected text (${this.activeContext.content.length} chars) from ${this.activeContext.path}`
        : `Full note context from ${this.activeContext.path}`;

      const removeBtn = pill.createSpan({
        cls: "lm-copilot-context-remove",
        attr: { "aria-label": "Remove context" },
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
      const mdView = this.plugin.getContextMarkdownView();
      const activeFile = mdView?.file || this.app.workspace.getActiveFile();
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
    const latestAssistantModel = [...conv.messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.model)?.model;
    if (
      latestAssistantModel &&
      this.plugin.cachedModels.some((m) => m.id === latestAssistantModel)
    ) {
      this.modelSelectEl.value = latestAssistantModel;
      this.plugin.settings.selectedModel = latestAssistantModel;
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
      emptyStateEl.createEl("h3", { text: "Aide" });
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

  private getOrCreateReasoningElements(msgEl: HTMLElement): {
    container: HTMLElement;
    details: HTMLDetailsElement;
    summary: HTMLElement;
    summaryTitle: HTMLElement;
    body: HTMLElement;
  } {
    let container = msgEl.querySelector(
      ".lm-copilot-reasoning-container",
    ) as HTMLElement;
    if (!container) {
      container = msgEl.createDiv({
        cls: "lm-copilot-reasoning-container",
      });
      const headerEl = msgEl.querySelector(".lm-copilot-message-header");
      if (
        headerEl &&
        headerEl.nextSibling &&
        headerEl.nextSibling !== container
      ) {
        msgEl.insertBefore(container, headerEl.nextSibling);
      }
    }

    if (!this.plugin.settings.showReasoning && !this.isGenerating) {
      container.addClass("is-hidden");
    } else {
      container.removeClass("is-hidden");
    }

    let details = container.querySelector(
      ".lm-copilot-reasoning-details",
    ) as HTMLDetailsElement;
    if (!details) {
      details = container.createEl("details", {
        cls: "lm-copilot-reasoning-details",
      });
    }

    let summary = details.querySelector(
      ".lm-copilot-reasoning-summary",
    ) as HTMLElement;
    let summaryTitle: HTMLElement;
    if (!summary) {
      summary = details.createEl("summary", {
        cls: "lm-copilot-reasoning-summary",
      });
      const brainIcon = summary.createSpan({
        cls: "lm-copilot-reasoning-icon",
      });
      setIcon(brainIcon, "cpu");
      summaryTitle = summary.createSpan({
        cls: "lm-copilot-reasoning-title",
        text: "Thinking Process",
      });
    } else {
      summaryTitle = summary.querySelector(
        ".lm-copilot-reasoning-title",
      ) as HTMLElement;
    }

    let body = details.querySelector(
      ".lm-copilot-reasoning-body",
    ) as HTMLElement;
    if (!body) {
      body = details.createDiv({
        cls: "lm-copilot-reasoning-body",
      });
    }

    return { container, details, summary, summaryTitle, body };
  }

  private renderMessageElement(msg: ChatMessage): HTMLElement {
    const msgEl = this.messagesContainerEl.createDiv({
      cls: `lm-copilot-message lm-copilot-message-${msg.role}`,
    });
    msgEl.dataset.messageId = msg.id;

    // Header / badge
    const headerEl = msgEl.createDiv({ cls: "lm-copilot-message-header" });
    const roleName = msg.role === "user" ? "You" : "Aide";
    headerEl.createSpan({ cls: "lm-copilot-message-author", text: roleName });

    // Context badge on user message if applicable
    if (msg.role === "user" && msg.contextIncluded) {
      const contextBadge = headerEl.createSpan({
        cls: "lm-copilot-message-context-badge",
      });
      const isSelection = msg.contextIncluded.title.includes("(Selection)");
      setIcon(contextBadge, isSelection ? "highlighter" : "file-text");
      contextBadge.createSpan({ text: msg.contextIncluded.title });
      contextBadge.title = `Attached context: ${msg.contextIncluded.path}`;
    }

    // Reasoning / Thinking block for Assistant
    if (msg.role === "assistant" && msg.reasoningContent) {
      const reasoningElements = this.getOrCreateReasoningElements(msgEl);
      reasoningElements.body.setText(msg.reasoningContent);
      if (!msg.content) {
        reasoningElements.details.open = true;
      }
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
    } else if (msg.role === "assistant" && msg.reasoningContent) {
      bodyEl.createEl("p", {
        cls: "lm-copilot-reasoning-only-note",
        text: "(Model completed with reasoning output above)",
      });
    }

    // Action bar (Copy, etc.)
    const actionsEl = msgEl.createDiv({ cls: "lm-copilot-message-actions" });

    const insertBtn = actionsEl.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Insert at cursor" },
    });
    setIcon(insertBtn, "file-input");
    insertBtn.onclick = async () => {
      const textToInsert = msg.content || msg.reasoningContent || "";
      if (!textToInsert) {
        new Notice("There is no message text to insert.");
        return;
      }

      const markdownView = this.plugin.getContextMarkdownView();
      const file = markdownView?.file;
      if (!file) {
        new Notice("Open a Markdown note before inserting a message.");
        return;
      }

      if (markdownView.editor) {
        markdownView.editor.replaceRange(
          textToInsert,
          markdownView.editor.getCursor(),
        );
      } else {
        const existingContent = await this.app.vault.cachedRead(file);
        const separator =
          existingContent.endsWith("\n") || !existingContent ? "" : "\n";
        await this.app.vault.append(file, `${separator}${textToInsert}`);
      }

      new Notice("Inserted message into note.");
      setIcon(insertBtn, "check");
      setTimeout(() => setIcon(insertBtn, "file-input"), 1500);
    };

    const copyBtn = actionsEl.createEl("button", {
      cls: "clickable-icon lm-copilot-icon-btn",
      attr: { "aria-label": "Copy Markdown" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.onclick = async () => {
      const textToCopy = msg.content || msg.reasoningContent || "";
      await navigator.clipboard.writeText(textToCopy);
      new Notice("Copied message to clipboard!");
      setIcon(copyBtn, "check");
      setTimeout(() => setIcon(copyBtn, "copy"), 1500);
    };

    return msgEl;
  }

  private scrollToBottom(): void {
    if (!this.messagesContainerEl) return;
    this.messagesContainerEl.scrollTop = this.messagesContainerEl.scrollHeight;
  }

  private scrollExchangeIntoView(userEl?: HTMLElement | null): void {
    if (!this.messagesContainerEl) return;
    const container = this.messagesContainerEl;

    if (userEl) {
      const userTop = userEl.offsetTop;
      const exchangeHeight = container.scrollHeight - userTop;
      // If the current exchange can fit in the viewport, anchor user message at the top
      if (exchangeHeight <= container.clientHeight + 60) {
        container.scrollTop = Math.max(0, userTop - 12);
        return;
      }
    }

    container.scrollTop = container.scrollHeight;
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
    const isSelectionContext = this.activeContext?.type === "selection";
    const userMsg: ChatMessage = {
      id: "msg_" + Date.now() + "_u",
      role: "user",
      content: text,
      timestamp: Date.now(),
      contextIncluded: this.activeContext
        ? {
            title: isSelectionContext
              ? `${this.activeContext.title} (Selection)`
              : this.activeContext.title,
            path: this.activeContext.path,
            preview: this.activeContext.content.slice(0, 300),
          }
        : undefined,
    };

    this.currentConversation.messages.push(userMsg);
    const userMsgEl = this.renderMessageElement(userMsg);
    this.scrollExchangeIntoView(userMsgEl);

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
          const contextHeader =
            this.activeContext.type === "selection"
              ? `[Selected text from Note: "${this.activeContext.title}" (${this.activeContext.path})]`
              : `[Current Note: "${this.activeContext.title}" (${this.activeContext.path})]`;

          messageContent = `${contextHeader}\n\`\`\`markdown\n${this.activeContext.content}\n\`\`\`\n\nUser Question:\n${m.content}`;
        }
        apiMessages.push({
          role: "user",
          content: messageContent,
        });
      } else if (m.role === "assistant") {
        apiMessages.push({
          role: "assistant",
          content: m.content || m.reasoningContent || "",
        });
      }
    }

    // 3. Prepare Assistant Message Placeholder in UI
    this.isGenerating = true;
    this.setGeneratingUI(true);
    this.currentAbortController = new AbortController();

    const assistantMsg: ChatMessage = {
      id: "msg_" + Date.now() + "_a",
      role: "assistant",
      content: "",
      model,
      reasoningContent: "",
      timestamp: Date.now(),
    };

    this.currentConversation.messages.push(assistantMsg);
    const assistantMsgEl = this.renderMessageElement(assistantMsg);
    const bodyEl = assistantMsgEl.querySelector(
      ".lm-copilot-message-body",
    ) as HTMLElement;

    this.scrollExchangeIntoView(userMsgEl);

    // 4. Start Streaming Request
    let accumulatedContent = "";
    let accumulatedReasoning = "";
    let lastRenderTime = 0;

    try {
      this.statusEl.setText("Connecting to model...");

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
            const elements = this.getOrCreateReasoningElements(assistantMsgEl);
            elements.body.setText(accumulatedReasoning);
            if (!elements.details.open) {
              elements.details.open = true;
            }
            if (!accumulatedContent) {
              this.statusEl.setText("Thinking...");
              elements.summaryTitle.setText("Thinking...");
            }
            // Auto scroll to bottom only if reasoning exceeds view
            if (
              this.messagesContainerEl.scrollHeight >
              this.messagesContainerEl.clientHeight + 40
            ) {
              this.scrollToBottom();
            }
          }

          if (contentChunk) {
            accumulatedContent += contentChunk;
            this.statusEl.setText("Generating response...");
            const reasoningElements = assistantMsgEl.querySelector(
              ".lm-copilot-reasoning-container",
            );
            if (reasoningElements) {
              const summaryTitle = reasoningElements.querySelector(
                ".lm-copilot-reasoning-title",
              );
              if (summaryTitle) {
                summaryTitle.setText("Thinking Process");
              }
            }

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
              if (
                this.messagesContainerEl.scrollHeight >
                this.messagesContainerEl.clientHeight + 40
              ) {
                this.scrollToBottom();
              }
            }
          }
        },
      });

      assistantMsg.content = (result.fullContent || accumulatedContent).trim();
      assistantMsg.reasoningContent = (
        result.fullReasoning || accumulatedReasoning
      ).trim();

      // Ensure reasoning and answer are properly parsed and separated
      if (assistantMsg.reasoningContent && !assistantMsg.content) {
        const split = LMStudioClient.splitReasoningAndAnswer(
          assistantMsg.reasoningContent,
        );
        if (split.answer && split.reasoning) {
          assistantMsg.content = split.answer;
          assistantMsg.reasoningContent = split.reasoning;
        }
      } else if (assistantMsg.content && !assistantMsg.reasoningContent) {
        const split = LMStudioClient.splitReasoningAndAnswer(
          assistantMsg.content,
        );
        if (split.reasoning && split.answer) {
          assistantMsg.content = split.answer;
          assistantMsg.reasoningContent = split.reasoning;
        }
      }

      // Always maintain reasoning block in DOM if reasoningContent is present
      const reasoningEl = assistantMsgEl.querySelector(
        ".lm-copilot-reasoning-container",
      ) as HTMLElement;

      if (assistantMsg.reasoningContent) {
        const elements = this.getOrCreateReasoningElements(assistantMsgEl);
        elements.body.setText(assistantMsg.reasoningContent);
        elements.summaryTitle.setText("Thinking Process");

        // Collapse accordion when final answer is available, or leave open if only reasoning
        elements.details.open = !assistantMsg.content;
        elements.details.ontoggle = () => {
          this.scrollExchangeIntoView(userMsgEl);
        };

        if (!this.plugin.settings.showReasoning) {
          elements.container.addClass("is-hidden");
        } else {
          elements.container.removeClass("is-hidden");
        }
      } else if (reasoningEl) {
        reasoningEl.addClass("is-hidden");
      }

      // Render final body markdown
      bodyEl.empty();
      if (!assistantMsg.content && assistantMsg.reasoningContent) {
        const completionNote =
          result.finishReason === "length"
            ? "Model reached the output-token limit while reasoning, before it produced a final response. Increase Max Output Tokens and try again."
            : "Model completed with reasoning output but did not produce a separate final response.";
        bodyEl.createEl("p", {
          cls: "lm-copilot-reasoning-only-note",
          text: completionNote,
        });
      } else {
        await MarkdownRenderer.render(
          this.app,
          assistantMsg.content,
          bodyEl,
          this.activeContext?.path || "",
          this,
        );
      }
    } catch (err: any) {
      if (
        err.name === "AbortError" ||
        this.currentAbortController?.signal.aborted
      ) {
        assistantMsg.content =
          accumulatedContent + "\n\n*[Generation stopped by user]*";
      } else {
        console.error("[Aide] Stream error:", err);
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
      this.scrollExchangeIntoView(userMsgEl);
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
