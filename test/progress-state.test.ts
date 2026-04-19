import assert from "node:assert/strict";
import test from "node:test";
import {
  startProgressUpdates,
  stopProgressUpdates,
  type ProgressNotification,
} from "../src/progress.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("startProgressUpdates enrolls the initial notification before returning", async () => {
  const deferred = createDeferred();
  const notify = async () => deferred.promise;
  const progressData = startProgressUpdates("ask-gemini", "token", notify, 1000);

  assert.equal(progressData.pendingNotifications.size, 1);

  deferred.resolve();
  await stopProgressUpdates(progressData);
});

test("stopProgressUpdates waits for in-flight notifications to finish", async () => {
  const deferred = createDeferred();
  const notify = async () => deferred.promise;
  const progressData = startProgressUpdates("ask-gemini", "token", notify, 1000);

  const stopPromise = stopProgressUpdates(progressData);
  let settled = false;
  void stopPromise.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  deferred.resolve();
  await stopPromise;
  assert.equal(settled, true);
});

test("numeric progress token 0 still sends notifications", async () => {
  const notifications: ProgressNotification[] = [];
  const notify = async (notification: ProgressNotification) => {
    notifications.push(notification);
  };

  const progressData = startProgressUpdates("ask-gemini", 0, notify, 1000);

  await Promise.allSettled([...progressData.pendingNotifications]);
  await stopProgressUpdates(progressData);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.params.progressToken, 0);
});

test("empty-string progress token still sends notifications", async () => {
  const notifications: ProgressNotification[] = [];
  const notify = async (notification: ProgressNotification) => {
    notifications.push(notification);
  };

  const progressData = startProgressUpdates("ask-gemini", "", notify, 1000);

  await Promise.allSettled([...progressData.pendingNotifications]);
  await stopProgressUpdates(progressData);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.params.progressToken, "");
});

test("undefined progress token sends nothing", async () => {
  const notifications: ProgressNotification[] = [];
  const notify = async (notification: ProgressNotification) => {
    notifications.push(notification);
  };

  const progressData = startProgressUpdates("ask-gemini", undefined, notify, 5);

  await delay(15);
  await stopProgressUpdates(progressData);

  assert.equal(notifications.length, 0);
});

test("a queued tick does not send after stopProgressUpdates", async () => {
  const notifications: ProgressNotification[] = [];
  const timerCallbacks: Array<() => void | Promise<void>> = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = ((callback: TimerHandler) => {
    timerCallbacks.push(callback as () => void | Promise<void>);
    return { mocked: true } as unknown as NodeJS.Timeout;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval;

  try {
    const notify = async (notification: ProgressNotification) => {
      notifications.push(notification);
    };
    const progressData = startProgressUpdates("ask-gemini", "token", notify, 5);

    assert.equal(timerCallbacks.length, 1);
    await Promise.allSettled([...progressData.pendingNotifications]);
    await stopProgressUpdates(progressData);
    await Promise.resolve();
    await timerCallbacks[0]?.();

    assert.equal(notifications.length, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
