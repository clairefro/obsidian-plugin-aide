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
   * Intelligently parses mixed reasoning & answer text into separate parts.
   */
  static splitReasoningAndAnswer(rawText: string): {
    reasoning: string;
    answer: string;
  } {
    if (!rawText) return { reasoning: "", answer: "" };

    const text = rawText.trim();

    // 1. Explicit tag pairs: <think>...</think>, <thought>...</thought>, [thought]...[/thought], etc.
    const tagMatches = [
      /<think>([\s\S]*?)<\/think>/i,
      /<thought>([\s\S]*?)<\/thought>/i,
      /<reasoning>([\s\S]*?)<\/reasoning>/i,
      /<thinking>([\s\S]*?)<\/thinking>/i,
      /<\|(?:start_of_thought|thought)\|>([\s\S]*?)<\|(?:end_of_thought|endofthought)\>/i,
      /\[(?:thought|think|reasoning)\]([\s\S]*?)\[\/(?:thought|think|reasoning)\]/i,
      /```(?:thought|think)([\s\S]*?)```/i,
      /\|thought\|([\s\S]*?)\|\/thought\|/i,
    ];

    for (const regex of tagMatches) {
      const match = text.match(regex);
      if (match && match.index !== undefined) {
        const reasoning = match[1].trim();
        const before = text.slice(0, match.index).trim();
        const after = text.slice(match.index + match[0].length).trim();
        const answer = [before, after].filter(Boolean).join("\n\n").trim();
        if (answer) {
          return { reasoning, answer };
        }
      }
    }

    // 2. Explicit closing tags without opening tag (e.g. </think> or <|end_of_thought|>)
    const closingTagRegex =
      /(?:<\/think>|<\/thought>|<\/reasoning>|<\/thinking>|<\|endofthought\|>|<\|end_of_thought\|>|<\|im_end\|>|\[\/thought\]|\[\/think\]|\[\/reasoning\]|\|\/thought\||\|endofthought\||```\/thought)([\s\S]*)/i;
    const closingMatch = text.match(closingTagRegex);
    if (
      closingMatch &&
      closingMatch[1] !== undefined &&
      closingMatch.index !== undefined
    ) {
      const reasoning = text.slice(0, closingMatch.index).trim();
      const answer = closingMatch[1].trim();
      if (answer) {
        return { reasoning, answer };
      }
    }

    // 3. Delimiter patterns like "Final Answer:", "Answer:", "### Response", "---", etc.
    const delimiterRegexes = [
      /(?:\n|^)(?:---|\*\*\*)\s*\n+([\s\S]+)$/i,
      /(?:\n|^)(?:#{1,4}\s*)?(?:\*{1,2})?(?:Final Answer|Answer|Response|Conclusion|Solution|Summary|Sentence)(?:\*{1,2})?[:\s\n]+([\s\S]+)$/i,
      /(?:\n|^)(?:#{1,4}\s*)(?:Output|Result|Explanation)(?:\*{1,2})?[:\s\n]+([\s\S]+)$/i,
    ];

    for (const regex of delimiterRegexes) {
      const match = text.match(regex);
      if (match && match.index !== undefined && match[1]?.trim()) {
        const reasoning = text.slice(0, match.index).trim();
        const answer = match[1].trim();
        if (reasoning.length > 10) {
          return { reasoning, answer };
        }
      }
    }

    return { reasoning: "", answer: text };
  }

  /**
   * Extracts an explicitly labelled conclusion when a model stops after its
   * reasoning channel without producing a separate content channel.
   */
  static extractConclusionFromReasoning(reasoning: string): string {
    const conclusionRegex =
      /(?:^|[.!?]\s+)(?:so|thus|therefore)\s+(?:the\s+)?(?:final\s+)?(?:answer|response|reply)(?:\s+(?:is|should be))?\s*:\s*([^\n.!?]+(?:[.!?](?=\s|$))?)/gi;
    const matches = Array.from(reasoning.matchAll(conclusionRegex));
    return matches.at(-1)?.[1].trim() ?? "";
  }

  /**
   * Streams chat completion from LM Studio.
   * Supports both delta.reasoning_content (OpenAI / DeepSeek / LM Studio native)
   * and in-stream <think>...</think> tags for standard llama / oss reasoning models.
   */
  static async streamChat(params: StreamChatParams): Promise<{
    fullContent: string;
    fullReasoning: string;
    finishReason?: string;
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

    if (
      params.reasoningEffort &&
      /(?:gpt-oss|deepseek[-_ ]?r1|qwq|reason(?:ing)?|think(?:ing)?)/i.test(
        params.model,
      )
    ) {
      bodyPayload.reasoning_effort = params.reasoningEffort;
    }

    // Harmony uses <|end|> between analysis and final messages. Override LM
    // Studio's model defaults so it stops only after a final answer or tool call.
    if (params.model.toLowerCase().includes("gpt-oss")) {
      bodyPayload.stop = ["<|return|>", "<|call|>"];
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
    let streamBuffer = "";

    let fullContent = "";
    let fullReasoning = "";
    let finishReason: string | undefined;
    let accumulatedToolCalls: any[] = [];

    // State machine for in-stream reasoning tags (case-insensitive)
    const START_TAGS = [
      "<think>",
      "<thought>",
      "<reasoning>",
      "<thinking>",
      "<|thought|>",
      "<|start_of_thought|>",
      "[thought]",
      "[think]",
      "[reasoning]",
      "|thought|",
      "```thought",
      "```think",
    ];

    const END_TAGS = [
      "</think>",
      "</thought>",
      "</reasoning>",
      "</thinking>",
      "<|endofthought|>",
      "<|end_of_thought|>",
      "<|im_end|>",
      "<|end|>",
      "<|eot_id|>",
      "[/thought]",
      "[/think]",
      "[/reasoning]",
      "|/thought|",
      "|endofthought|",
      "```/thought",
      "```end_of_thought",
      "\n\nfinal answer:",
      "\n\n**final answer:**",
      "\n\n### final answer",
      "\n\nanswer:",
      "\n\n**answer:**",
      "\n\n### answer",
    ];

    let inThinkBlock = false;
    let pendingContent = "";

    const processContentBuffer = (forceFlush = false) => {
      while (pendingContent.length > 0) {
        const lowerPending = pendingContent.toLowerCase();

        if (!inThinkBlock) {
          // Find earliest start tag
          let earliestIdx = -1;
          let matchedTagLen = 0;

          for (const tag of START_TAGS) {
            const idx = lowerPending.indexOf(tag);
            if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
              earliestIdx = idx;
              matchedTagLen = tag.length;
            }
          }

          if (earliestIdx !== -1) {
            const before = pendingContent.slice(0, earliestIdx);
            if (before) {
              fullContent += before;
              params.onToken(before, "");
            }
            inThinkBlock = true;
            pendingContent = pendingContent.slice(earliestIdx + matchedTagLen);
          } else {
            if (forceFlush) {
              fullContent += pendingContent;
              params.onToken(pendingContent, "");
              pendingContent = "";
              break;
            }

            // Check if ends with partial prefix of any start tag
            let longestPrefixLen = 0;
            for (const tag of START_TAGS) {
              for (
                let len = Math.min(tag.length - 1, pendingContent.length);
                len >= 1;
                len--
              ) {
                if (lowerPending.endsWith(tag.slice(0, len))) {
                  if (len > longestPrefixLen) {
                    longestPrefixLen = len;
                  }
                }
              }
            }

            if (longestPrefixLen > 0) {
              const safeText = pendingContent.slice(
                0,
                pendingContent.length - longestPrefixLen,
              );
              if (safeText) {
                fullContent += safeText;
                params.onToken(safeText, "");
              }
              pendingContent = pendingContent.slice(
                pendingContent.length - longestPrefixLen,
              );
              break;
            } else {
              fullContent += pendingContent;
              params.onToken(pendingContent, "");
              pendingContent = "";
              break;
            }
          }
        } else {
          // Currently inside think block - find earliest end tag
          let earliestIdx = -1;
          let matchedTagLen = 0;
          let isAnswerSeparator = false;

          for (const tag of END_TAGS) {
            const idx = lowerPending.indexOf(tag);
            if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
              earliestIdx = idx;
              matchedTagLen = tag.length;
              if (tag.includes("answer")) {
                isAnswerSeparator = true;
              }
            }
          }

          if (earliestIdx !== -1) {
            const before = pendingContent.slice(0, earliestIdx);
            if (before) {
              fullReasoning += before;
              if (params.onReasoningToken) {
                params.onReasoningToken(before);
              }
              params.onToken("", before);
            }
            inThinkBlock = false;
            // If the matched tag was an answer header like "\n\nFinal Answer:", preserve it in content
            if (isAnswerSeparator) {
              pendingContent = pendingContent.slice(earliestIdx);
            } else {
              pendingContent = pendingContent.slice(
                earliestIdx + matchedTagLen,
              );
            }
          } else {
            if (forceFlush) {
              // At stream end, if we're still in think block, check if there's an answer within pendingContent
              fullReasoning += pendingContent;
              if (params.onReasoningToken) {
                params.onReasoningToken(pendingContent);
              }
              params.onToken("", pendingContent);
              pendingContent = "";
              break;
            }

            // Check if ends with partial prefix of any end tag
            let longestPrefixLen = 0;
            for (const tag of END_TAGS) {
              for (
                let len = Math.min(tag.length - 1, pendingContent.length);
                len >= 1;
                len--
              ) {
                if (lowerPending.endsWith(tag.slice(0, len))) {
                  if (len > longestPrefixLen) {
                    longestPrefixLen = len;
                  }
                }
              }
            }

            if (longestPrefixLen > 0) {
              const safeText = pendingContent.slice(
                0,
                pendingContent.length - longestPrefixLen,
              );
              if (safeText) {
                fullReasoning += safeText;
                if (params.onReasoningToken) {
                  params.onReasoningToken(safeText);
                }
                params.onToken("", safeText);
              }
              pendingContent = pendingContent.slice(
                pendingContent.length - longestPrefixLen,
              );
              break;
            } else {
              fullReasoning += pendingContent;
              if (params.onReasoningToken) {
                params.onReasoningToken(pendingContent);
              }
              params.onToken("", pendingContent);
              pendingContent = "";
              break;
            }
          }
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split("\n");
        // Keep the last partial line in the buffer
        streamBuffer = lines.pop() ?? "";

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

              if (typeof choice.finish_reason === "string") {
                finishReason = choice.finish_reason;
              }

              const delta = choice.delta || {};

              // 1. Native reasoning delta (LM Studio, DeepSeek-R1, OpenAI-style, GPT-OSS)
              const reasoningDelta =
                delta.reasoning_content ??
                delta.reasoning ??
                delta.thought ??
                delta.thinking ??
                choice.message?.reasoning_content ??
                choice.message?.reasoning;

              if (reasoningDelta && typeof reasoningDelta === "string") {
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

              // 3. Regular content delta (may contain <think> tags or standard output)
              const rawContent =
                delta.content ??
                choice.message?.content ??
                (typeof choice.text === "string" ? choice.text : null);

              if (rawContent && typeof rawContent === "string") {
                pendingContent += rawContent;
                processContentBuffer(false);
              }
            } catch (parseErr) {
              // Ignore individual malformed chunks
            }
          }
        }
      }

      // Flush any remaining content in tag buffer at end of stream
      processContentBuffer(true);

      // Post-process fallback: Ensure reasoning models cleanly separate reasoning from final output
      if (!fullContent.trim() && fullReasoning.trim()) {
        const split = LMStudioClient.splitReasoningAndAnswer(fullReasoning);
        if (split.answer && split.answer !== fullReasoning) {
          fullContent = split.answer;
          fullReasoning = split.reasoning;
        }

        if (!fullContent.trim()) {
          fullContent =
            LMStudioClient.extractConclusionFromReasoning(fullReasoning);
        }
      } else if (fullContent.trim() && !fullReasoning.trim()) {
        const split = LMStudioClient.splitReasoningAndAnswer(fullContent);
        if (split.reasoning && split.answer) {
          fullContent = split.answer;
          fullReasoning = split.reasoning;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      fullContent,
      fullReasoning,
      finishReason,
      toolCalls:
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
    };
  }
}
