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
    "You are an expert AI assistant integrated into Obsidian as Aide. You help the user research, summarize, structure, brainstorm, write, and refine knowledge notes. Format responses cleanly using Markdown, including headings, lists, tables, and code blocks where appropriate. If context from an Obsidian note is provided, refer to it accurately.",
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

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
  model: string;
}

export interface LMStudioModel {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface IAidePlugin {
  settings: PluginSettings;
  conversations: Conversation[];
  currentConversationId: string;
  cachedModels: LMStudioModel[];
  saveSettings(): Promise<void>;
  saveConversations(): Promise<void>;
  getActiveChatView(): any;
  updateContextInViews(): void;
  updateModelInViews(modelId: string): void;
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
