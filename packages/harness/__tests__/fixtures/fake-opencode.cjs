#!/usr/bin/env node
/**
 * Fake opencode CLI for harness / sessions e2e tests.
 *
 * The real `opencode` CLI is spawned by `@aaspai/harness`'s opencode-cli
 * driver. To exercise the adapter deterministically (every event kind, every
 * error path, every timeout, every session-resume round trip) without
 * depending on a live LLM, this fixture is a self-contained Node script
 * that the tests point at via the adapter's `command` config field.
 *
 * Behavior is driven by markers in the prompt (the last positional argv).
 * Markers are XML-ish so they're easy to grep for in test fixtures and
 * can coexist with arbitrary user prompts.
 *
 *   <e2e:success>             - default; emits step_start, text, step_finish
 *   <e2e:success:multi>       - emits 3 text events before step_finish
 *   <e2e:success:long:N>      - emits one text event of N chars
 *   <e2e:response:XYZ>        - text payload override (default: "PONG from fake opencode")
 *   <e2e:session:ses_xyz>     - override the emitted sessionID
 *   <e2e:no_session>          - omit sessionID from all events
 *   <e2e:tokens:I,O,C,R,cost> - override the step_finish token counters
 *   <e2e:tool>                - emit a tool_use event with a fake tool call
 *
 *   <e2e:error:auth>          - emits {type:"error", error:{message:"api key invalid"}}, exit 1
 *   <e2e:error:quota>         - emits {type:"error", error:{message:"rate limit exceeded"}}, exit 1
 *   <e2e:error:refusal>       - emits {type:"error", error:{message:"content policy"}}, exit 1
 *   <e2e:error:generic>       - emits error with no recognized marker, exit 1
 *   <e2e:error:stderr>        - writes text to stderr, emits no JSON, exit 1
 *
 *   <e2e:hang>                - never returns (used for timeout tests)
 *   <e2e:exit:N>              - exit with code N after a successful event stream
 *   <e2e:delay:N>             - sleep N ms before emitting any events
 *   <e2e:thinking>            - emit a thinking event alongside the text event
 *   <e2e:assert_flag:FLAG>    - exit 1 with stderr msg if FLAG is not in process.argv
 *   <e2e:models_dump>         - print fake 'opencode models' style output (one model per line)
 *   <e2e:hello:REPLY>         - reply with REPLY (default "HELLO_PROBE_OK") for hello probe
 *   <e2e:hello>               - same as <e2e:hello:HELLO_PROBE_OK>
 *
 * The script is intentionally a single file with no deps so it runs
 * identically on Windows, macOS, and Linux. The adapter invokes it
 * exactly the way it would invoke the real `opencode` binary:
 *
 *   <fake> run --format json --model <model> --title <title> <prompt...>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function parsePrompt(rawPrompt) {
  // Strip the `run` subcommand, --format, --model, --title, and any
  // additional flags; the prompt is whatever's left at the tail. We
  // accept it as the last argv, but be defensive: the adapter passes
  // the prompt as a single positional so we read it from the end.
  let prompt = rawPrompt || "";
  for (let i = process.argv.length - 1; i >= 0; i--) {
    const a = process.argv[i];
    if (typeof a === "string" && a.length > 0 && !a.startsWith("-")) {
      prompt = a;
      break;
    }
  }
  return prompt;
}

function pickSessionId(prompt) {
  const m = /<e2e:session:([^>]+)>/.exec(prompt);
  if (m) return m[1];
  if (/<e2e:no_session>/.test(prompt)) return null;
  return "ses_test_" + Math.random().toString(36).slice(2, 10);
}

function pickText(prompt) {
  const m = /<e2e:response:([^>]+)>/.exec(prompt);
  if (m) return m[1];
  return "PONG from fake opencode";
}

function pickTokens(prompt) {
  const m = /<e2e:tokens:(\d+),(\d+),(\d+),(\d+),([\d.]+)>/.exec(prompt);
  if (m) {
    return {
      input: Number(m[1]),
      output: Number(m[2]),
      reasoning: Number(m[3]),
      cacheRead: Number(m[4]),
      cost: Number(m[5]),
    };
  }
  return { input: 100, output: 50, reasoning: 10, cacheRead: 0, cost: 0.001 };
}

function pickExitCode(prompt) {
  const m = /<e2e:exit:(\d+)>/.exec(prompt);
  return m ? Number(m[1]) : 0;
}

function pickDelay(prompt) {
  const m = /<e2e:delay:(\d+)>/.exec(prompt);
  return m ? Number(m[1]) : 0;
}

function part(type, extra) {
  return Object.assign(
    {
      type,
      id: "prt_" + Math.random().toString(36).slice(2, 10),
      messageID: "msg_" + Math.random().toString(36).slice(2, 10),
    },
    extra || {},
  );
}

function textEvent(sessionID, text) {
  return {
    type: "text",
    timestamp: Date.now(),
    sessionID,
    part: part("text", { text }),
  };
}

function stepStartEvent(sessionID) {
  return {
    type: "step_start",
    timestamp: Date.now(),
    sessionID,
    part: part("step-start"),
  };
}

function stepFinishEvent(sessionID, tokens, reason) {
  return {
    type: "step_finish",
    timestamp: Date.now(),
    sessionID,
    part: part("step-finish", {
      reason: reason || "stop",
      tokens: {
        total: tokens.input + tokens.output + tokens.reasoning,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cacheRead, write: 0 },
      },
      cost: tokens.cost,
    }),
  };
}

function toolUseEvent(sessionID, name) {
  return {
    type: "tool_use",
    timestamp: Date.now(),
    sessionID,
    part: part("tool", {
      tool: name,
      callID: "call_" + Math.random().toString(36).slice(2, 10),
      state: { status: "completed", output: "ok" },
    }),
  };
}

function thinkingEvent(sessionID, text) {
  return {
    type: "thinking",
    timestamp: Date.now(),
    sessionID,
    part: part("thinking", { text: text || "let me think..." }),
  };
}

function errorEvent(sessionID, message) {
  return {
    type: "error",
    timestamp: Date.now(),
    sessionID,
    error: { message },
  };
}

async function runSuccessStream(prompt) {
  const sessionID = pickSessionId(prompt);
  const text = pickText(prompt);
  const tokens = pickTokens(prompt);
  const delay = pickDelay(prompt);

  if (delay > 0) await new Promise((r) => setTimeout(r, delay));

  emit(stepStartEvent(sessionID));

  if (/<e2e:assert_flag:([^>]+)>/.test(prompt)) {
    const want = /<e2e:assert_flag:([^>]+)>/.exec(prompt)[1];
    if (!process.argv.includes(want)) {
      process.stderr.write(`expected flag not found in argv: ${want}\n`);
      process.exit(1);
      return;
    }
  }

  if (/<e2e:thinking>/.test(prompt)) {
    emit(thinkingEvent(sessionID, "reasoning about " + text.slice(0, 30)));
  }

  if (/<e2e:success:multi>/.test(prompt)) {
    emit(textEvent(sessionID, text + " (1/3)"));
    emit(textEvent(sessionID, text + " (2/3)"));
    emit(textEvent(sessionID, text + " (3/3)"));
  } else {
    const longMatch = /<e2e:success:long:(\d+)>/.exec(prompt);
    if (longMatch) {
      const target = Number(longMatch[1]);
      emit(textEvent(sessionID, "x".repeat(target)));
    } else {
      emit(textEvent(sessionID, text));
    }
  }

  if (/<e2e:tool>/.test(prompt)) {
    emit(toolUseEvent(sessionID, "bash"));
  }

  emit(stepFinishEvent(sessionID, tokens));
  process.exit(pickExitCode(prompt));
}

function runErrorStream(prompt, kind) {
  const sessionID = pickSessionId(prompt);
  emit(stepStartEvent(sessionID));
  let message;
  switch (kind) {
    case "auth":
      message = "api key invalid: please re-authenticate";
      break;
    case "quota":
      message = "rate limit exceeded; try again later";
      break;
    case "refusal":
      message = "content policy refusal";
      break;
    case "generic":
    default:
      message = "an unspecified error occurred";
  }
  emit(errorEvent(sessionID, message));
  emit(stepFinishEvent(sessionID, pickTokens(prompt), "error"));
  process.exit(1);
}

function runStderrOnlyError() {
  // Synchronous write + flush + exit. The parent's child.stderr
  // data handler should see the write via the OS pipe before the
  // exit-1 reaches the parent's close handler.
  process.stderr.write("fatal: opencode provider rejected the request\n");
  if (process.stderr._handle && typeof process.stderr._handle.flushSync === "function") {
    process.stderr._handle.flushSync();
  }
  process.exit(1);
}

function runHang() {
  // Never return. The adapter's 5-min hard timeout will SIGTERM us.
  setInterval(() => {}, 1 << 30);
}

async function main() {
  // Honor the AASPAI_FAKE_OPENCODE env var as an explicit override
  // for the prompt — useful when the test wants to drive behavior
  // without polluting the user-visible prompt.
  const prompt = parsePrompt(process.env.AASPAI_FAKE_OPENCODE_PROMPT_OVERRIDE || "");

  // Diagnostic: write the full argv to a file. The harness e2e
  // suite uses this to verify that `--session <id>` (and other
  // flags) actually reach the CLI.
  if (process.env.AASPAI_FAKE_OPENCODE_DUMP_ARGV) {
    try {
      require("node:fs").writeFileSync(
        process.env.AASPAI_FAKE_OPENCODE_DUMP_ARGV,
        JSON.stringify(process.argv, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }
  // Diagnostic: write the value of every OPENCODE_*/XDG_CONFIG_HOME
  // env var to the probe file. Tests use this to assert that
  // config injection actually reaches the child.
  if (process.env.AASPAI_FAKE_OPENCODE_PROBE_FILE) {
    try {
      const env = process.env;
      const interesting = {};
      for (const k of Object.keys(env)) {
        if (k.startsWith("OPENCODE_") || k === "XDG_CONFIG_HOME") {
          interesting[k] = env[k];
        }
      }
      require("node:fs").writeFileSync(
        process.env.AASPAI_FAKE_OPENCODE_PROBE_FILE,
        JSON.stringify(interesting, null, 2),
      );
    } catch {
      /* best-effort */
    }
  }

  if (process.env.AASPAI_FAKE_OPENCODE_STDERR) {
    process.stderr.write(process.env.AASPAI_FAKE_OPENCODE_STDERR + "\n");
    if (process.stderr._handle && typeof process.stderr._handle.flushSync === "function") {
      process.stderr._handle.flushSync();
    }
  }
  if (process.env.AASPAI_FAKE_OPENCODE_STDOUT) {
    process.stdout.write(process.env.AASPAI_FAKE_OPENCODE_STDOUT + "\n");
  }

  if (/<e2e:hang>/.test(prompt)) {
    return runHang();
  }
  if (/<e2e:error:auth>/.test(prompt)) {
    return runErrorStream(prompt, "auth");
  }
  if (/<e2e:error:quota>/.test(prompt)) {
    return runErrorStream(prompt, "quota");
  }
  if (/<e2e:error:refusal>/.test(prompt)) {
    return runErrorStream(prompt, "refusal");
  }
  if (/<e2e:error:generic>/.test(prompt)) {
    return runErrorStream(prompt, "generic");
  }
  if (/<e2e:error:stderr>/.test(prompt)) {
    return runStderrOnlyError();
  }
  if (/<e2e:models_dump>/.test(prompt)) {
    // Print a fake "opencode models" style response: one model per line.
    process.stdout.write([
      "opencode-go/mimo-v2.5",
      "opencode-go/mimo-v2.5-pro",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/glm-5.2",
      "opencode-go/kimi-k3",
    ].join("\n") + "\n");
    process.exit(0);
    return;
  }
  if (/<e2e:hello(:([^>]+))?>/.test(prompt)) {
    const m = /<e2e:hello:([^>]+)>/.exec(prompt);
    const reply = m ? m[1] : "HELLO_PROBE_OK";
    const sessionID = pickSessionId(prompt);
    emit(stepStartEvent(sessionID));
    emit(textEvent(sessionID, reply));
    emit(stepFinishEvent(sessionID, pickTokens(prompt)));
    process.exit(0);
    return;
  }
  return runSuccessStream(prompt);
}

main().catch((err) => {
  process.stderr.write(`fake-opencode: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
});

// Best-effort: tell the parent we're alive. Helps the harness's
// `onSpawn` callback log a useful pid.
try {
  fs.writeFileSync(
    path.join(
      process.env.AASPAI_FAKE_OPENCODE_PIDFILE ||
        path.join(require("node:os").tmpdir(), "aaspai-fake-opencode.spawn"),
    ),
    String(process.pid),
  );
} catch {
  // best-effort
}
