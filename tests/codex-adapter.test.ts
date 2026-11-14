import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CodexAdapter,
  isToolEvent,
  type SpawnProcess,
} from "../src/main/codex-adapter";

const proposal = {
  version: 1,
  summary: "Add report",
  idempotency_key: "test-codex-idempotency-0001",
  risk: "low",
  actions: [
    {
      type: "create",
      temp_id: "new-1",
      patch: { title: "交周报", list_id: "work" },
    },
  ],
};
const HELP =
  "--json --sandbox read-only --output-schema <FILE> --output-last-message <FILE> --ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check";
type Scenario =
  | "success"
  | "auth"
  | "quota"
  | "bad-json"
  | "bad-stream"
  | "tool"
  | "timeout"
  | "empty"
  | "nonzero"
  | "event-error"
  | "fragments"
  | "wire"
  | "clarify";
function harness(
  options: {
    help?: string;
    loggedIn?: boolean;
    scenario?: Scenario;
    timeoutMs?: number;
  } = {},
) {
  const calls: Array<{
    file: string;
    args: string[];
    options: Record<string, unknown>;
    input: string;
    killed: boolean;
  }> = [];
  const spawn: SpawnProcess = (file, args, spawnOptions) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call = {
      file,
      args,
      options: spawnOptions,
      input: "",
      killed: false,
    };
    calls.push(call);
    child.kill = () => {
      call.killed = true;
      child.emit("close", null);
      return true;
    };
    child.stdin.on("data", (data: Buffer) => (call.input += data.toString()));
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        const end = (stdout: string, code = 0, stderr = "") => {
          if (stdout) child.stdout.write(stdout);
          if (stderr) child.stderr.write(stderr);
          child.emit("close", code);
        };
        if (args[0] === "--version") {
          end("codex-cli 0.162.1");
          return;
        }
        if (args[0] === "exec" && args[1] === "--help") {
          end(options.help ?? HELP);
          return;
        }
        if (args[0] === "login" && args[1] === "--help") {
          end("Commands: status Show login status");
          return;
        }
        if (args[0] === "login") {
          end(
            options.loggedIn === false
              ? "Not logged in"
              : "Logged in using ChatGPT",
            options.loggedIn === false ? 1 : 0,
          );
          return;
        }
        const scenario = options.scenario ?? "success";
        if (scenario === "timeout") return;
        if (scenario === "auth") {
          end("", 1, "401 login token expired");
          return;
        }
        if (scenario === "quota") {
          end("", 1, "429 quota exceeded");
          return;
        }
        if (scenario === "nonzero") {
          end("", 9, "network unreachable");
          return;
        }
        if (scenario === "event-error") {
          end(
            JSON.stringify({
              type: "turn.failed",
              error: { message: "quota exhausted" },
            }) + "\n",
          );
          return;
        }
        if (scenario === "tool") {
          end(
            JSON.stringify({
              type: "item.started",
              item: {
                type: "file_change",
                changes: [{ path: "db.sqlite", kind: "update" }],
              },
            }) + "\n",
          );
          return;
        }
        if (scenario === "bad-stream") {
          end("not json\n");
          return;
        }
        const wire = {
          ...proposal,
          actions: proposal.actions.map((a) => ({
            ...a,
            target_id: null,
            expected_version: null,
            patch: Object.entries(a.patch).map(([key, value]) => ({
              key,
              value,
            })),
          })),
        };
        const raw =
          scenario === "bad-json"
            ? "```json\n{}\n```"
            : JSON.stringify(
                scenario === "wire"
                  ? wire
                  : scenario === "clarify"
                    ? {
                        ...proposal,
                        summary: "Which list should I use?",
                        actions: [],
                      }
                    : proposal,
              );
        const outputIndex = args.indexOf("--output-last-message");
        if (outputIndex !== -1)
          writeFileSync(args[outputIndex + 1], scenario === "empty" ? "" : raw);
        const stream =
          JSON.stringify({ type: "turn.started" }) +
          "\n" +
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: scenario === "empty" ? "" : raw,
            },
          }) +
          "\n" +
          JSON.stringify({ type: "turn.completed" }) +
          "\n";
        if (scenario === "fragments") {
          const bytes = Buffer.from(stream);
          // One byte at a time exercises UTF-8 code points across stream chunks.
          for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
          child.emit("close", 0);
        } else end(stream);
      });
    });
    return child as ChildProcessWithoutNullStreams;
  };
  const adapter = new CodexAdapter({
    spawn,
    resolveExecutable: async () => "/some path/codex",
    resourceDir: join(process.cwd(), "resources"),
    timeoutMs: options.timeoutMs ?? 200,
  });
  return { adapter, calls };
}
async function ready(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  expect((await h.adapter.probe()).available).toBe(true);
  return h;
}

describe("Codex adapter capability probing and process boundary", () => {
  it("keeps manual mode possible when Codex is absent", async () => {
    const adapter = new CodexAdapter({ resolveExecutable: async () => null });
    expect(await adapter.probe()).toMatchObject({
      available: false,
      loggedIn: false,
    });
    await expect(adapter.run("task", {})).rejects.toThrow(/install|安装/i);
  });
  it("reports unavailable when login is missing without reading credentials", async () => {
    const { adapter, calls } = harness({ loggedIn: false });
    expect(await adapter.probe()).toMatchObject({
      available: false,
      loggedIn: false,
    });
    await expect(adapter.run("task", {})).rejects.toThrow(/login/i);
    expect(calls.map((c) => c.args)).toEqual([
      ["--version"],
      ["exec", "--help"],
      ["login", "--help"],
      ["login", "status"],
    ]);
  });
  it("does not claim isolation or use flags absent from help", async () => {
    const { adapter } = harness({ help: "--json --output-schema" });
    const caps = await adapter.probe();
    expect(caps.available).toBe(false);
    expect(caps.ignoreUserConfig).toBe(false);
    expect(caps.readOnly).toBe(false);
    expect(caps.isolation).toContain("No forced");
  });
  it("uses argv shell:false, stdin intent, bounded context and separate final file", async () => {
    const { adapter, calls } = await ready();
    const intent = "$(touch /tmp/never); `rm x` 交周报";
    const result = await adapter.run(intent, {
      timeZone: "Europe/Paris",
      today: "2026-11-14",
      lists: [{ id: "work", name: "Work" }],
      tasks: Array.from({ length: 120 }, (_, i) => ({
        id: String(i),
        title: "Task",
        version: 1,
        secret: "should-not-send",
      })),
      databasePath: "/secret/db",
      token: "secret",
    });
    expect(result.proposal.actions[0].patch).toMatchObject({ title: "交周报" });
    const call = calls.at(-1)!;
    expect(call.options.shell).toBe(false);
    expect(call.args).not.toContain(intent);
    expect(call.input).toContain(intent);
    expect(call.options.cwd).toContain("telldo-codex-");
    expect(call.args).toContain("--ignore-user-config");
    expect(call.args).toContain("--ignore-rules");
    expect(call.args).toContain("--output-schema");
    expect(call.args.at(-1)).toBe("-");
    expect(call.input).not.toContain("should-not-send");
    expect(call.input).not.toContain("/secret/db");
    expect(call.input).not.toContain('"id":"100"');
  });
  it("normalizes strict wire patches before returning a proposal", async () => {
    const { adapter } = await ready({ scenario: "wire" });
    expect((await adapter.run("task", {})).proposal.actions[0].patch).toEqual({
      title: "交周报",
      list_id: "work",
    });
  });
  it("returns clarification without an applicable proposal", async () => {
    const { adapter } = await ready({ scenario: "clarify" });
    const result = await adapter.run("task", {});
    expect(result.proposal.actions).toEqual([]);
    expect(result.proposal.summary).toBe("Which list should I use?");
  });
  it("falls back without schema and output-file flags, preserving fragmented UTF-8", async () => {
    const { adapter, calls } = await ready({
      help: "--json --sandbox read-only --skip-git-repo-check",
      scenario: "fragments",
    });
    expect(
      (await adapter.run("交周报", {})).proposal.actions[0].patch,
    ).toMatchObject({ title: "交周报" });
    expect(calls.at(-1)!.args).not.toContain("--output-schema");
    expect(calls.at(-1)!.args).not.toContain("--output-last-message");
  });
  it.each([
    "auth",
    "quota",
    "bad-json",
    "bad-stream",
    "empty",
    "nonzero",
    "event-error",
  ] as const)(
    "rejects %s without returning an applicable proposal",
    async (scenario) => {
      const { adapter } = await ready({ scenario });
      await expect(adapter.run("task", {})).rejects.toThrow();
    },
  );
  it("rejects file-writing events and kills the subprocess", async () => {
    const { adapter, calls } = await ready({ scenario: "tool" });
    await expect(adapter.run("task", {})).rejects.toThrow(/tool call/);
    expect(calls.at(-1)!.killed).toBe(true);
  });
  it.each([
    "command_execution",
    "mcp_tool_call",
    "web_search",
    "file_change",
    "function_call",
    "custom_tool_call",
  ])("recognizes forbidden %s events", (type) => {
    expect(isToolEvent({ type: "item.started", item: { type } })).toBe(true);
  });
  it("times out and kills subprocess", async () => {
    const { adapter, calls } = await ready({
      scenario: "timeout",
      timeoutMs: 15,
    });
    await expect(adapter.run("task", {})).rejects.toThrow(/timed out/);
    expect(calls.at(-1)!.killed).toBe(true);
  });
  it("supports cancellation and refuses overlapping requests", async () => {
    const { adapter, calls } = await ready({ scenario: "timeout" });
    const pending = adapter.run("task", {});
    const rejection = expect(pending).rejects.toThrow(/Cancelled/);
    await expect(adapter.run("second", {})).rejects.toThrow(/already running/);
    for (let i = 0; i < 100 && !calls.some((c) => c.args.at(-1) === "-"); i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    adapter.cancel();
    await rejection;
    expect(calls.at(-1)!.killed).toBe(true);
  });
});
