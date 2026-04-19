#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolRequest,
  ListToolsRequest,
  ListPromptsRequest,
  GetPromptRequest,
  Tool,
  Prompt,
  GetPromptResult,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "./utils/logger.js";
import { PROTOCOL, ToolArguments } from "./constants.js";

import { 
  getToolDefinitions, 
  getPromptDefinitions, 
  executeTool, 
  toolExists, 
  getPromptMessage 
} from "./tools/index.js";

const server = new Server(
  {
    name: "gemini-cli-mcp",
    version: "1.1.4",
  },{
    capabilities: {
      tools: {},
      prompts: {},
      notifications: {},
      logging: {},
    },
  },
);

let isProcessing = false; let latestOutput = "";

// Tracks every notification that has been handed to the SDK but whose
// underlying stdout write may not have drained yet. stopProgressUpdates
// awaits all of these before the tool response is returned, preventing
// progress events from arriving after the response (which would be
// rejected by the client as "unknown token" and drop the transport).
const pendingNotifications = new Set<Promise<void>>();

async function sendNotification(method: string, params: any) {
  try {
    await server.notification({ method, params });
  } catch (error) {
    Logger.error("notification failed: ", error);
  }
}

/**
 * @param progressToken The progress token provided by the client
 * @param progress The current progress value
 * @param total Optional total value
 * @param message Optional status message
 */
async function sendProgressNotification(
  progressToken: string | number | undefined,
  progress: number,
  total?: number,
  message?: string
): Promise<void> {
  if (progressToken == null) return; // Only send if client requested progress

  const params: any = { progressToken, progress };
  if (total !== undefined) params.total = total; // future cache progress
  if (message) params.message = message;

  const sendPromise = (async () => {
    try {
      await server.notification({
        method: PROTOCOL.NOTIFICATIONS.PROGRESS,
        params,
      });
    } catch (error) {
      Logger.error("Failed to send progress notification:", error);
    }
  })();

  pendingNotifications.add(sendPromise);
  try {
    await sendPromise;
  } finally {
    pendingNotifications.delete(sendPromise);
  }
}

function startProgressUpdates(
  operationName: string,
  progressToken?: string | number
) {
  isProcessing = true;
  latestOutput = ""; // Reset latest output
  
  const progressMessages = [
    `🧠 ${operationName} - Gemini is analyzing your request...`,
    `📊 ${operationName} - Processing files and generating insights...`,
    `✨ ${operationName} - Creating structured response for your review...`,
    `⏱️ ${operationName} - Large analysis in progress (this is normal for big requests)...`,
    `🔍 ${operationName} - Still working... Gemini takes time for quality results...`,
  ];
  
  let messageIndex = 0;
  let progress = 0;
  
  // Send immediate acknowledgment if progress requested
  if (progressToken != null) {
    sendProgressNotification(
      progressToken,
      0,
      undefined, // No total - indeterminate progress
      `🔍 Starting ${operationName}`
    );
  }
  
  // Keep client alive with periodic updates
  const progressInterval = setInterval(async () => {
    // Tool may have completed while this async tick was queued.
    // stopProgressUpdates drains any send we do start, but skipping an
    // unnecessary one is cheaper.
    if (!isProcessing) {
      clearInterval(progressInterval);
      return;
    }
    if (progressToken == null) return;

    const baseMessage = progressMessages[messageIndex % progressMessages.length];
    const outputPreview = latestOutput.slice(-150).trim();
    const message = outputPreview
      ? `${baseMessage}\n📝 Output: ...${outputPreview}`
      : baseMessage;

    progress += 1;
    messageIndex++;

    await sendProgressNotification(progressToken, progress, undefined, message);
  }, PROTOCOL.KEEPALIVE_INTERVAL); // Every 25 seconds

  return { interval: progressInterval, progressToken };
}

async function stopProgressUpdates(
  progressData: { interval: NodeJS.Timeout; progressToken?: string | number }
): Promise<void> {
  isProcessing = false;
  clearInterval(progressData.interval);

  // Drain any progress notification whose stdout write may still be in
  // flight. If one of these landed after the tool response, the client
  // would log "progress notification for an unknown token" and drop the
  // stdio transport. Waiting here guarantees the response is the last
  // message the client sees for this token. No terminal "100%" is
  // emitted — the tool response itself is the completion signal.
  if (pendingNotifications.size > 0) {
    await Promise.allSettled([...pendingNotifications]);
  }
}

// tools/list
server.setRequestHandler(ListToolsRequestSchema, async (request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
  return { tools: getToolDefinitions() as unknown as Tool[] };
});

// tools/get
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const toolName: string = request.params.name;

  if (toolExists(toolName)) {
    // Check if client requested progress updates
    const progressToken = (request.params as any)._meta?.progressToken;
    
    // Start progress updates if client requested them
    const progressData = startProgressUpdates(toolName, progressToken);
    
    try {
      // Get prompt and other parameters from arguments with proper typing
      const args: ToolArguments = (request.params.arguments as ToolArguments) || {};

      Logger.toolInvocation(toolName, request.params.arguments);

      // Execute the tool using the unified registry with progress callback
      const result = await executeTool(toolName, args, (newOutput) => {
        latestOutput = newOutput;
      });

      // Stop progress updates (drains any in-flight notification before we return).
      await stopProgressUpdates(progressData);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
        isError: false,
      };
    } catch (error) {
      // Stop progress updates on error (drains in-flight notifications too).
      await stopProgressUpdates(progressData);

      Logger.error(`Error in tool '${toolName}':`, error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: "text",
            text: `Error executing ${toolName}: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  } else {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// prompts/list
server.setRequestHandler(ListPromptsRequestSchema, async (request: ListPromptsRequest): Promise<{ prompts: Prompt[] }> => {
  return { prompts: getPromptDefinitions() as unknown as Prompt[] };
});

// prompts/get
server.setRequestHandler(GetPromptRequestSchema, async (request: GetPromptRequest): Promise<GetPromptResult> => {
  const promptName = request.params.name;
  const args = request.params.arguments || {};
  
  const promptMessage = getPromptMessage(promptName, args);
  
  if (!promptMessage) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }
  
  return { 
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: promptMessage
      }
    }]
  };
});

// Start the server
async function main() {
  Logger.debug("init gemini-mcp-tool");
  const transport = new StdioServerTransport(); await server.connect(transport);
  Logger.debug("gemini-mcp-tool listening on stdio");
} main().catch((error) => {Logger.error("Fatal error:", error); process.exit(1); }); 
