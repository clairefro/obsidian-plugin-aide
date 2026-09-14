import { App, Modal, Setting, setIcon } from "obsidian";
import { Conversation, IAidePlugin } from "../types";

export class ChatHistoryModal extends Modal {
  plugin: IAidePlugin;
  onSelectChat: (chat: Conversation) => void;
  onNewChat: () => void;
  private searchQuery: string = "";

  constructor(
    app: App,
    plugin: IAidePlugin,
    onSelectChat: (chat: Conversation) => void,
    onNewChat: () => void,
  ) {
    super(app);
    this.plugin = plugin;
    this.onSelectChat = onSelectChat;
    this.onNewChat = onNewChat;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lm-copilot-history-modal");

    // Header
    const headerEl = contentEl.createDiv({ cls: "lm-copilot-history-header" });
    headerEl.createEl("h2", { text: "Chat History" });

    const newChatBtn = headerEl.createEl("button", {
      cls: "mod-cta lm-copilot-new-chat-modal-btn",
      text: "+ New Chat",
    });
    newChatBtn.onclick = () => {
      this.close();
      this.onNewChat();
    };

    // Search input
    const searchContainer = contentEl.createDiv({
      cls: "lm-copilot-history-search",
    });
    const searchInput = searchContainer.createEl("input", {
      type: "text",
      placeholder: "Search chats...",
      cls: "lm-copilot-search-input",
    });
    searchInput.oninput = (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.renderHistoryList(listContainer);
    };

    // List container
    const listContainer = contentEl.createDiv({
      cls: "lm-copilot-history-list",
    });
    this.renderHistoryList(listContainer);

    // Clear all option at the bottom if there are chats
    if (this.plugin.conversations.length > 0) {
      const footerEl = contentEl.createDiv({
        cls: "lm-copilot-history-footer",
      });
      const clearBtn = footerEl.createEl("button", {
        cls: "mod-warning lm-copilot-clear-all-btn",
        text: "Clear All History",
      });
      clearBtn.onclick = async () => {
        if (confirm("Are you sure you want to delete all chat history?")) {
          this.plugin.conversations = [];
          await this.plugin.saveConversations();
          this.onNewChat();
          this.close();
        }
      };
    }
  }

  private renderHistoryList(containerEl: HTMLElement): void {
    containerEl.empty();

    const filtered = this.plugin.conversations.filter((c) =>
      (c.title || "Untitled Chat").toLowerCase().includes(this.searchQuery),
    );

    if (filtered.length === 0) {
      const emptyEl = containerEl.createDiv({
        cls: "lm-copilot-history-empty",
      });
      emptyEl.setText(
        this.searchQuery ? "No matching chats found." : "No saved chats yet.",
      );
      return;
    }

    // Sort by updatedAt descending
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);

    for (const chat of filtered) {
      const itemEl = containerEl.createDiv({ cls: "lm-copilot-history-item" });

      const infoEl = itemEl.createDiv({ cls: "lm-copilot-history-info" });
      infoEl.onclick = () => {
        this.onSelectChat(chat);
        this.close();
      };

      const titleEl = infoEl.createDiv({
        cls: "lm-copilot-history-title",
        text: chat.title || "Untitled Chat",
      });

      const metaEl = infoEl.createDiv({ cls: "lm-copilot-history-meta" });
      const dateStr = new Date(chat.updatedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const msgCount = chat.messages ? chat.messages.length : 0;
      metaEl.createSpan({
        text: `${dateStr} · ${msgCount} message${msgCount === 1 ? "" : "s"}`,
      });
      if (chat.model) {
        metaEl.createSpan({
          cls: "lm-copilot-history-model-tag",
          text: chat.model,
        });
      }

      // Action buttons (Rename, Delete)
      const actionsEl = itemEl.createDiv({ cls: "lm-copilot-history-actions" });

      const editBtn = actionsEl.createEl("button", {
        cls: "clickable-icon lm-copilot-icon-btn",
        attr: { "aria-label": "Rename chat" },
      });
      setIcon(editBtn, "pencil");
      editBtn.onclick = (e) => {
        e.stopPropagation();
        const newTitle = prompt("Rename chat title:", chat.title);
        if (newTitle !== null && newTitle.trim()) {
          chat.title = newTitle.trim();
          chat.updatedAt = Date.now();
          this.plugin.saveConversations();
          this.renderHistoryList(containerEl);
        }
      };

      const deleteBtn = actionsEl.createEl("button", {
        cls: "clickable-icon lm-copilot-icon-btn mod-delete",
        attr: { "aria-label": "Delete chat" },
      });
      setIcon(deleteBtn, "trash-2");
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        this.plugin.conversations = this.plugin.conversations.filter(
          (c) => c.id !== chat.id,
        );
        await this.plugin.saveConversations();
        this.renderHistoryList(containerEl);
        // If current active chat is deleted, trigger new chat
        if (this.plugin.currentConversationId === chat.id) {
          this.onNewChat();
        }
      };
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
