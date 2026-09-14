import { LMStudioModel, StreamChatParams } from "../types";

export class LMStudioClient {
  /**
   * Cleans the base URL by trimming trailing slashes and ensuring standard structure.
   */
  static sanitizeBaseUrl(url: string): string {
    let clean = url.trim();
    while (clean.endsWith("/")) {
      clean = clean.slice(0, -1);
    }
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = "http://" + clean;
    }
    return clean;
  }

  /**
   * Fetches all available models from the local LM Studio instance.
   */
  static async fetchModels(baseUrl: string): Promise<LMStudioModel[]> {
    const cleanBase = this.sanitizeBaseUrl(baseUrl);
    const endpoint = `${cleanBase}/models`;

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models: HTTP ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      if (data && Array.isArray(data.data)) {
        return data.data.map((m: any) => ({
          id: m.id || m.name || "unknown",
          object: m.object,
          owned_by: m.owned_by,
        }));
      } else if (Array.isArray(data)) {
        return data.map((m: any) => ({
          id: typeof m === "string" ? m : m.id || m.name || "unknown",
          object: m.object,
          owned_by: m.owned_by,
        }));
      }
      return [];
    } catch (error) {
      console.error("[LMStudioClient] Error fetching models:", error);
      throw error;
    }
  }

  /**
   * Streams chat completion from LM Studio.
   * Supports both delta.reasoning_content (OpenAI / DeepSeek / LM Studio native)
   * and in-stream <think>...</think> tags for standard llama / oss reasoning models.
   */
  static async streamChat(params: StreamChatParams): Promise<{
    fullContent: string;
    fullReasoning: string;
    toolCalls?: any[];
  }> {
    const cleanBase = this.sanitizeBaseUrl(params.baseUrl);
    const endpoint = `${cleanBase}/chat/completions`;

    const bodyPayload: Record<string, any> = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      stream: true,
    };

    if (params.maxTokens && params.maxTokens > 0) {
      bodyPayload.max_tokens = params.maxTokens;
    }

    // Prepared for future tool calling
    if (params.tools && params.tools.length > 0) {
      bodyPayload.tools = params.tools;
      if (params.toolChoice) {
        bodyPayload.tool_choice = params.toolChoice;
      }
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(bodyPayload),
      signal: params.signal,
    });

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch (_) {}
      throw new Error(
        `LM Studio API error (HTTP ${response.status}): ${errorText || response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error(
        "Response body is empty or readable stream is not supported.",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    let fullContent = "";
    let fullReasoning = "";
    let accumulatedToolCalls: any[] = [];

    // State for parsing <think>...</think> tags inside content stream
    let inThinkBlock = false;
    let tagBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // SSE keep-alive comment
          if (trimmed === "data: [DONE]") {
            break;
          }

          if (trimmed.startsWith("data:")) {
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const parsed = JSON.parse(jsonStr);
              const choice = parsed.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta;
              if (!delta) continue;

              // 1. Native reasoning delta (LM Studio, DeepSeek-R1, OpenAI-style)
              const reasoningDelta = delta.reasoning_content || delta.reasoning;
              if (reasoningDelta) {
                fullReasoning += reasoningDelta;
                if (params.onReasoningToken) {
                  params.onReasoningToken(reasoningDelta);
                }
                params.onToken("", reasoningDelta);
              }

              // 2. Future tool calls delta
              if (delta.tool_calls) {
                accumulatedToolCalls.push(...delta.tool_calls);
                if (params.onToolCallChunk) {
                  params.onToolCallChunk(delta.tool_calls);
                }
              }

              // 3. Regular content delta (may contain <think> tags for llama-style models)
              const contentDelta = delta.content;
              if (contentDelta) {
                let currentText = contentDelta;

                // Process potential <think> or </think> tags within the stream
                while (currentText.length > 0) {
                  if (!inThinkBlock) {
                    const thinkStartIdx = currentText.indexOf("<think>");
                    if (thinkStartIdx !== -1) {
                      // Text before <think>
                      const before = currentText.slice(0, thinkStartIdx);
                      if (before) {
                        fullContent += before;
                        params.onToken(before, "");
                      }
                      inThinkBlock = true;
                      currentText = currentText.slice(thinkStartIdx + 7);
                    } else {
                      // Check for partial tag '<think' at the end
                      if (
                        currentText.endsWith("<") ||
                        currentText.endsWith("<t") ||
                        currentText.endsWith("<th") ||
                        currentText.endsWith("<thi") ||
                        currentText.endsWith("<thin") ||
                        currentText.endsWith("<think")
                      ) {
                        // Safe chunk to send
                        const lastLt = currentText.lastIndexOf("<");
                        const safePart = currentText.slice(0, lastLt);
                        tagBuffer = currentText.slice(lastLt);
                        if (safePart) {
                          fullContent += safePart;
                          params.onToken(safePart, "");
                        }
                        currentText = "";
                      } else {
                        fullContent += currentText;
                        params.onToken(currentText, "");
                        currentText = "";
                      }
                    }
                  } else {
                    // Currently inside <think>...</think>
                    const thinkEndIdx = currentText.indexOf("</think>");
                    if (thinkEndIdx !== -1) {
                      const thinkContent = currentText.slice(0, thinkEndIdx);
                      if (thinkContent) {
                        fullReasoning += thinkContent;
                        if (params.onReasoningToken) {
                          params.onReasoningToken(thinkContent);
                        }
                        params.onToken("", thinkContent);
                      }
                      inThinkBlock = false;
                      currentText = currentText.slice(thinkEndIdx + 8);
                    } else {
                      fullReasoning += currentText;
                      if (params.onReasoningToken) {
                        params.onReasoningToken(currentText);
                      }
                      params.onToken("", currentText);
                      currentText = "";
                    }
                  }
                }
              }
            } catch (parseErr) {
              // Ignore individual malformed chunks
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      fullContent,
      fullReasoning,
      toolCalls:
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
    };
  }
}
