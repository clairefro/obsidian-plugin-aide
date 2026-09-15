import { App, Modal, Notice, setIcon } from "obsidian";
import { CannedPrompt, IAidePlugin } from "../types";

export class CannedPromptsModal extends Modal {
  constructor(
    app: App,
    private plugin: IAidePlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("lm-copilot-prompts-modal");

    const header = contentEl.createDiv({ cls: "lm-copilot-history-header" });
    header.createEl("h2", { text: "Canned Prompts" });

    const addButton = header.createEl("button", {
      cls: "mod-cta",
      text: "New Prompt",
    });
    addButton.onclick = () => this.openEditor();

    const actions = contentEl.createDiv({
      cls: "lm-copilot-prompt-file-actions",
    });
    const importButton = actions.createEl("button", { text: "Import JSON" });
    importButton.onclick = () => this.importPrompts();
    const exportButton = actions.createEl("button", { text: "Export JSON" });
    exportButton.onclick = () => this.exportPrompts();

    const list = contentEl.createDiv({ cls: "lm-copilot-history-list" });
    if (this.plugin.cannedPrompts.length === 0) {
      list.createDiv({
        cls: "lm-copilot-history-empty",
        text: "No saved prompts yet.",
      });
      return;
    }

    for (const prompt of this.plugin.cannedPrompts) {
      const item = list.createDiv({ cls: "lm-copilot-history-item" });
      const info = item.createDiv({ cls: "lm-copilot-history-info" });
      info.createDiv({ cls: "lm-copilot-history-title", text: prompt.title });
      info.createDiv({
        cls: "lm-copilot-history-meta",
        text: prompt.content.replace(/\s+/g, " ").slice(0, 100),
      });
      info.onclick = () => this.openEditor(prompt);

      const itemActions = item.createDiv({ cls: "lm-copilot-history-actions" });
      const editButton = itemActions.createEl("button", {
        cls: "clickable-icon lm-copilot-icon-btn",
        attr: { "aria-label": `Edit ${prompt.title}` },
      });
      setIcon(editButton, "pencil");
      editButton.onclick = () => this.openEditor(prompt);

      const deleteButton = itemActions.createEl("button", {
        cls: "clickable-icon lm-copilot-icon-btn mod-delete",
        attr: { "aria-label": `Delete ${prompt.title}` },
      });
      setIcon(deleteButton, "trash-2");
      deleteButton.onclick = async () => {
        this.plugin.cannedPrompts = this.plugin.cannedPrompts.filter(
          (item) => item.id !== prompt.id,
        );
        await this.plugin.saveCannedPrompts();
        this.plugin.updateCannedPromptsInViews();
        this.render();
      };
    }
  }

  private openEditor(prompt?: CannedPrompt): void {
    new CannedPromptEditorModal(this.app, this.plugin, prompt, () =>
      this.render(),
    ).open();
  }

  private importPrompts(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const imported = JSON.parse(await file.text());
        if (!Array.isArray(imported))
          throw new Error("Expected an array of prompts.");
        const now = Date.now();
        const validPrompts = imported
          .filter(
            (item) =>
              typeof item?.title === "string" &&
              typeof item?.content === "string",
          )
          .map((item) => ({
            id:
              typeof item.id === "string"
                ? item.id
                : `prompt_${now}_${Math.random().toString(36).slice(2, 7)}`,
            title: item.title.trim(),
            content: item.content,
            createdAt:
              typeof item.createdAt === "number" ? item.createdAt : now,
            updatedAt: now,
          }))
          .filter((item) => item.title && item.content);
        if (validPrompts.length === 0)
          throw new Error("No valid prompts found.");
        this.plugin.cannedPrompts = validPrompts;
        await this.plugin.saveCannedPrompts();
        this.plugin.updateCannedPromptsInViews();
        this.render();
        new Notice(`Imported ${validPrompts.length} canned prompt(s).`);
      } catch (error: any) {
        new Notice(`Could not import prompts: ${error.message}`);
      }
    };
    input.click();
  }

  private exportPrompts(): void {
    const blob = new Blob(
      [JSON.stringify(this.plugin.cannedPrompts, null, 2)],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "aide-prompts.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class CannedPromptEditorModal extends Modal {
  constructor(
    app: App,
    private plugin: IAidePlugin,
    private prompt: CannedPrompt | undefined,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", {
      text: this.prompt ? "Edit Prompt" : "New Prompt",
    });
    const titleInput = contentEl.createEl("input", {
      type: "text",
      value: this.prompt?.title || "",
      placeholder: "Prompt name",
    });
    titleInput.addClass("lm-copilot-prompt-editor-title");
    const contentInput = contentEl.createEl("textarea", {
      text: this.prompt?.content || "",
      attr: { placeholder: "Prompt text" },
    });
    contentInput.addClass("lm-copilot-prompt-editor-content");
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.onclick = () => this.close();
    const saveButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Save",
    });
    saveButton.onclick = async () => {
      const title = titleInput.value.trim();
      const content = contentInput.value.trim();
      if (!title || !content) {
        new Notice("A prompt needs both a name and text.");
        return;
      }
      const now = Date.now();
      const savedPrompt: CannedPrompt = {
        id:
          this.prompt?.id ||
          `prompt_${now}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        content,
        createdAt: this.prompt?.createdAt || now,
        updatedAt: now,
      };
      const index = this.plugin.cannedPrompts.findIndex(
        (item) => item.id === savedPrompt.id,
      );
      if (index >= 0) this.plugin.cannedPrompts[index] = savedPrompt;
      else this.plugin.cannedPrompts.push(savedPrompt);
      await this.plugin.saveCannedPrompts();
      this.plugin.updateCannedPromptsInViews();
      this.onSaved();
      this.close();
    };
    titleInput.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
