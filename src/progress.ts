import { PROTOCOL } from "./constants.js";
import { Logger } from "./utils/logger.js";

export type ProgressNotification = {
  method: string;
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
};

export type ProgressNotifier = (
  notification: ProgressNotification,
) => Promise<void>;

export type ProgressData = {
  interval?: NodeJS.Timeout;
  isProcessing: boolean;
  latestOutput: string;
  // Tracks notifications handed to the SDK whose stdout writes may still be draining.
  pendingNotifications: Set<Promise<void>>;
  progressToken?: string | number;
};

export async function sendProgressNotification(
  notify: ProgressNotifier,
  progressData: ProgressData,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const { progressToken } = progressData;
  if (progressToken == null) return; // Only send if client requested progress

  const params: ProgressNotification["params"] = { progressToken, progress };
  if (total !== undefined) params.total = total; // future cache progress
  if (message) params.message = message;

  const sendPromise = (async () => {
    try {
      await notify({
        method: PROTOCOL.NOTIFICATIONS.PROGRESS,
        params,
      });
    } catch (error) {
      Logger.error("Failed to send progress notification:", error);
    }
  })();

  progressData.pendingNotifications.add(sendPromise);
  try {
    await sendPromise;
  } finally {
    progressData.pendingNotifications.delete(sendPromise);
  }
}

export function startProgressUpdates(
  operationName: string,
  progressToken: string | number | undefined,
  notify: ProgressNotifier,
  keepaliveInterval: number = PROTOCOL.KEEPALIVE_INTERVAL,
): ProgressData {
  const progressData: ProgressData = {
    isProcessing: true,
    latestOutput: "",
    pendingNotifications: new Set<Promise<void>>(),
    progressToken,
  };

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
    void sendProgressNotification(
      notify,
      progressData,
      0,
      undefined, // No total - indeterminate progress
      `🔍 Starting ${operationName}`,
    );
  }

  // Keep client alive with periodic updates
  const progressInterval = setInterval(async () => {
    // Tool may have completed while this async tick was queued.
    // stopProgressUpdates drains any send we do start, but skipping an
    // unnecessary one is cheaper.
    if (!progressData.isProcessing) {
      clearInterval(progressInterval);
      return;
    }
    if (progressData.progressToken == null) return;

    const baseMessage = progressMessages[messageIndex % progressMessages.length];
    const outputPreview = progressData.latestOutput.slice(-150).trim();
    const message = outputPreview
      ? `${baseMessage}\n📝 Output: ...${outputPreview}`
      : baseMessage;

    progress += 1;
    messageIndex++;

    await sendProgressNotification(
      notify,
      progressData,
      progress,
      undefined,
      message,
    );
  }, keepaliveInterval);

  progressData.interval = progressInterval;
  return progressData;
}

export async function stopProgressUpdates(
  progressData: ProgressData,
): Promise<void> {
  progressData.isProcessing = false;
  if (progressData.interval) {
    clearInterval(progressData.interval);
  }

  // Drain any progress notification whose stdout write may still be in
  // flight. If one of these landed after the tool response, the client
  // would log "progress notification for an unknown token" and drop the
  // stdio transport. Waiting here guarantees the response is the last
  // message the client sees for this token. No terminal "100%" is
  // emitted — the tool response itself is the completion signal.
  if (progressData.pendingNotifications.size > 0) {
    await Promise.allSettled([...progressData.pendingNotifications]);
  }
}
