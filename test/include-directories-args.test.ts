import assert from "node:assert/strict";
import test from "node:test";
import { appendIncludeDirectoriesArgs } from "../src/utils/geminiExecutor.js";

test("appendIncludeDirectoriesArgs is a no-op for undefined includeDirectories", () => {
  const args = ["-m", "gemini-2.5-pro"];

  appendIncludeDirectoriesArgs(args);

  assert.deepEqual(args, ["-m", "gemini-2.5-pro"]);
});

test("appendIncludeDirectoriesArgs is a no-op for an empty includeDirectories array", () => {
  const args = ["-m", "gemini-2.5-pro"];

  appendIncludeDirectoriesArgs(args, []);

  assert.deepEqual(args, ["-m", "gemini-2.5-pro"]);
});

test("appendIncludeDirectoriesArgs appends a single includeDirectories entry", () => {
  const args: string[] = [];

  appendIncludeDirectoriesArgs(args, ["/a"]);

  assert.deepEqual(args, ["--include-directories", "/a"]);
});

test("appendIncludeDirectoriesArgs appends repeated flags for multiple entries", () => {
  const args: string[] = [];

  appendIncludeDirectoriesArgs(args, ["/a", "/b"]);

  assert.deepEqual(args, [
    "--include-directories",
    "/a",
    "--include-directories",
    "/b",
  ]);
});

test("appendIncludeDirectoriesArgs preserves entries containing commas", () => {
  const args: string[] = [];

  appendIncludeDirectoriesArgs(args, ["/tmp/alpha,beta"]);

  assert.deepEqual(args, ["--include-directories", "/tmp/alpha,beta"]);
});
