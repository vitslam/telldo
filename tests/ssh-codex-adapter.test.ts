import type { AIProgress } from "../src/shared/ai-progress";
import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  SshCodexAdapter,
  validateSshSettings,
  type SshCodexSettings,
} from "../src/main/ssh-codex-adapter";
import type { SpawnProcess } from "../src/main/codex-adapter";

const settings: SshCodexSettings = {
  host: "198.51.100.10",
  user: "developer",
  port: 2222,
  codexPath: "/home/developer/.local/bin/codex",
  runnerPath: "/opt/telldo/resources/ssh-codex-runner.py",
  proxyUrl: "http://192.0.2.10:3128",
};
const caps = {
  available: true,
  imageInput: true,
  version: "codex-cli 0.162.1",
  path: settings.codexPath,
  loggedIn: true,
  reason: "",
  schema: true,
  outputFile: true,
  json: true,
  readOnly: true,
  ignoreUserConfig: true,
  ignoreRules: true,
  ephemeral: true,
  skipGitCheck: true,
  isolation: "No forced tool isolation guarantee.",
};
const proposal = {
  version: 1,
  summary: "添加交周报",
  idempotency_key: "ssh-synthetic-test-1",
  risk: "low",
  actions: [
    {
      type: "create",
      target_id: null,
      temp_id: "new1",
      expected_version: null,
      patch: [
        { key: "title", value: "交周报" },
        { key: "list_id", value: "work" },
      ],
    },
  ],
};
type Scenario =
  | "success"
  | "fragmented"
  | "timeout"
  | "auth"
  | "host-key"
  | "missing-runner"
  | "invalid-progress"
  | "protocol"
  | "nonzero-after-result"
  | "late-error"
  | "duplicate"
  | "bad-json"
  | "bad-schema"
  | "tool-error"
  | "empty"
  | "ssh-missing"
  | "bad-capability"
  | "probe-timeout"
  | "clarification";
function harness(
  scenario: Scenario = "success",
  override: Partial<SshCodexSettings> = {},
) {
  const calls: Array<{
    file: string;
    args: string[];
    options: Record<string, unknown>;
    input: string;
    eof: boolean;
    killed: boolean;
    request?: any;
  }> = [];
  const spawn: SpawnProcess = (file, args, options) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call = {
      file,
      args,
      options,
      input: "",
      eof: false,
      killed: false,
      request: undefined as any,
    };
    calls.push(call);
    child.kill = () => {
      call.killed = true;
      child.emit("close", null);
      return true;
    };
    child.stdin.on("finish", () => {
      call.eof = true;
      child.emit("close", 255);
    });
    child.stdin.on("data", (chunk: Buffer) => {
      call.input += chunk.toString();
      if (call.request || !call.input.includes("\n")) return;
      call.request = JSON.parse(call.input.split("\n")[0]);
      queueMicrotask(() => {
        const frame = (value: unknown) => {
          const text = JSON.stringify(value) + "\n";
          if (scenario === "fragmented") {
            for (const byte of Buffer.from(text))
              child.stdout.write(Buffer.from([byte]));
          } else child.stdout.write(text);
        };
        const close = (code = 0) => child.emit("close", code);
        if (scenario === "ssh-missing") {
          child.emit("error", new Error("spawn ssh ENOENT"));
          return;
        }
        if (scenario === "auth") {
          child.stderr.write("Permission denied (publickey).");
          close(255);
          return;
        }
        if (scenario === "host-key") {
          child.stderr.write("Host key verification failed.");
          close(255);
          return;
        }
        if (scenario === "missing-runner") {
          child.stderr.write(
            "python3: can't open file runner.py: No such file",
          );
          close(2);
          return;
        }
        if (call.request.mode === "probe") {
          if (scenario === "probe-timeout") return;
          frame({
            type: "capability",
            capabilities:
              scenario === "bad-capability" ? { ...caps, json: false } : caps,
          });
          close();
          return;
        }
        if (scenario === "timeout") return;
        if (scenario === "protocol") {
          child.stdout.write("login banner that breaks protocol\n");
          return;
        }
        if (scenario === "invalid-progress") {
          frame({
            type: "progress",
            event: { type: "reasoning", text: "hidden" },
          });
          return;
        }
        if (scenario === "empty") {
          close();
          return;
        }
        if (scenario === "tool-error") {
          frame({
            type: "error",
            message: "Remote Codex attempted a tool call.",
            code: "tool_call",
          });
          close(1);
          return;
        }
        frame({ type: "progress", message: "整理任务…" });
        frame({
          type: "progress",
          event: {
            type: "activity",
            id: "model",
            phase: "model",
            status: "running",
            label: "处理请求",
          },
        });
        frame({
          type: "progress",
          event: { type: "response", text: "Add report" },
        });
        const raw =
          scenario === "bad-json"
            ? "```json\n{}\n```"
            : JSON.stringify(
                scenario === "bad-schema"
                  ? {
                      ...proposal,
                      actions: [
                        { type: "complete", target_id: "existing", patch: {} },
                      ],
                    }
                  : scenario === "clarification"
                    ? { ...proposal, summary: "请说明目标清单", actions: [] }
                    : proposal,
              );
        frame({ type: "proposal", raw });
        if (scenario === "late-error")
          frame({ type: "error", message: "late remote failure" });
        if (scenario === "duplicate") frame({ type: "proposal", raw });
        close(scenario === "nonzero-after-result" ? 255 : 0);
      });
    });
    return child as ChildProcessWithoutNullStreams;
  };
  const adapter = new SshCodexAdapter(
    { ...settings, ...override },
    {
      spawn,
      resourceDir: join(process.cwd(), "resources"),
      timeoutMs: 25,
      probeTimeoutMs: 25,
      transportGraceMs: 0,
      cancelGraceMs: 5,
    },
  );
  return { adapter, calls };
}
async function ready(scenario: Scenario = "success") {
  const h = harness(scenario);
  expect((await h.adapter.probe()).available).toBe(true);
  return h;
}

describe("SSH transport boundary", () => {
  it("sends the full supported tag set without shortening tag names", async () => {
    const { adapter, calls } = await ready();
    const tags = Array.from({ length: 30 }, (_, i) => `${i}-` + "长标签".repeat(20));
    await adapter.run("查看任务标签", { tasks: [{ id: "tagged", title: "Tagged", tags }] });
    expect(calls.at(-1)!.request.prompt).toContain(JSON.stringify(tags));
  });
  it("uses fixed remote invocation, strict host checking and stdin-only intent/context", async () => {
    const { adapter, calls } = await ready();
    const intent = "$(touch /tmp/never); `uname` 明天下午交周报";
    const result = await adapter.run(intent, {
      today: "2026-11-14",
      timeZone: "Asia/Shanghai",
      lists: [{ id: "work", name: "工作" }],
      tasks: Array.from({ length: 120 }, (_, i) => ({
        id: String(i),
        title: "Task",
        version: 1,
        secret: "no-send",
      })),
      databasePath: "/private/tasks.db",
      credential: "no-send",
    });
    expect(result.proposal.actions[0].patch).toMatchObject({ title: "交周报" });
    const call = calls.at(-1)!;
    expect(call.file).toBe("ssh");
    expect(call.options.shell).toBe(false);
    expect(call.args.slice(-3)).toEqual(["python3", "-I", settings.runnerPath]);
    expect(call.args).toContain("StrictHostKeyChecking=yes");
    expect(call.args).toContain("BatchMode=yes");
    expect(call.args).toContain("ForwardAgent=no");
    expect(call.args).not.toContain(intent);
    expect(call.args.join(" ")).not.toContain(settings.proxyUrl);
    expect(call.request.prompt).toContain(intent);
    expect(call.request.proxyUrl).toBe(settings.proxyUrl);
    expect(call.request.prompt).not.toContain("no-send");
    expect(call.request.prompt).not.toContain("/private/tasks.db");
    expect(call.request.prompt).not.toContain('"id":"100"');
    expect(call.eof).toBe(false); // Do not cancel the helper immediately after sending the request.
    expect(call.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(call.options.env).not.toHaveProperty("CODEX_HOME");
  });
  it("handles fragmented UTF-8 framed output", async () => {
    const { adapter } = await ready("fragmented");
    const messages: AIProgress[] = [];
    expect(
      (await adapter.run("task", {}, (m) => messages.push(m))).proposal.summary,
    ).toBe("添加交周报");
    expect(messages).toContain("整理任务…");
    expect(messages).toContainEqual({
      type: "activity",
      id: "model",
      phase: "model",
      status: "running",
      label: "处理请求",
    });
    expect(messages).toContainEqual({ type: "response", text: "Add report" });
    expect(messages).toContainEqual({ type: "response", text: "添加交周报" });
    expect(messages.at(-1)).toMatchObject({
      phase: "validation",
      status: "completed",
    });
  });
  it.each([
    "auth",
    "host-key",
    "missing-runner",
    "ssh-missing",
    "bad-capability",
    "probe-timeout",
  ] as const)("keeps manual mode available for %s", async (scenario) => {
    const { adapter } = harness(scenario);
    const result = await adapter.probe();
    expect(result.available).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
    await expect(adapter.run("task", {})).rejects.toThrow();
  });
  it.each([
    "protocol",
    "invalid-progress",
    "nonzero-after-result",
    "late-error",
    "duplicate",
    "bad-json",
    "bad-schema",
    "tool-error",
    "empty",
  ] as const)(
    "rejects %s before returning an applicable proposal",
    async (scenario) => {
      const { adapter } = await ready(scenario);
      await expect(adapter.run("task", {})).rejects.toThrow();
    },
  );
  it("returns a read-only clarification as a successful response", async () => {
    const { adapter } = await ready("clarification");
    const result = await adapter.run("task", {});
    expect(result.proposal.actions).toEqual([]);
    expect(result.proposal.summary).toBe("请说明目标清单");
  });
  it("cancels by sending EOF to the remote helper, and rejects overlaps", async () => {
    const { adapter, calls } = await ready("timeout");
    const pending = adapter.run("task", {});
    const rejection = expect(pending).rejects.toThrow(/Cancelled/);
    await expect(adapter.run("overlap", {})).rejects.toThrow(/already running/);
    for (let i = 0; i < 50 && calls.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    adapter.cancel();
    await rejection;
    expect(calls.at(-1)!.eof).toBe(true);
  });
  it("times out even when no remote response arrives", async () => {
    const { adapter, calls } = await ready("timeout");
    await expect(adapter.run("task", {})).rejects.toThrow(/timed out/);
    expect(calls.at(-1)!.eof).toBe(true);
  });
  it.each([
    { host: "host; touch /tmp/no" },
    { host: "-oProxyCommand=x" },
    { user: "user$(id)" },
    { port: 0 },
    { port: 65536 },
    { runnerPath: "/tmp/runner.py;id" },
    { runnerPath: "/tmp/a b.py" },
    { runnerPath: "relative.py" },
    { codexPath: "~/bin/codex" },
    { proxyUrl: "http://user:secret@example.com:3128" },
    { proxyUrl: "file:///tmp/proxy" },
    { proxyUrl: "http://host/path" },
  ])(
    "rejects unsafe connection setting %j before spawning",
    async (override) => {
      expect(() => validateSshSettings({ ...settings, ...override })).toThrow();
      const { adapter, calls } = harness("success", override);
      expect((await adapter.probe()).available).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );
});

describe("SSH actual image input", () => {
  it("sends bounded image bytes outside the prompt, preserving the attachment identifier", async () => {
    const { adapter, calls } = harness();
    await adapter.probe();
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBx8AAAAASUVORK5CYII=",
      "base64",
    );
    await adapter.run("Read image", {}, () => {}, [
      {
        id: "asset-image",
        name: "photo.png",
        mime: "image/png",
        kind: "image",
        bytes,
      },
    ]);
    const request = calls.find((call) => call.request?.mode === "run")!.request;
    expect(Buffer.from(request.images[0].base64, "base64")).toEqual(bytes);
    expect(request.images[0]).toMatchObject({
      id: "asset-image",
      mime: "image/png",
    });
    expect(request.prompt).toContain('"status":"image"');
    expect(request.prompt).not.toContain(bytes.toString("base64"));
  });
});
