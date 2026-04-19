import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

class JsonRpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonRpcMessage[] = [];

  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private closing = false;
  private waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(serverPath: string) {
    this.child = spawn(process.execPath, [serverPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;

      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          const message = JSON.parse(line) as JsonRpcMessage;
          this.messages.push(message);
          this.resolveWaiters(message);
        }

        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.child.on("exit", (code, signal) => {
      if (this.closing) return;

      const exitError = new Error(
        `MCP server exited unexpectedly (code=${code}, signal=${signal}). stderr:\n${this.stderr}`,
      );

      for (const waiter of this.waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(exitError);
      }
      this.waiters.clear();
    });
  }

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const responsePromise = this.waitForMessage((message) => message.id === id);

    this.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    });

    const response = await responsePromise;
    assert.equal(response.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(response.error)}`);
    return response;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send({
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;

    this.closing = true;
    this.child.kill("SIGTERM");

    const exited = await Promise.race([
      once(this.child, "exit").then(() => true),
      delay(2000).then(() => false),
    ]);

    if (!exited) {
      this.child.kill("SIGKILL");
      await once(this.child, "exit");
    }
  }

  private send(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private waitForMessage(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<JsonRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Timed out waiting for JSON-RPC message. stderr:\n${this.stderr}\nmessages:\n${JSON.stringify(this.messages, null, 2)}`,
          ),
        );
      }, timeoutMs);

      const waiter = { predicate, resolve, reject, timer };
      this.waiters.add(waiter);
    });
  }

  private resolveWaiters(message: JsonRpcMessage): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
}

const serverPath = path.resolve(process.cwd(), "dist/index.js");
const skipReason = existsSync(serverPath)
  ? false
  : "dist/index.js is missing; run npm run build first";

test(
  "stdio initialize and tools/call progress stay ordered",
  { skip: skipReason, timeout: 10000 },
  async () => {
    const client = new JsonRpcChild(serverPath);

    try {
      const initializeResponse = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "stdio-e2e-test",
          version: "1.0.0",
        },
      });

      assert.equal(initializeResponse.result?.serverInfo?.name, "gemini-cli-mcp");
      assert.equal(initializeResponse.result?.capabilities?.tools !== undefined, true);

      client.notify("notifications/initialized");

      const listResponse = await client.request("tools/list");
      const tools = listResponse.result?.tools;

      assert.ok(Array.isArray(tools));

      const askGeminiTool = tools.find(
        (tool): tool is Record<string, unknown> =>
          typeof tool === "object" &&
          tool !== null &&
          tool.name === "ask-gemini",
      );

      assert.ok(askGeminiTool, "ask-gemini should be present in tools/list");

      const includeDirectories = (
        askGeminiTool.inputSchema as { properties?: Record<string, Record<string, unknown>> }
      ).properties?.includeDirectories;

      assert.ok(includeDirectories, "ask-gemini schema should expose includeDirectories");
      assert.equal(includeDirectories.type, "array");
      assert.match(String(includeDirectories.description), /--include-directories/);

      const callResponse = await client.request("tools/call", {
        name: "ping",
        arguments: {
          prompt: "ping from e2e",
        },
        _meta: {
          progressToken: 0,
        },
      });

      const responseIndex = client.messages.indexOf(callResponse);
      const progressNotifications = client.messages.filter(
        (message) =>
          message.method === "notifications/progress" &&
          message.params?.progressToken === 0,
      );

      assert.ok(progressNotifications.length >= 1, "progressToken=0 should emit progress notifications");
      assert.equal(callResponse.result?.isError, false);
      assert.equal(
        (
          ((callResponse.result?.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ??
          ""
        ).includes("ping from e2e"),
        true,
      );

      await delay(100);

      const notificationsAfterResponse = client.messages
        .slice(responseIndex + 1)
        .filter(
          (message) =>
            message.method === "notifications/progress" &&
            message.params?.progressToken === 0,
        );

      assert.equal(
        notificationsAfterResponse.length,
        0,
        "no progress notification should arrive after the tool response",
      );
    } finally {
      await client.close();
      assert.equal(
        client.child.exitCode !== null || client.child.signalCode !== null,
        true,
        "child process should be terminated",
      );
    }
  },
);
