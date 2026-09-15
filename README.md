# Aide for Obsidian

An AI assistant right-sidebar experience for Obsidian that connects seamlessly to your local **LM Studio** server.

## Features

- **Aide Right-Sidebar Experience**: A native Obsidian right-sidebar view for chatting with your local LLMs while browsing and writing notes.
- **Local LM Studio Integration**: Connects directly to LM Studio's OpenAI-compatible server (defaults to `http://127.0.0.1:1234/v1`).
- **Reasoning Models & Thinking Block**: Native support for reasoning models (e.g., DeepSeek R1, GPT-OSS, QwQ) with collapsible **Thinking Process** accordions that capture `<think>` tags and streaming `reasoning_content` deltas.
- **Active Note & Selection Context**: Automatically attaches your currently selected text (or the active note if no text is selected) as context for the query. Features a context pill with an `[x]` button to dismiss context at any time, and an attach button to re-attach whenever desired.
- **Dynamic Model Switching**: Pulls all available/loaded models directly from your local LM Studio instance into a dropdown with one-click refresh.
- **Conversation History & Management**: Start new chats, search past conversations, rename, and delete chat history saved locally in your Obsidian vault.
- **Fast Streaming Markdown**: Real-time token streaming with live Markdown rendering using Obsidian's native renderer and quick copy-to-clipboard actions.
- **Future-Ready Architecture**: Built-in structured parameters for tool calling (e.g., web search, vault query) for future expansion.

---

## Getting Started

### 1. Start LM Studio Server

1. Open **LM Studio**.
2. Load any model (e.g., `Meta-Llama-3.1-8B-Instruct`, `DeepSeek-R1-Distill-Qwen`, `Phi-3.5-mini`, etc.).
3. Navigate to the **Local Server** tab (`<->` icon).
4. Click **Start Server** (default is `http://localhost:1234`).
5. Ensure CORS / local network requests are enabled if prompted.

### 2. Enable Plugin in Obsidian

1. In Obsidian, go to **Settings** -> **Community plugins** -> Enable **Aide**.
2. Click the robot icon in the left ribbon or run the command **"Open sidebar"** from the Command Palette (`Ctrl/Cmd + P`).
3. The Aide panel will open in the right sidebar.

---

## Settings

- **Base URL**: Set your LM Studio API endpoint (default: `http://127.0.0.1:1234/v1`). Includes a **"Test & Refresh Models"** button.
- **Default Model**: Select which model to use by default.
- **System Prompt**: Customize the personality and behavior instructions sent to the model.
- **Show Reasoning**: Toggle visibility of thinking traces for reasoning models.
- **Include Active Note by Default**: Enable or disable automatic context attachment.
- **Max Context Characters**: Limit context size to prevent exceeding model context windows.
- **Save Chat History**: Enable or disable persisting chat history to vault storage.
- **Clear All Chat History**: Delete all saved chat history with confirmation prompt.
- **Temperature & Max Output Tokens**: Fine-tune inference sampling.

---

## Shortcuts & Commands

- `Enter`: Send message
- `Shift + Enter`: Insert new line
- `Command Palette`:
  - `Aide: Open in side panel`
  - `Aide: New chat session`
  - `Aide: View chat history`
  - `Aide: Refresh available models from LM Studio`
