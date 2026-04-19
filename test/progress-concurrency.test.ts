import assert from "node:assert/strict";
import test from "node:test";
import {
  startProgressUpdates,
  stopProgressUpdates,
  type ProgressNotification,
} from "../src/progress.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("progress state stays isolated per concurrent request", async () => {
  const notifications: ProgressNotification[] = [];
  const notify = async (notification: ProgressNotification) => {
    notifications.push(notification);
  };

  const progressA = startProgressUpdates("request-a", "token-a", notify, 5);
  const progressB = startProgressUpdates("request-b", "token-b", notify, 5);

  const onProgressA = (newOutput: string) => {
    progressA.latestOutput = newOutput;
  };
  const onProgressB = (newOutput: string) => {
    progressB.latestOutput = newOutput;
  };

  onProgressA("alpha output");
  onProgressB("beta output");

  assert.equal(progressA.latestOutput, "alpha output");
  assert.equal(progressB.latestOutput, "beta output");

  await delay(15);

  const messagesA = notifications
    .filter((notification) => notification.params.progressToken === "token-a")
    .map((notification) => notification.params.message ?? "");
  const messagesB = notifications
    .filter((notification) => notification.params.progressToken === "token-b")
    .map((notification) => notification.params.message ?? "");

  assert.ok(messagesA.some((message) => message.includes("alpha output")));
  assert.ok(messagesA.every((message) => !message.includes("beta output")));
  assert.ok(messagesB.some((message) => message.includes("beta output")));
  assert.ok(messagesB.every((message) => !message.includes("alpha output")));

  const notificationsBBeforeStop = notifications.filter(
    (notification) => notification.params.progressToken === "token-b",
  ).length;

  await stopProgressUpdates(progressA);

  assert.equal(progressA.isProcessing, false);
  assert.equal(progressB.isProcessing, true);

  await delay(15);

  const notificationsBAfterStop = notifications.filter(
    (notification) => notification.params.progressToken === "token-b",
  ).length;

  assert.ok(notificationsBAfterStop > notificationsBBeforeStop);
  assert.ok(
    notifications.every((notification) =>
      notification.params.progressToken === "token-a" ||
      notification.params.progressToken === "token-b",
    ),
  );

  await stopProgressUpdates(progressB);
});
