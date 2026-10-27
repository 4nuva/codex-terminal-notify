"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { build, detectFormat, deviceOf, envFromPs, mask, matchTerminals, output, sequence, summarize } = require("../hooks/notify.js");

const SCRIPT = path.join(__dirname, "..", "hooks", "notify.js");
const stop = { hook_event_name: "Stop", cwd: "/work/my-app", last_assistant_message: "Fixed the bug. Tests pass. More text." };

test("Stop names the folder and the start of the reply", () => {
  assert.deepStrictEqual(build(stop, {}), {
    title: "Codex · my-app",
    body: "Task complete: Fixed the bug. Tests pass.",
  });
});

test("Stop with no reply text says only that the task is complete", () => {
  assert.strictEqual(build({ ...stop, last_assistant_message: null }, {}).body, "Task complete");
});

test("subagents stay quiet", () => {
  assert.strictEqual(build({ ...stop, agent_id: "a1", agent_type: "explorer" }, {}), null);
});

test("permission and question bodies", () => {
  const perm = build({ hook_event_name: "PermissionRequest", cwd: "C:\\src\\app\\", tool_name: "Bash", tool_input: { command: "npm test" } }, {});
  assert.strictEqual(perm.title, "Codex · app");
  assert.strictEqual(perm.body, "Permission needed: Bash — npm test");
  const q = build({ hook_event_name: "PreToolUse", tool_name: "request_user_input", tool_input: { questions: [{ question: "Which one?" }] } }, {});
  assert.strictEqual(q.body, "Question: Which one?");
  assert.strictEqual(build({ hook_event_name: "PreToolUse", tool_name: "request_user_input", tool_input: {} }, {}).body, "Question waiting");
  assert.strictEqual(build({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, {}), null);
});

test("other events raise nothing", () => {
  for (const hook_event_name of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Interrupt"]) {
    assert.strictEqual(build({ hook_event_name, cwd: "/x" }, {}), null);
  }
});

test("a patch permission names the files, not the patch", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch";
  assert.strictEqual(summarize({ command: patch }), "src/a.ts, src/b.ts");
  assert.strictEqual(summarize(patch), "src/a.ts, src/b.ts");
  assert.strictEqual(summarize({ command: ["git", "status"] }), "git status");
  const perm = build({ hook_event_name: "PermissionRequest", tool_name: "apply_patch", tool_input: { command: patch } }, {});
  assert.strictEqual(perm.body, "Permission needed: apply_patch — src/a.ts, src/b.ts");
});

test("details off shows the event alone", () => {
  const env = { TERMINAL_NOTIFY_DETAILS: "false" };
  assert.strictEqual(build(stop, env).body, "Task complete");
  assert.strictEqual(build({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf x" } }, env).body, "Permission needed: Bash");
});

test("secrets are masked", () => {
  assert.strictEqual(mask("key sk-abcdefghijkl here"), "key *** here");
  assert.strictEqual(mask("token=hunter2abc"), "token=***");
  assert.strictEqual(mask("https://user:pw@example.com/x"), "***example.com/x");
  const perm = build({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'" } }, {});
  assert.ok(!perm.body.includes("abcdefghijklmnop"));
});

test("control characters cannot break out of the sequence", () => {
  const n = build({ ...stop, last_assistant_message: "Done\x07\x1b]52;c;AAAA\x07 now\u009c." }, {});
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(n.body));
});

test("terminal detection", () => {
  assert.strictEqual(detectFormat({ AGENT_TERMINAL_SESSION_ID: "s1", WT_SESSION: "x" }), "osc777");
  assert.strictEqual(detectFormat({ KITTY_WINDOW_ID: "1" }), "osc99");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "ghostty" }), "osc777");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "WarpTerminal" }), "osc777");
  assert.strictEqual(detectFormat({ TERM: "rxvt-unicode-256color" }), "osc777");
  assert.strictEqual(detectFormat({ WT_SESSION: "x" }), "osc9");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "iTerm.app" }), "osc9");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "WezTerm" }), "osc9");
  assert.strictEqual(detectFormat({ TERM_PROGRAM: "Apple_Terminal" }), "bell");
  assert.strictEqual(detectFormat({}), "osc9");
});

test("sequences", () => {
  assert.strictEqual(sequence("osc777", "T;x", "a;b"), "\x1b]777;notify;T,x;a,b\x07");
  assert.strictEqual(sequence("osc9", "T", "b"), "\x1b]9;T: b\x07");
  assert.strictEqual(sequence("osc9", "4", "x"), "\x1b]9;· 4: x\x07");
  assert.strictEqual(sequence("osc9", " -1 x", "y"), "\x1b]9;·  -1 x: y\x07");
  assert.strictEqual(
    sequence("all", "T", "b"),
    "\x1b]9;T: b\x07" + "\x1b]99;;T: b\x1b\\" + "\x1b]777;notify;T;b\x07",
  );
  assert.strictEqual(sequence("osc99", "T", "a;b"), "\x1b]99;;T: a,b\x1b\\");
  assert.strictEqual(sequence("bell", "T", "b"), "\x07");
});

test("the output is the escape sequence; format overrides detection, off and bad values", () => {
  assert.strictEqual(output(stop, { AGENT_TERMINAL_SESSION_ID: "s1" }), "\x1b]777;notify;Codex · my-app;Task complete: Fixed the bug. Tests pass.\x07");
  assert.ok(output(stop, { WT_SESSION: "x", TERMINAL_NOTIFY_FORMAT: "osc777" }).startsWith("\x1b]777;"));
  assert.strictEqual(output(stop, { TERMINAL_NOTIFY_FORMAT: "off" }), null);
  assert.ok(output(stop, { WT_SESSION: "x", TERMINAL_NOTIFY_FORMAT: "nonsense" }).startsWith("\x1b]9;"));
  assert.strictEqual(output(stop, { TERMINAL_NOTIFY_FORMAT: "bell" }), "\x07");
  assert.strictEqual(output({ hook_event_name: "SessionStart" }, {}), null);
});

test("terminal names from ps", () => {
  assert.strictEqual(deviceOf("ttys003"), "/dev/ttys003");
  assert.strictEqual(deviceOf("pts/3"), "/dev/pts/3");
  assert.strictEqual(deviceOf("??"), null);
  assert.strictEqual(deviceOf("?"), null);
  assert.strictEqual(deviceOf("-"), null);
  assert.strictEqual(deviceOf("../../etc/x y"), null);
  assert.strictEqual(deviceOf(""), null);
});

test("the terminal's variables come out of a ps environment line", () => {
  const line = "codex FOO=1 TERM=xterm-256color XTERM=no TERM_PROGRAM=Apple_Terminal AGENT_TERMINAL_SESSION_ID=abc TERMINAL_NOTIFY_FORMAT=osc9";
  assert.deepStrictEqual(envFromPs(line), {
    TERM: "xterm-256color",
    TERM_PROGRAM: "Apple_Terminal",
    AGENT_TERMINAL_SESSION_ID: "abc",
    TERMINAL_NOTIFY_FORMAT: "osc9",
  });
  assert.deepStrictEqual(envFromPs(""), {});
});

test("a session notifies the terminals of codex processes in its folder only", () => {
  const procs = [
    { pid: "1", device: "/dev/ttys001", cwd: "/work/a" },
    { pid: "2", device: "/dev/ttys002", cwd: "/work/b" },
    { pid: "3", device: "/dev/ttys003", cwd: "/work/b" },
    { pid: "4", device: "/dev/ttys004", cwd: null },
  ];
  assert.deepStrictEqual(matchTerminals(procs, "/work/a").map((c) => c.pid), ["1"]);
  assert.deepStrictEqual(matchTerminals(procs, "/work/b").map((c) => c.pid), ["2", "3"]);
  assert.deepStrictEqual(matchTerminals(procs, "/work/c"), []);
  assert.deepStrictEqual(matchTerminals(procs, ""), []);
  assert.deepStrictEqual(matchTerminals([{ pid: "1", device: "/dev/ttys001", cwd: "/work/a" }], "/work/zzz"), []);
});

test("the script prints nothing and exits 0, even on bad input", () => {
  // An event that raises no notification, so no terminal is looked up.
  const quiet = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify({ hook_event_name: "SessionStart", cwd: "/x" }) });
  assert.strictEqual(quiet.status, 0);
  assert.strictEqual(quiet.stdout.toString(), "");
  const bad = spawnSync(process.execPath, [SCRIPT], { input: "not json" });
  assert.strictEqual(bad.status, 0);
  assert.strictEqual(bad.stdout.toString(), "");
});
