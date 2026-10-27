// terminal-notify: a Codex hook that raises a desktop notification through
// the terminal Codex runs in. It writes an escape sequence (OSC 777, 9 or 99,
// or a bell, picked for the terminal) to the terminal itself, so no network
// and no dependencies. Codex hooks have no output field that carries a
// sequence, and run without a controlling terminal, so the script writes it
// to the terminal of the Codex process that started it.
//
// Made by the team behind Agent Terminal: https://4nuva.dev/agent-terminal/
//
// It always exits 0 and prints nothing when anything goes wrong: a
// notification must never get in the way of a session.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ESC = "\x1b";
const BEL = "\x07";
const ST = ESC + "\\";

const FORMATS = ["auto", "osc777", "osc9", "osc99", "all", "bell", "off"];

// Known key and token shapes, masked before any text leaves the session:
// a notification can land on a lock screen or a paired phone.
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@/gi, // credentials in a URL
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization)(\s*[=:]\s*)\S+/gi,
  /\b[A-Za-z0-9+\/_-]{40,}={0,2}/g,
];

function mask(s) {
  for (const re of SECRETS) {
    s = s.replace(re, (m, key, sep) =>
      typeof key === "string" && typeof sep === "string" ? `${key}${sep}***` : "***");
  }
  return s;
}

// One line of plain text: no control characters (C0, DEL, C1), so nothing in
// it can end the escape sequence early or start another one.
function clean(s) {
  s = String(s == null ? "" : s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return mask(s).replace(/\s+/g, " ").trim();
}

function cap(s, n) {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n - 1).join("") + "…";
}

// The first sentences of a reply, without code blocks or inline code.
function firstSentences(text, count) {
  let t = String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1");
  t = clean(t);
  if (!t) return "";
  const parts = t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [t];
  return parts.slice(0, count).join(" ").trim();
}

// The last assistant text in the rollout file, for a Stop input whose
// `last_assistant_message` is null. Reads the tail only.
function lastAssistantText(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      // `{"type":"response_item","payload":{"type":"message","role":"assistant",...}}`
      const m = entry && (entry.payload || entry);
      if (!m || m.role !== "assistant") continue;
      const c = m.content;
      const text = typeof c === "string" ? c
        : Array.isArray(c) ? c.filter((b) => b && typeof b.text === "string").map((b) => b.text).join(" ") : "";
      if (firstSentences(text, 1)) return text;
    }
  } finally {
    fs.closeSync(fd);
  }
  return "";
}

// The files an `apply_patch` call touches, or "" for any other text.
function patchFiles(text) {
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(text))) files.push(m[1].trim());
  return files.join(", ");
}

// The part of a tool call worth naming: its command, file, URL, ...
function summarize(input) {
  if (typeof input === "string") return patchFiles(input) || input;
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "cmd", "input", "patch", "file_path", "path", "url", "pattern", "query", "description", "prompt"]) {
    const v = Array.isArray(input[k]) ? input[k].join(" ") : input[k];
    if (typeof v === "string" && v) return patchFiles(v) || v;
  }
  for (const v of Object.values(input)) if (typeof v === "string" && v) return v;
  return "";
}

// A setting from the environment: `TERMINAL_NOTIFY_<KEY>`.
function option(env, key, fallback) {
  const v = env[`TERMINAL_NOTIFY_${key.toUpperCase()}`];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
}

function flag(env, key, fallback) {
  const v = option(env, key, "");
  if (!v) return fallback;
  return !/^(0|false|no|off)$/i.test(v);
}

// Which sequence the terminal shows as a notification.
function detectFormat(env) {
  const program = String(env.TERM_PROGRAM || "").toLowerCase();
  const term = String(env.TERM || "").toLowerCase();
  // Agent Terminal shows OSC 777 with its title and body, and forwards it to
  // the phones paired with it.
  if (env.AGENT_TERMINAL_SESSION_ID) return "osc777";
  if (env.KITTY_WINDOW_ID || term === "xterm-kitty") return "osc99";
  if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || program === "warpterminal" || term.includes("rxvt")) {
    return "osc777";
  }
  if (program === "iterm.app" || program === "wezterm" || env.WT_SESSION || env.ConEmuPID) return "osc9";
  // Terminals with no notification sequence: the bell at least gets a look.
  if (program === "apple_terminal" || program === "vscode") return "bell";
  return "osc9";
}

function sequence(format, title, body) {
  switch (format) {
    case "osc777":
      // `;` separates the fields, so neither part may hold one.
      return `${ESC}]777;notify;${title.replace(/;/g, ",")};${body.replace(/;/g, ",")}${BEL}`;
    case "osc9": {
      // A body that starts with a number reads as a ConEmu command (`9;4`
      // progress, ...), and the terminal drops it.
      let text = `${title}: ${body}`;
      if (/^[\s᠎​]*[+-]?\p{Nd}/u.test(text)) text = `· ${text}`;
      return `${ESC}]9;${text}${BEL}`;
    }
    case "osc99":
      return `${ESC}]99;;${`${title}: ${body}`.replace(/;/g, ",")}${ST}`;
    case "all":
      // Every notification sequence, for a terminal the detection does not
      // know. A terminal that reads more than one shows more than one. 777
      // goes last: Agent Terminal keeps the last notice of a burst, and 777
      // is the one that carries the title.
      return ["osc9", "osc99", "osc777"].map((f) => sequence(f, title, body)).join("");
    case "bell":
      return BEL;
    default:
      return null;
  }
}

// The notification for a hook's input, or null when it raises none.
function build(p, env) {
  if (!p || typeof p !== "object") return null;
  // A subagent's hooks fire in the same session: only the main agent's
  // turns ask for the person.
  if (p.agent_id) return null;
  const details = flag(env, "details", true);
  const ev = p.hook_event_name;
  let body;
  if (ev === "Stop") {
    let ctx = "";
    if (details) {
      try {
        ctx = firstSentences(p.last_assistant_message, 2);
        if (!ctx && p.transcript_path) ctx = firstSentences(lastAssistantText(p.transcript_path), 2);
      } catch { ctx = ""; }
    }
    body = "Task complete" + (ctx ? `: ${ctx}` : "");
  } else if (ev === "PermissionRequest") {
    const tool = clean(p.tool_name) || "a tool";
    const sum = details ? cap(clean(summarize(p.tool_input)), 80) : "";
    body = `Permission needed: ${tool}` + (sum ? ` — ${sum}` : "");
  } else if (ev === "PreToolUse" && p.tool_name === "request_user_input") {
    const qs = p.tool_input && p.tool_input.questions;
    const q = details ? clean(Array.isArray(qs) && qs[0] ? qs[0].question : "") : "";
    body = "Question" + (q ? `: ${q}` : " waiting");
  } else {
    return null;
  }
  const folder = String(p.cwd || "").split(/[\\/]+/).filter(Boolean).pop() || "Codex";
  const title = cap(clean(`Codex · ${folder}`), 80);
  return { title, body: cap(clean(body), 200) };
}

// The escape sequence for a hook's input, or null when it raises none.
function output(p, env) {
  let format = option(env, "format", "auto").toLowerCase();
  if (!FORMATS.includes(format)) format = "auto";
  if (format === "off") return null;
  if (format === "auto") format = detectFormat(env);
  const n = build(p, env);
  if (!n) return null;
  return sequence(format, n.title, n.body);
}

// ---- Finding the terminal -------------------------------------------------
//
// Codex runs a hook from its app-server daemon, which has no terminal and
// keeps the environment of whichever terminal started it first. The terminal
// to notify is the one the `codex` process of this session runs in: found by
// its working directory, with its terminal device and environment read from
// the process.

// Environment variables the hook reads from the terminal's `codex` process.
const ENV_KEYS = [
  "TERM", "TERM_PROGRAM", "AGENT_TERMINAL_SESSION_ID", "KITTY_WINDOW_ID",
  "GHOSTTY_RESOURCES_DIR", "WT_SESSION", "ConEmuPID",
  "TERMINAL_NOTIFY_FORMAT", "TERMINAL_NOTIFY_DETAILS",
];

// A terminal name from `ps`, as a device path; null for "no terminal".
function deviceOf(tty) {
  if (!tty || !/^[A-Za-z0-9\/._-]+$/.test(tty) || /^\?+$/.test(tty) || tty === "-") return null;
  return `/dev/${tty}`;
}

// The wanted variables out of the `ps eww` command line, which ends with the
// process environment as `KEY=value` words.
function envFromPs(line) {
  const env = {};
  for (const key of ENV_KEYS) {
    const m = new RegExp(`(?:^|\\s)${key}=(\\S*)`).exec(line);
    if (m) env[key] = m[1];
  }
  return env;
}

// The processes whose terminal fits this session: the ones with the
// session's working directory. Two sessions in one folder both get the
// notification; a session from somewhere else (the desktop app) gets none.
function matchTerminals(candidates, cwd) {
  return candidates.filter((c) => c.cwd && cwd && c.cwd === cwd);
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; }
}

function processCwd(pid) {
  if (process.platform === "linux") {
    try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  const line = run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"]).split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

function processEnv(pid) {
  if (process.platform === "linux") {
    try {
      const text = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").join(" ");
      return envFromPs(text);
    } catch { return {}; }
  }
  return envFromPs(run("ps", ["eww", "-o", "command=", "-p", String(pid)]));
}

// The `codex` processes of this user that run in a terminal.
function codexProcesses() {
  let user;
  try { user = require("os").userInfo().username; } catch { return []; }
  const out = [];
  for (const line of run("ps", ["-U", user, "-o", "pid=,tty=,comm="]).split("\n")) {
    const [pid, tty, ...comm] = line.trim().split(/\s+/);
    const device = deviceOf(tty);
    if (!pid || !device || path.basename(comm.join(" ")) !== "codex") continue;
    out.push({ pid, device });
  }
  return out;
}

// The terminal device of the nearest ancestor that has one, for a Codex that
// runs its hooks itself.
function ancestorTerminal() {
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const [tty, ppid] = run("ps", ["-o", "tty=,ppid=", "-p", String(pid)]).trim().split(/\s+/);
    const device = deviceOf(tty);
    if (device) return device;
    pid = Number(ppid);
  }
  return null;
}

// Where to write, with the environment that tells the terminal apart.
function findTargets(p, env) {
  if (process.platform === "win32") return [{ device: "CONOUT$", env }];
  const own = ancestorTerminal();
  if (own) return [{ device: own, env }];
  const cwd = realpath(String(p.cwd || ""));
  const candidates = codexProcesses().map((c) => {
    const dir = processCwd(c.pid);
    return { ...c, cwd: dir && realpath(dir) };
  });
  return matchTerminals(candidates, cwd).map((c) => ({ device: c.device, env: processEnv(c.pid) }));
}

function writeTo(device, seq) {
  let fd;
  try {
    fd = fs.openSync(device, "w");
    fs.writeSync(fd, seq);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* closed */ }
    }
  }
}

function main() {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {
    try {
      const p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Nothing to show for most events: skip the process lookups.
      if (!build(p, {})) return;
      for (const t of findTargets(p, process.env)) {
        const seq = output(p, t.env);
        if (seq) writeTo(t.device, seq);
      }
    } catch {
      // Nothing to show.
    }
  });
}

if (require.main === module) {
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  process.exitCode = 0;
  main();
} else {
  module.exports = { build, clean, detectFormat, deviceOf, envFromPs, firstSentences, mask, matchTerminals, output, sequence, summarize };
}
