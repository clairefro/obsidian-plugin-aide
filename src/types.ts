import type { MarkdownView } from "obsidian";

export interface PluginSettings {
  baseUrl: string;
  selectedModel: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  includeActiveNoteByDefault: boolean;
  maxContextChars: number;
  autoTitleChat: boolean;
  showReasoning: boolean;
  saveChatHistory: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  baseUrl: "http://127.0.0.1:1234/v1",
  selectedModel: "",
  systemPrompt:
    "You are Aide, an expert AI assistant integrated into Obsidian. Answer the user's request directly and completely, using note context only as evidence. Do not add unsolicited tips, suggestions for future note updates, next steps, follow-up offers, or extra sections. Provide recommendations or ask a follow-up question only when the user explicitly requests them or when they are necessary to answer accurately. Use concise Markdown when it improves readability.",
  temperature: 0.7,
  maxTokens: 8192,
  includeActiveNoteByDefault: true,
  maxContextChars: 24000,
  autoTitleChat: true,
  showReasoning: true,
  saveChatHistory: true,
};

export interface ChatContextItem {
  type: "active_note" | "selection";
  title: string;
  path: string;
  content: string;
}

export interface CannedPrompt {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Snapshot of the model that generated an assistant response.
  model?: string;
  reasoningContent?: string;
  timestamp: number;
  contextIncluded?: {
    title: string;
    path: string;
    preview?: string;
  };
  // Ready for future tool calling implementation
  toolCalls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  toolCallId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface LMStudioModel {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface IAidePlugin {
  settings: PluginSettings;
  conversations: Conversation[];
  cannedPrompts: CannedPrompt[];
  currentConversationId: string;
  cachedModels: LMStudioModel[];
  saveSettings(): Promise<void>;
  saveConversations(): Promise<void>;
  saveCannedPrompts(): Promise<void>;
  openSettings(): void;
  getContextMarkdownView(): MarkdownView | null;
  getActiveChatView(): any;
  updateContextInViews(): void;
  updateModelInViews(modelId: string): void;
  updateCannedPromptsInViews(): void;
}

export interface StreamChatParams {
  baseUrl: string;
  model: string;
  messages: Array<{
    role: string;
    content: string;
    name?: string;
    tool_calls?: any[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  // Prepared for future tool calling
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  signal?: AbortSignal;
  onToken: (contentChunk: string, reasoningChunk?: string) => void;
  onReasoningToken?: (chunk: string) => void;
  onToolCallChunk?: (toolCallDelta: any) => void;
}
