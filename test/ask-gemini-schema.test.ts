import assert from "node:assert/strict";
import test from "node:test";
import { askGeminiTool } from "../src/tools/ask-gemini.tool.js";

function getMessages(input: unknown): string[] {
  const result = askGeminiTool.zodSchema.safeParse(input);
  assert.equal(result.success, false, "expected schema parse to fail");
  return result.error.issues.map((issue) => issue.message);
}

test("ask-gemini schema accepts prompt only", () => {
  const result = askGeminiTool.zodSchema.safeParse({ prompt: "x" });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.prompt, "x");
  }
});

test("ask-gemini schema accepts includeDirectories", () => {
  const result = askGeminiTool.zodSchema.safeParse({
    prompt: "x",
    includeDirectories: ["/a", "/b"],
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.includeDirectories, ["/a", "/b"]);
  }
});

test("ask-gemini schema rejects an empty prompt", () => {
  assert.match(getMessages({ prompt: "" }).join("\n"), /at least 1 character/i);
});

test("ask-gemini schema rejects an empty includeDirectories array", () => {
  assert.match(
    getMessages({ prompt: "x", includeDirectories: [] }).join("\n"),
    /at least 1 element/i,
  );
});

test("ask-gemini schema rejects more than 32 includeDirectories entries", () => {
  const includeDirectories = Array.from({ length: 33 }, (_, index) => `/dir-${index}`);

  assert.match(
    getMessages({ prompt: "x", includeDirectories }).join("\n"),
    /at most 32 element/i,
  );
});

test("ask-gemini schema rejects includeDirectories entries longer than 1024 characters", () => {
  const tooLong = "a".repeat(1025);

  assert.match(
    getMessages({ prompt: "x", includeDirectories: [tooLong] }).join("\n"),
    /at most 1024 character/i,
  );
});

test("ask-gemini schema rejects empty includeDirectories entries", () => {
  assert.match(
    getMessages({ prompt: "x", includeDirectories: [""] }).join("\n"),
    /at least 1 character/i,
  );
});

test("ask-gemini schema rejects whitespace-only includeDirectories entries", () => {
  assert.match(
    getMessages({ prompt: "x", includeDirectories: ["   "] }).join("\n"),
    /must not be blank/i,
  );
});

test("ask-gemini schema rejects trimmed blank includeDirectories entries", () => {
  assert.match(
    getMessages({ prompt: "x", includeDirectories: ["\u00A0\t"] }).join("\n"),
    /must not be blank/i,
  );
});

test("ask-gemini schema rejects non-array includeDirectories values", () => {
  assert.match(
    getMessages({ prompt: "x", includeDirectories: "/a" }).join("\n"),
    /expected array/i,
  );
});
