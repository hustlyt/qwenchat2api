/**
 * Qwen API to OpenAI Standard - Single File Deno Deploy/Playground Script
 *
 * @version 5.0.0
 * @description Supports both temporary sessions and true multi-round conversations.
 *
 * NEW in v5.0.0:
 * - QWEN_SESSION_TEMP environment variable to control session mode
 * - TEMP mode (true): Each request creates new chat, merges history into system prompt, auto-deletes after completion
 * - PERSISTENT mode (false, default): True multi-round conversation with parent_id chaining, returns chat_id and message_id
 * - Extended OpenAI API format to support qwen_context field for persistent mode
 * - Stream transformer extracts assistant message ID and returns it in response
 * - Deep research mode (-research) always uses persistent mode
 * - Video generation: 15-minute polling, auto-delete after URL obtained
 */

import { Application, Router, Context, Middleware } from "https://deno.land/x/oak@v12.6.1/mod.ts";

// ============================================================================
// Logger Class - Enhanced Logging System
// ============================================================================
class Logger {
  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatDuration(startTime: number): string {
    return `${Date.now() - startTime}ms`;
  }

  private sanitizeHeaders(headers: Headers): Record<string, string> {
    const sanitized: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (key.toLowerCase() === 'authorization') {
        sanitized[key] = value.substring(0, 20) + '...';
      } else if (key.toLowerCase() === 'cookie') {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    });
    return sanitized;
  }

  info(message: string, data?: any) {
    console.log(`[${this.formatTimestamp()}] INFO: ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  error(message: string, error?: any, data?: any) {
    console.error(`[${this.formatTimestamp()}] ERROR: ${message}`, {
      error: error?.message || error,
      stack: error?.stack,
      ...data
    });
  }

  debug(message: string, data?: any) {
    if ((Deno.env.get("DEBUG") || "").toLowerCase() === "true") {
      console.log(`[${this.formatTimestamp()}] DEBUG: ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
  }

  request(ctx: Context, startTime: number) {
    const duration = this.formatDuration(startTime);
    const logData = {
      timestamp: this.formatTimestamp(),
      method: ctx.request.method,
      path: ctx.request.url.pathname,
      query: Object.fromEntries(ctx.request.url.searchParams),
      status: ctx.response.status,
      duration,
      headers: this.sanitizeHeaders(ctx.request.headers),
      ip: (ctx.request as any).ip,
      userAgent: ctx.request.headers.get('user-agent'),
    };
    const level = (ctx.response.status || 0) >= 400 ? 'ERROR' : 'INFO';
    console.log(`[${this.formatTimestamp()}] ${level}: ${ctx.request.method} ${ctx.request.url.pathname} - ${ctx.response.status} (${duration})`, logData);
  }

  streamChunk(type: string, content: any) {
    console.log(`[${this.formatTimestamp()}] STREAM: ${type}`, { 
      contentLength: content?.length || 0,
      preview: typeof content === 'string' ? content.substring(0, 200) : JSON.stringify(content).substring(0, 200)
    });
  }
}

const logger = new Logger();

// ============================================================================
// Configuration from Environment Variables
// ============================================================================
const config = {
  salt: Deno.env.get("SALT") || "",
  useDenoEnv: (Deno.env.get("USE_DENO_ENV") || "").toLowerCase() === 'true',
  qwenTokenEnv: Deno.env.get("QWEN_TOKEN") || "",
  ssxmodItnaEnv: Deno.env.get("SSXMOD_ITNA_VALUE") || "",
  debug: (Deno.env.get("DEBUG") || "").toLowerCase() === 'true',
  // Session mode: temp (true) or persistent (true, default)
  sessionTemp: (Deno.env.get("QWEN_SESSION_TEMP") || "true").toLowerCase() === 'true',
};

// ============================================================================
// Core Conversion Logic
// ============================================================================
const QWEN_API_BASE_URL = "https://chat.qwen.ai/api/v2/chat/completions";
const QWEN_CHAT_NEW_URL = "https://chat.qwen.ai/api/v2/chats/new";
const QWEN_CHAT_INFO_URL = "https://chat.qwen.ai/api/v2/chats"; // GET/DELETE {id}

// Helper: Resolve chat type from model suffix
function resolveChatType(model: string): 't2t' | 'search' | 't2i' | 'image_edit' | 't2v' | 'deep_research' {
  if (model.endsWith('-video')) return 't2v';
  if (model.endsWith('-image_edit')) return 'image_edit';
  if (model.endsWith('-image')) return 't2i';
  if (model.endsWith('-search')) return 'search';
  if (model.endsWith('-research')) return 'deep_research';
  return 't2t';
}

// Helper: Create a new chat session
async function createNewChat(token: string, model: string, chatType: string, isTemp: boolean, ssxmodItna?: string): Promise<string | null> {
  try {
    logger.info(`Creating new ${isTemp ? 'temporary' : 'persistent'} chat session`, { model, chatType });
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'source': 'web',
      'Referer': isTemp ? 'https://chat.qwen.ai/?temporary-chat=true' : 'https://chat.qwen.ai/',
      'Origin': 'https://chat.qwen.ai'
    };
    if (ssxmodItna) headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;

    const body = {
      title: isTemp ? "(temp)" : "Conversation",
      models: [model],
      chat_mode: "normal",
      chat_type: chatType,
      timestamp: Date.now()
    };

    const response = await fetch(QWEN_CHAT_NEW_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to create new chat`, { status: response.status, error: errorText.slice(0, 500) });
      return null;
    }

    const data = await response.json();
    const chatId = data?.data?.id || null;
    if (chatId) logger.info(`Successfully created new ${isTemp ? 'temporary' : 'persistent'} chat`, { chatId });
    else logger.error(`No chat ID in response`, data);
    return chatId;
  } catch (error) {
    logger.error(`Error creating new chat`, error);
    return null;
  }
}

// Helper: Delete a chat
async function deleteChat(chatId: string, token: string, ssxmodItna?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (ssxmodItna) headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;

    const resp = await fetch(`${QWEN_CHAT_INFO_URL}/${chatId}`, { method: "DELETE", headers });
    if (!resp.ok) {
      const body = await resp.text();
      logger.error(`Failed to delete chat`, { chatId, status: resp.status, body: body?.slice(0, 200) });
      return false;
    }
    logger.info(`Deleted chat`, { chatId });
    return true;
  } catch (err) {
    logger.error(`Error deleting chat`, err, { chatId });
    return false;
  }
}

// Helper: Extract video URL from chat detail data
function extractVideoUrlFromChatData(chatData: any): string | null {
  const chat = chatData?.data?.chat;
  if (!chat) return null;

  if (Array.isArray(chat.messages)) {
    for (const msg of chat.messages) {
      const c = msg?.content;
      if (typeof c === 'string' && c.includes('.mp4')) return c;
    }
  }

  const historyMsgs = chat?.history?.messages;
  if (historyMsgs && typeof historyMsgs === 'object') {
    for (const key of Object.keys(historyMsgs)) {
      const msg = historyMsgs[key];
      const c = msg?.content;
      if (typeof c === 'string' && c.includes('.mp4')) return c;
    }
  }

  return null;
}

// Helper: GET chat info and try extracting a video URL
async function getChatInfo(chatId: string, token: string, ssxmodItna?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    if (ssxmodItna) headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;

    const response = await fetch(`${QWEN_CHAT_INFO_URL}/${chatId}`, { headers });
    if (!response.ok) {
      logger.error(`Failed to get chat info`, { status: response.status });
      return null;
    }
    const data = await response.json();
    const url = extractVideoUrlFromChatData(data);
    if (url) logger.info(`Found video URL in chat history`, { url });
    return url;
  } catch (error) {
    logger.error(`Error getting chat info`, error);
    return null;
  }
}

// Helper: Extract all images from OpenAI-style messages
function extractImagesFromMessages(messages: any[]): string[] {
  const images: string[] = [];
  for (const message of messages) {
    if (!message) continue;

    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'image_url' && item.image_url?.url) images.push(item.image_url.url);
          else if (item.type === 'image' && item.image) images.push(item.image);
        }
      } else if (typeof message.content === 'string') {
        const md = message.content.matchAll(/!\[.*?\]\((.*?)\)/g);
        for (const m of md) if (m[1]) images.push(m[1]);
      }
    }

    if (message.role === 'assistant' && typeof message.content === 'string') {
      const md = message.content.matchAll(/!\[.*?\]\((.*?)\)/g);
      for (const m of md) if (m[1]) images.push(m[1]);
    }
  }
  return images;
}

// Helper: Build single message with history in system prompt (for TEMP mode)
function buildMessageWithHistory(messages: any[], chatType: string, thinkingEnabled: boolean, qwenModel: string): any {
  if (messages.length === 0) {
    throw new Error("No messages provided");
  }

  // Find last user message
  const lastUserMsg = messages.filter((m: any) => m.role === 'user').pop();
  if (!lastUserMsg) {
    throw new Error("No user message found");
  }

  // Extract last user content
  let lastUserContent = '';
  const lastUserFiles: any[] = [];
  if (typeof lastUserMsg.content === 'string') {
    lastUserContent = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    for (const item of lastUserMsg.content) {
      if (item.type === 'text') {
        lastUserContent += (item.text || item.content || '');
      } else if (item.type === 'image_url' && item.image_url?.url) {
        lastUserFiles.push({ type: "image", url: item.image_url.url });
      } else if (item.type === 'image' && item.image) {
        lastUserFiles.push({ type: "image", url: item.image });
      }
    }
  }

  // Build history context (exclude last user message)
  const historyMessages = messages.slice(0, -1);
  let historyContext = '';

  if (historyMessages.length > 0) {
    historyContext = '## 对话历史\n\n';
  
    for (const msg of historyMessages) {
      if (msg.role === 'system') {
        historyContext += `**系统指令**: ${msg.content}\n\n`;
      } else if (msg.role === 'user') {
        let content = '';
        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === 'text') {
              content += (item.text || item.content || '');
            } else if (item.type === 'image_url' && item.image_url?.url) {
              content += `\n[图片: ${item.image_url.url}]\n`;
            } else if (item.type === 'image' && item.image) {
              content += `\n[图片: ${item.image}]\n`;
            }
          }
        }
        historyContext += `**User**: ${content}\n\n`;
      } else if (msg.role === 'assistant') {
        historyContext += `**Assistant**: ${msg.content}\n\n`;
      }
    }

    historyContext += '## 当前问题\n\n';
  }

  // Build final content
  const finalContent = historyContext + lastUserContent;

  // Build Qwen message
  const qwenMessage = {
    fid: crypto.randomUUID(),
    parentId: null,
    childrenIds: [],
    role: 'user',
    content: finalContent,
    user_action: 'chat',
    files: lastUserFiles,
    timestamp: Date.now(),
    models: [qwenModel],
    chat_type: chatType,
    feature_config: { thinking_enabled: thinkingEnabled, output_schema: "phase" },
    extra: { meta: { subChatType: chatType === 'deep_research' ? 'deep_thinking' : chatType } },
    sub_chat_type: chatType === 'deep_research' ? 'deep_thinking' : chatType,
    parent_id: null
  };

  return qwenMessage;
}

// Helper: Build single message for PERSISTENT mode (only last user message with parent_id)
function buildSingleMessage(lastUserMsg: any, chatType: string, thinkingEnabled: boolean, qwenModel: string, parentId: string | null): any {
  let content = '';
  const files: any[] = [];

  if (typeof lastUserMsg.content === 'string') {
    content = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    for (const item of lastUserMsg.content) {
      if (item.type === 'text') {
        content += (item.text || item.content || '');
      } else if (item.type === 'image_url' && item.image_url?.url) {
        files.push({ type: "image", url: item.image_url.url });
      } else if (item.type === 'image' && item.image) {
        files.push({ type: "image", url: item.image });
      }
    }
  }

  const qwenMessage = {
    fid: crypto.randomUUID(),
    parentId: parentId,
    childrenIds: [],
    role: 'user',
    content: content || 'Hello',
    user_action: 'chat',
    files: files,
    timestamp: Date.now(),
    models: [qwenModel],
    chat_type: chatType,
    feature_config: { thinking_enabled: thinkingEnabled, output_schema: "phase" },
    extra: { meta: { subChatType: chatType === 'deep_research' ? 'deep_thinking' : chatType } },
    sub_chat_type: chatType === 'deep_research' ? 'deep_thinking' : chatType,
    parent_id: parentId
  };

  return qwenMessage;
}

// Transform OpenAI request to Qwen request
async function transformOpenAIRequestToQwen(
  openAIRequest: any, token: string, ssxmodItna?: string
): Promise<{ request: any, chatId: string, isVideo: boolean, shouldAutoDelete: boolean }> {
  if (!openAIRequest.messages || !Array.isArray(openAIRequest.messages)) {
    throw new Error("Invalid request: messages array is required");
  }
  if (openAIRequest.messages.length === 0) {
    throw new Error("Invalid request: messages array cannot be empty");
  }

  const model = openAIRequest.model || "qwen-max";
  const resolvedType = resolveChatType(model);
  const qwenModel = model.replace(/-(search|thinking|image|image_edit|video|research)$/, '');
  const thinkingEnabled = model.includes('-thinking');

  // Check if client provided qwen_context (for persistent mode)
  const qwenContext = openAIRequest.qwen_context || {};
  const providedChatId = qwenContext.chat_id || null;
  const providedParentId = qwenContext.parent_id || null;

  // Determine session mode
  // deep_research always uses persistent mode
  const isResearch = resolvedType === 'deep_research';
  const useTemp = !isResearch && config.sessionTemp;

  logger.info(`Transforming OpenAI request`, {
    originalModel: model,
    qwenModel,
    resolvedType,
    messageCount: openAIRequest.messages.length,
    mode: useTemp ? 'TEMP' : 'PERSISTENT',
    providedChatId,
    providedParentId
  });

  const lastUserMessage = openAIRequest.messages.filter((m: any) => m.role === 'user').pop();

  // Decide final chat type
  let chatTypeForCreation = resolvedType;
  if (resolvedType === 'image_edit') {
    const allImages = extractImagesFromMessages(openAIRequest.messages);
    if (allImages.length === 0) {
      chatTypeForCreation = 't2i';
    }
  }

  // Handle video generation (always temp, always auto-delete)
  if (resolvedType === 't2v') {
    if (!lastUserMessage) throw new Error("No user message found for video generation.");

    const chatId = await createNewChat(token, qwenModel, 't2v', true, ssxmodItna);
    if (!chatId) throw new Error("Failed to create chat session for video generation");

    let textContent = "";
    if (typeof lastUserMessage.content === 'string') textContent = lastUserMessage.content;
    else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) if (item.type === 'text') textContent += item.text || item.content || '';
    }

    const transformedRequest = {
      stream: false,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: qwenModel,
      parent_id: null,
      messages: [{
        fid: crypto.randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: textContent || "Generate a video",
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [qwenModel],
        chat_type: "t2v",
        feature_config: { thinking_enabled: false, output_schema: "phase" },
        extra: { meta: { subChatType: "t2v" } },
        sub_chat_type: "t2v",
        parent_id: null
      }],
      timestamp: Date.now(),
      size: openAIRequest.size || "9:16"
    };

    logger.info(`Transformed to video generation request`, { model: qwenModel, chatId, stream: false });
    return { request: transformedRequest, chatId, isVideo: true, shouldAutoDelete: true };
  }

  // Handle image_edit
  if (resolvedType === 'image_edit' || chatTypeForCreation === 't2i') {
    if (!lastUserMessage) throw new Error("No user message found for image generation/editing.");

    // Image generation is always temp
    const chatId = await createNewChat(token, qwenModel, chatTypeForCreation, true, ssxmodItna);
    if (!chatId) throw new Error("Failed to create chat session for image generation");

    const allImages = extractImagesFromMessages(openAIRequest.messages);
    const textContent = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : Array.isArray(lastUserMessage.content)
        ? lastUserMessage.content.filter((i: any) => i.type === 'text').map((i: any) => i.text || i.content || '').join('')
        : "";

    const imagesToUse = allImages.slice(-3);
    const files = imagesToUse.map(url => ({ type: "image", url }));

    const subType = (resolvedType === 'image_edit' && files.length > 0) ? "image_edit" : "t2i";

    const transformedRequest = {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: qwenModel,
      parent_id: null,
      messages: [{
        fid: crypto.randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: textContent || (subType === "image_edit" ? "Edit these images" : "Generate an image"),
        user_action: 'chat',
        files,
        timestamp: Date.now(),
        models: [qwenModel],
        chat_type: subType,
        feature_config: { thinking_enabled: false, output_schema: "phase" },
        extra: { meta: { subChatType: subType } },
        sub_chat_type: subType,
        parent_id: null
      }],
      timestamp: Date.now(),
      ...(subType === "t2i" ? { size: openAIRequest.size || "1:1" } : {})
    };

    logger.info(`Transformed to ${subType} request`, { model: qwenModel, chatId, fileCount: files.length });
    return { request: transformedRequest, chatId, isVideo: false, shouldAutoDelete: true };
  }

  // Handle t2i (explicit)
  if (resolvedType === 't2i') {
    if (!lastUserMessage) throw new Error("No user message found for image generation.");

    const chatId = await createNewChat(token, qwenModel, 't2i', true, ssxmodItna);
    if (!chatId) throw new Error("Failed to create chat session for image generation");

    let textContent = "";
    if (typeof lastUserMessage.content === 'string') textContent = lastUserMessage.content;
    else if (Array.isArray(lastUserMessage.content)) {
      for (const item of lastUserMessage.content) if (item.type === 'text') textContent += item.text || item.content || '';
    }

    const transformedRequest = {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: qwenModel,
      parent_id: null,
      messages: [{
        fid: crypto.randomUUID(),
        parentId: null,
        childrenIds: [],
        role: "user",
        content: textContent || "Generate an image",
        user_action: 'chat',
        files: [],
        timestamp: Date.now(),
        models: [qwenModel],
        chat_type: "t2i",
        feature_config: { thinking_enabled: false, output_schema: "phase" },
        extra: { meta: { subChatType: "t2i" } },
        sub_chat_type: "t2i",
        parent_id: null
      }],
      timestamp: Date.now(),
      size: openAIRequest.size || "1:1"
    };

    logger.info(`Transformed to image generation request`, { model: qwenModel, chatId });
    return { request: transformedRequest, chatId, isVideo: false, shouldAutoDelete: true };
  }

  // Handle text/search/deep_research
  {
    const isSearch = resolvedType === 'search';
    const finalChatType = isResearch ? 'deep_research' : (isSearch ? 'search' : 't2t');

    let chatId: string;
    let parentId: string | null = null;
    let qwenMessage: any;

    if (useTemp) {
      // TEMP mode: create new temp chat, merge history into system prompt
      chatId = await createNewChat(token, qwenModel, finalChatType, true, ssxmodItna) || '';
      if (!chatId) throw new Error(`Failed to create temp chat session for ${finalChatType}`);

      qwenMessage = buildMessageWithHistory(openAIRequest.messages, finalChatType, thinkingEnabled, qwenModel);

      logger.info(`Using TEMP mode`, { chatId, chatType: finalChatType, historyMerged: true });
    } else {
      // PERSISTENT mode: reuse or create persistent chat
      if (providedChatId) {
        chatId = providedChatId;
        parentId = providedParentId;
        logger.info(`Reusing persistent chat`, { chatId, parentId });
      } else {
        chatId = await createNewChat(token, qwenModel, finalChatType, false, ssxmodItna) || '';
        if (!chatId) throw new Error(`Failed to create persistent chat session for ${finalChatType}`);
        logger.info(`Created new persistent chat`, { chatId });
      }

      if (!lastUserMessage) throw new Error("No user message found");
      qwenMessage = buildSingleMessage(lastUserMessage, finalChatType, thinkingEnabled, qwenModel, parentId);

      logger.info(`Using PERSISTENT mode`, { chatId, parentId, chatType: finalChatType });
    }

    const transformedRequest = {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: useTemp ? "local" : "normal",
      model: qwenModel,
      parent_id: parentId,
      messages: [qwenMessage],
      timestamp: Date.now()
    };

    return { request: transformedRequest, chatId, isVideo: false, shouldAutoDelete: useTemp };
  }
}

// Stream transformer: extracts assistant message ID and returns it
function createQwenToOpenAIStreamTransformer(
  onComplete?: () => void | Promise<void>,
  onMessageId?: (messageId: string) => void
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const MAX_BUFFER_SIZE = 100000;
  const messageId = crypto.randomUUID();
  let chunkCount = 0;
  let errorDetected = false;
  let assistantMessageId: string | null = null;

  const sentUrls = new Set<string>();
  let firstImageSent = false;

  return new TransformStream({
    transform(chunk, controller) {
      const rawChunk = decoder.decode(chunk, { stream: true });
      buffer += rawChunk;

      if (buffer.length > MAX_BUFFER_SIZE) {
        logger.error(`Buffer overflow detected (size: ${buffer.length}), clearing buffer`);
        buffer = '';
        return;
      }

      if (!errorDetected && buffer.includes('"success":false')) {
        try {
          const errorJson = JSON.parse(buffer);
          if (errorJson.success === false) {
            logger.error("Upstream API returned error", errorJson);
            const errorMessage = errorJson.data?.details || errorJson.data?.code || "Unknown error from Qwen API";
            const openAIError = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content: `Error: ${errorMessage}\nRequest ID: ${errorJson.request_id}` },
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIError)}\n\n`));
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
            errorDetected = true;
            buffer = '';
            if (onComplete) Promise.resolve(onComplete()).catch(e => logger.error("onComplete error", e));
            return;
          }
        } catch { /* continue */ }
      }

      let lines: string[] = [];
      if (buffer.includes('\n\n')) {
        lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
      } else if (buffer.includes('\n')) {
        lines = buffer.split('\n');
        const lastLine = lines[lines.length - 1];
        if (lastLine && !lastLine.startsWith('data:')) buffer = lines.pop() || '';
        else buffer = '';
      }

      for (const line of lines) {
        if (!line || line.trim() === '') continue;

        let dataStr = line;
        if (line.startsWith('data:')) dataStr = line.substring(5).trim();
        else if (line.startsWith('data: ')) dataStr = line.substring(6).trim();

        if (dataStr === '[DONE]') {
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          if (onComplete) Promise.resolve(onComplete()).catch(e => logger.error("onComplete error", e));
          continue;
        }

        try {
          const qwenChunk = JSON.parse(dataStr);

          // Try to extract assistant message ID
          if (!assistantMessageId && qwenChunk.id) {
            assistantMessageId = qwenChunk.id;
            if (onMessageId) onMessageId(assistantMessageId);
            logger.info(`Extracted assistant message ID`, { messageId: assistantMessageId });
          }

          let content = "";
          let isFinished = false;

          if (qwenChunk.choices && qwenChunk.choices.length > 0) {
            const choice = qwenChunk.choices[0];
            const delta = choice.delta || choice.message;
            if (delta) {
              content = delta.content || "";

              if (content && content.startsWith('https://')) {
                const isImage = content.includes('cdn.qwenlm.ai') || content.includes('/t2i/') || /\.(png|jpg|jpeg)$/i.test(content) || content.includes('/image_edit/');
                const isVideo = content.includes('/t2v/') || /\.mp4$/i.test(content);

                if (isImage) {
                  if (!firstImageSent && !sentUrls.has(content)) {
                    sentUrls.add(content);
                    firstImageSent = true;
                    content = `![Image](${content})`;
                    logger.info(`Emitted first image URL`, { url: content });
                  } else {
                    content = "";
                  }
                } else if (isVideo) {
                  if (!sentUrls.has(content)) {
                    sentUrls.add(content);
                    content = `[Video](${content})`;
                    logger.info(`Emitted video URL`, { url: content });
                  } else {
                    content = "";
                  }
                } else {
                  if (sentUrls.has(content)) content = "";
                }
              }

              isFinished = choice.finish_reason === 'stop' || choice.finish_reason === 'length';
            }
          } else if (qwenChunk.content) {
            content = qwenChunk.content;
            if (content.startsWith('https://')) {
              const isImage = content.includes('cdn.qwenlm.ai') || content.includes('/t2i/') || /\.(png|jpg|jpeg)$/i.test(content) || content.includes('/image_edit/');
              const isVideo = content.includes('/t2v/') || /\.mp4$/i.test(content);
              if (isImage) {
                if (!firstImageSent && !sentUrls.has(content)) {
                  sentUrls.add(content);
                  firstImageSent = true;
                  content = `![Image](${content})`;
                  logger.info(`Emitted first image URL (content)`, { url: content });
                } else content = "";
              } else if (isVideo) {
                if (!sentUrls.has(content)) {
                  sentUrls.add(content);
                  content = `[Video](${content})`;
                  logger.info(`Emitted video URL (content)`, { url: content });
                } else content = "";
              } else {
                if (sentUrls.has(content)) content = "";
              }
            }
            isFinished = qwenChunk.finish_reason === 'stop';
          }

          if (content || isFinished) {
            const openAIChunk = {
              id: `chatcmpl-${messageId}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "qwen-proxy",
              choices: [{
                index: 0,
                delta: { content },
                finish_reason: isFinished ? 'stop' : null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
            chunkCount++;
          }
        } catch (e) {
          logger.debug("Could not parse chunk", { error: (e as Error).message, dataStr: dataStr.substring(0, 200) });
        }
      }
    },
    flush(controller) {
      if (!errorDetected) controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      logger.info(`Stream completed`, {
        totalChunks: chunkCount,
        uniqueUrls: Array.from(sentUrls).length,
        errorDetected,
        assistantMessageId
      });
      if (onComplete) Promise.resolve(onComplete()).catch(e => logger.error("onComplete error", e));
    },
  });
}

// ============================================================================
// Oak Application Setup
// ============================================================================
const app = new Application();
const router = new Router();

// Global error handling middleware
app.use(async (ctx, next) => {
  const startTime = Date.now();
  try { await next(); }
  catch (err: any) {
    logger.error(`Unhandled error in request ${ctx.request.method} ${ctx.request.url}`, err);
    ctx.response.status = err.status || 500;
    ctx.response.body = { error: err.message || "Internal Server Error", timestamp: new Date().toISOString(), path: ctx.request.url.pathname };
  } finally {
    logger.request(ctx, startTime);
  }
});

// Authentication middleware
const authMiddleware: Middleware = async (ctx, next) => {
  if (ctx.request.url.pathname === '/') { await next(); return; }
  logger.info(`Processing authentication for ${ctx.request.url.pathname}`);
  ctx.state = ctx.state || {};

  if (config.useDenoEnv) {
    const authHeader = ctx.request.headers.get("Authorization");
    if (config.salt) {
      const clientToken = authHeader?.replace(/^Bearer\s+/, '');
      if (clientToken !== config.salt) {
        logger.error("Authentication failed: Invalid salt value", { provided: clientToken?.substring(0, 10) });
        ctx.response.status = 401;
        ctx.response.body = { error: "Invalid salt value.", format: "Server is in environment mode. Use: Authorization: Bearer your_salt_value", salt_required: true };
        return;
      }
    }
    ctx.state.qwenToken = config.qwenTokenEnv;
    ctx.state.ssxmodItna = config.ssxmodItnaEnv;
    logger.info("Authentication successful (server-side mode)");
  } else {
    const authHeader = ctx.request.headers.get("Authorization");
    const clientToken = authHeader?.replace(/^Bearer\s+/, '');
    if (!clientToken) {
      const expectedFormat = config.salt ? "Bearer salt;qwen_token;ssxmod_itna" : "Bearer qwen_token;ssxmod_itna";
      logger.error("Authentication failed: No token provided");
      ctx.response.status = 401;
      ctx.response.body = { error: "Unauthorized.", format: `Use: ${expectedFormat}`, salt_required: !!config.salt };
      return;
    }
    const parts = clientToken.split(';');
    let qwenToken: string; 
    let ssxmodItna: string;
    if (config.salt) {
      if (parts.length < 2) {
        logger.error("Authentication failed: Invalid token format");
        ctx.response.status = 401;
        ctx.response.body = { error: "Invalid token format.", format: "Use: Bearer salt;qwen_token;ssxmod_itna", salt_required: true };
        return;
      }
      if (parts[0]?.trim() !== config.salt) {
        logger.error("Authentication failed: Invalid salt", { provided: parts[0]?.substring(0, 10) });
        ctx.response.status = 401;
        ctx.response.body = { error: "Invalid salt value." };
        return;
      }
      qwenToken = parts[1]?.trim() || '';
      ssxmodItna = parts[2]?.trim() || '';
    } else {
      qwenToken = parts[0]?.trim() || '';
      ssxmodItna = parts[1]?.trim() || '';
    }
    if (!qwenToken) {
      logger.error("Authentication failed: Qwen token is missing");
      ctx.response.status = 401;
      ctx.response.body = { error: "Qwen token is required." };
      return;
    }
    ctx.state.qwenToken = qwenToken;
    ctx.state.ssxmodItna = ssxmodItna;
    logger.info("Authentication successful (client-side mode)");
  }
  await next();
};
app.use(authMiddleware);

// ============================================================================
// Routes
// ============================================================================
router.get("/", (ctx: Context) => {
  logger.info("Serving home page");
  let saltStatus = config.salt ? "🔒 受限访问模式" : "🎯 开放访问模式";
  let authFormat: string;
  let authMode: string;

  if (config.useDenoEnv) {
    authMode = "服务器端认证 (环境变量)";
    authFormat = config.salt ? "Authorization: Bearer your_salt_value" : "Authorization header can be anything (e.g., Bearer dummy)";
  } else {
    authMode = "客户端认证 (请求头)";
    authFormat = config.salt ? "Authorization: Bearer salt_value;qwen_token;ssxmod_itna_value" : "Authorization: Bearer qwen_token;ssxmod_itna_value";
  }

  const sessionMode = config.sessionTemp ? "临时会话 (TEMP)" : "持久会话 (PERSISTENT)";

  const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Qwen API Proxy</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="font-sans min-h-screen flex items-center justify-center p-5 bg-gradient-to-br from-indigo-500 to-purple-600">
<div class="w-full max-w-lg rounded-2xl bg-white/95 p-10 text-center shadow-2xl backdrop-blur-md">
<div class="mb-3 flex items-center justify-center gap-2"><div class="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></div><div class="text-lg font-semibold text-gray-800">服务运行正常</div></div>
<div class="mb-8 text-sm leading-relaxed text-gray-500">欲买桂花同载酒，终不似，少年游</div>
<div class="mb-8 text-left">
  <div class="mb-4 text-base font-semibold text-gray-700">API 端点</div>
  <div class="flex items-center justify-between border-b border-gray-100 py-3"><span class="text-sm text-gray-500">模型列表</span><code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/models</code></div>
  <div class="flex items-center justify-between py-3"><span class="text-sm text-gray-500">聊天完成</span><code class="font-mono rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800">/v1/chat/completions</code></div>
</div>
<div class="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-5 text-left">
  <div class="mb-2 text-sm font-semibold text-gray-700">认证方式</div>
  <div class="mb-1 text-xs font-medium text-emerald-600">${saltStatus}</div>
  <div class="mb-3 text-xs font-medium text-indigo-600">${authMode}</div>
  <div class="font-mono break-all rounded-md border border-gray-300 bg-white px-3 py-2 text-left text-[12px] leading-snug text-gray-600">${authFormat}</div>
</div>
<div class="mb-4 rounded-xl border border-purple-200 bg-purple-50 p-4 text-left">
  <div class="mb-2 text-sm font-semibold text-purple-700">会话模式</div>
  <div class="mb-2 text-xs font-medium text-purple-600">${sessionMode}</div>
  <div class="text-xs text-purple-600">
    ${config.sessionTemp 
      ? '• 每次创建临时会话，历史合并到系统提示<br/>• 完成后自动删除会话' 
      : '• 支持真正的多轮对话<br/>• 通过 parent_id 链式管理对话<br/>• 需要在请求中传递 qwen_context<br/>• 会话不自动删除'}
  </div>
</div>
<div class="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-4 text-left">
  <div class="mb-2 text-sm font-semibold text-blue-700">模型后缀说明</div>
  <div class="text-xs text-blue-600 space-y-1">
    <div>• <code class="bg-white px-1 rounded">-thinking</code>: 启用思考模式</div>
    <div>• <code class="bg-white px-1 rounded">-search</code>: 网络搜索</div>
    <div>• <code class="bg-white px-1 rounded">-image</code>: 文生图</div>
    <div>• <code class="bg-white px-1 rounded">-image_edit</code>: 图片编辑</div>
    <div>• <code class="bg-white px-1 rounded">-video</code>: 文生视频</div>
    <div>• <code class="bg-white px-1 rounded">-research</code>: 深度研究（强制持久）</div>
  </div>
</div>
<div class="text-xs font-medium text-gray-400"><span class="text-indigo-500">Qwen API Proxy v5.0.0</span><br/><span class="text-gray-400 mt-1">✨ 双模式支持：临时会话 + 真多轮对话</span></div>
</div></body></html>`;
  ctx.response.body = htmlContent;
  ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
});

// Models endpoint
router.get("/v1/models", async (ctx: Context) => {
  const token = ctx.state?.qwenToken;
  if (!token) {
    logger.error("Models endpoint: No Qwen token available");
    ctx.response.status = 401;
    ctx.response.body = { error: "Authentication failed. No Qwen token available." };
    return;
  }
  try {
    logger.info("Fetching models from Qwen API");
    const response = await fetch('https://chat.qwen.ai/api/models', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    const originalModels = (await response.json()).data;
    const processedModels: any[] = [];
    for (const model of originalModels) {
      processedModels.push(model);
      processedModels.push({ ...model, id: `${model.id}-thinking` });
      processedModels.push({ ...model, id: `${model.id}-search` });
      processedModels.push({ ...model, id: `${model.id}-image` });
      processedModels.push({ ...model, id: `${model.id}-image_edit` });
      processedModels.push({ ...model, id: `${model.id}-video` });
      processedModels.push({ ...model, id: `${model.id}-research` });
    }
    ctx.response.body = { object: "list", data: processedModels };
  } catch (err: any) {
    logger.error("Error fetching models", err);
    ctx.response.status = 502;
    ctx.response.body = { error: "Failed to fetch models from upstream API.", details: err.message };
  }
});

// Chat completions endpoint
router.post("/v1/chat/completions", async (ctx: Context) => {
  const token = ctx.state?.qwenToken;
  const ssxmodItna = ctx.state?.ssxmodItna;
  const requestId = crypto.randomUUID();
  logger.info(`Starting chat completion request`, { requestId });

  if (!token) {
    logger.error("Chat completions: No Qwen token available", { requestId });
    ctx.response.status = 401;
    ctx.response.body = { error: "Authentication failed. No Qwen token available." };
    return;
  }

  try {
    const openAIRequest = await ctx.request.body({ type: "json" }).value;
    logger.info(`Received OpenAI request`, {
      requestId,
      model: openAIRequest.model,
      messageCount: openAIRequest.messages?.length,
      stream: openAIRequest.stream,
      hasQwenContext: !!openAIRequest.qwen_context
    });

    const { request: qwenRequest, chatId, isVideo, shouldAutoDelete } = await transformOpenAIRequestToQwen(openAIRequest, token, ssxmodItna);
    const apiUrl = `${QWEN_API_BASE_URL}?chat_id=${chatId}`;
    logger.debug(`Qwen request payload`, qwenRequest);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'source': 'web',
      'x-request-id': requestId,
    };
    if (ssxmodItna) headers['Cookie'] = `ssxmod_itna=${ssxmodItna}`;

    logger.info(`Sending request to Qwen API`, {
      requestId,
      headers: Object.keys(headers),
      url: apiUrl,
      chatId,
      isVideo,
      shouldAutoDelete
    });

    const upstreamResponse = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(qwenRequest) });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      logger.error(`Upstream API error`, {
        requestId,
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        errorBody: errorBody.substring(0, 500),
        url: apiUrl
      });
      if (chatId && shouldAutoDelete) await deleteChat(chatId, token, ssxmodItna);
      ctx.response.status = upstreamResponse.status;
      ctx.response.body = { error: "Upstream API request failed", details: errorBody, requestId };
      return;
    }

    // Handle video generation with pseudo-streaming
    if (isVideo) {
      logger.info(`Received video generation response`, { requestId });
      let taskId: string | null = null;
      try {
        const respJson = await upstreamResponse.json();
        taskId = respJson?.data?.messages?.[0]?.extra?.wanx?.task_id || null;
      } catch (e) {
        logger.error(`Failed to parse video creation response`, { requestId, error: (e as Error).message });
      }

      ctx.response.headers.set("Content-Type", "text/event-stream");
      ctx.response.headers.set("Cache-Control", "no-cache");
      ctx.response.headers.set("Connection", "keep-alive");
      ctx.response.headers.set("X-Request-Id", requestId);

      const encoder = new TextEncoder();

      const sendChunk = (content: string, finish: boolean = false, qwenContext?: any) => {
        const chunk: any = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: openAIRequest.model || "qwen-proxy",
          choices: [{
            index: 0,
            delta: { content },
            finish_reason: finish ? "stop" : null
          }]
        };
        if (qwenContext) chunk.qwen_context = qwenContext;
        return `data: ${JSON.stringify(chunk)}\n\n`;
      };

      const stream = new ReadableStream({
        async start(controller) {
          let initMsg = `Video generation started.`;
          if (taskId) initMsg += ` Task ID: ${taskId}.`;
          controller.enqueue(encoder.encode(sendChunk(initMsg)));

          const maxAttempts = 450;
          const delayMs = 2000;
          let foundUrl: string | null = null;

          for (let i = 0; i < maxAttempts; i++) {
            await new Promise(r => setTimeout(r, delayMs));
            if (chatId) {
              foundUrl = await getChatInfo(chatId, token, ssxmodItna);
              if (foundUrl) break;
            }
            if (i % 5 === 0) {
              controller.enqueue(encoder.encode(sendChunk(".")));
            }
          }

          if (foundUrl) {
            controller.enqueue(encoder.encode(sendChunk(`[Video](${foundUrl})\n\nVideo generation completed!`, true)));
            if (chatId && shouldAutoDelete) {
              try {
                await deleteChat(chatId, token, ssxmodItna);
              } catch (e) {
                logger.error("Error deleting temp video chat", e, { requestId, chatId });
              }
            }
          } else {
            const later = chatId ? `Chat ID: ${chatId}` : `Request ID: ${requestId}`;
            controller.enqueue(encoder.encode(sendChunk(`Video is still being processed after 15 minutes... ${later}`, true)));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      });

      ctx.response.body = stream;
      return;
    }

    // Handle SSE streaming for other types
    if (!upstreamResponse.body) {
      logger.error(`No response body from upstream`, { requestId });
      if (chatId && shouldAutoDelete) await deleteChat(chatId, token, ssxmodItna);
      ctx.response.status = 502;
      ctx.response.body = { error: "No response body from upstream API", requestId };
      return;
    }

    logger.info(`Starting stream transformation`, { requestId, shouldAutoDelete });

    // For persistent mode, we need to capture the assistant message ID
    let assistantMessageId: string | null = null;

    const onComplete = shouldAutoDelete ? async () => {
      if (chatId) await deleteChat(chatId, token, ssxmodItna);
    } : undefined;

    const onMessageId = !shouldAutoDelete ? (msgId: string) => {
      assistantMessageId = msgId;
    } : undefined;

    const transformedStream = upstreamResponse.body.pipeThrough(
      createQwenToOpenAIStreamTransformer(onComplete, onMessageId)
    );

    // In persistent mode, we need to inject qwen_context into the last chunk
    if (!shouldAutoDelete && !config.sessionTemp) {
      const reader = transformedStream.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const enhancedStream = new ReadableStream({
        async start(controller) {
          let lastChunk: string | null = null;
          let doneReceived = false;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const text = decoder.decode(value, { stream: true });
              const lines = text.split('\n');

              for (const line of lines) {
                if (line.trim() === 'data: [DONE]') {
                  doneReceived = true;
                  // Inject qwen_context before [DONE]
                  if (assistantMessageId && lastChunk) {
                    try {
                      const chunkData = JSON.parse(lastChunk.replace(/^data: /, ''));
                      chunkData.qwen_context = {
                        chat_id: chatId,
                        message_id: assistantMessageId
                      };
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkData)}\n\n`));
                      logger.info(`Injected qwen_context`, { chatId, messageId: assistantMessageId });
                    } catch (e) {
                      logger.error(`Failed to inject qwen_context`, e);
                    }
                  }
                  controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                } else if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                  if (!doneReceived) {
                    if (lastChunk) {
                      controller.enqueue(encoder.encode(lastChunk + '\n\n'));
                    }
                    lastChunk = line;
                  }
                }
              }
            }
          } finally {
            controller.close();
          }
        }
      });

      ctx.response.body = enhancedStream;
    } else {
      ctx.response.body = transformedStream;
    }

    ctx.response.headers.set("Content-Type", "text/event-stream");
    ctx.response.headers.set("Cache-Control", "no-cache");
    ctx.response.headers.set("Connection", "keep-alive");
    ctx.response.headers.set("X-Request-Id", requestId);
    logger.info(`Stream response started`, { requestId });

  } catch (err: any) {
    logger.error("Error in chat completions proxy", err, { requestId });
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal Server Error", details: err.message, requestId };
  }
});

// Health check endpoint
router.get("/health", (ctx: Context) => {
  logger.info("Health check requested");
  ctx.response.body = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "5.0.0",
    sessionMode: config.sessionTemp ? "TEMP" : "PERSISTENT"
  };
});

// ============================================================================
// Application Setup and Start
// ============================================================================
app.use(router.routes());
app.use(router.allowedMethods());

// 404 handler
app.use((ctx) => {
  logger.error(`404 Not Found: ${ctx.request.url.pathname}`);
  ctx.response.status = 404;
  ctx.response.body = { error: "Not Found", path: ctx.request.url.pathname, timestamp: new Date().toISOString() };
});

// Startup logging
console.log("=".repeat(60));
console.log("🚀 Starting Qwen API Proxy Server v5.0.0...");
console.log("=".repeat(60));

if (config.debug) console.log("🐛 DEBUG MODE ENABLED - Verbose logging active");
if (config.useDenoEnv) {
  console.log("🔒 SERVER-SIDE AUTH ENABLED");
  if (!config.qwenTokenEnv) {
    console.error("❌ FATAL: USE_DENO_ENV is true, but QWEN_TOKEN environment variable is not set.");
    Deno.exit(1);
  }
} else {
  console.log("👤 CLIENT-SIDE AUTH ENABLED");
}

console.log("=".repeat(60));
console.log(`📝 SESSION MODE: ${config.sessionTemp ? 'TEMP (临时会话)' : 'PERSISTENT (持久会话)'}`);
console.log("=".repeat(60));

if (config.sessionTemp) {
  console.log("✅ TEMP MODE:");
  console.log("  • 每次创建新的临时会话");
  console.log("  • 历史对话合并到系统提示中");
  console.log("  • 只发送1条消息，parent_id: null");
  console.log("  • 完成后自动删除会话");
  console.log("  • 简单、无状态、适合大多数场景");
} else {
  console.log("✅ PERSISTENT MODE:");
  console.log("  • 支持真正的多轮对话");
  console.log("  • 通过 parent_id 链式管理对话");
  console.log("  • 客户端需传递 qwen_context: {chat_id, parent_id}");
  console.log("  • 响应中返回新的 message_id");
  console.log("  • 会话不自动删除（除非是图片/视频）");
  console.log("  • deep_research 强制使用此模式");
}

console.log("=".repeat(60));
console.log("🎬 SPECIAL MODES:");
console.log("  • Video: 15分钟轮询，获取URL后自动删除");
console.log("  • Image/Image-Edit: 始终使用临时会话");
console.log("  • Deep Research (-research): 强制持久会话");
console.log("=".repeat(60));

// Start the server
Deno.serve((req) => app.handle(req));

console.log("✅ Server is ready!");
console.log("=".repeat(60));

logger.info("Server initialization complete");