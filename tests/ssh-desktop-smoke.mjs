import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const executablePath = process.env.TELLDO_EXECUTABLE;
if (!executablePath)
  throw Error("Set TELLDO_EXECUTABLE to the packaged desktop executable");
const dir = await mkdtemp(join(tmpdir(), "telldo-ssh-desktop-"));
const application = await electron.launch({
  executablePath,
  args: process.platform === "linux" ? ["--no-sandbox"] : [],
  env: {
    ...process.env,
    TELLDO_TEST_DATA: dir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
});
try {
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector(".app-shell");
  const invoke = (method, ...args) =>
    page.evaluate(({ method, args }) => window.telldo.invoke(method, ...args), {
      method,
      args,
    });
  await page.waitForFunction(
    async () => !!(await window.telldo.invoke("snapshot")).capabilities,
  );
  await invoke("settings", {
    language: "zh",
    aiTransport: "ssh",
    sshHost: "198.51.100.10",
    sshUser: "developer",
    sshPort: 2222,
    sshCodexPath: "/home/developer/.local/bin/codex",
    sshRunnerPath:
      "/opt/telldo/resources/ssh-codex-runner.py",
    sshProxyUrl: "http://192.0.2.10:3128",
    timeZone: "Asia/Shanghai",
  });
  let snapshot = await invoke("snapshot");
  assert.equal(
    snapshot.capabilities.available,
    true,
    snapshot.capabilities.reason,
  );
  assert.equal(snapshot.settings.aiTransport, "ssh");
  const list = snapshot.lists[0];
  const manual = await invoke("createTask", {
    title: "SSH acceptance manual control",
    list_id: list.id,
  });
  const start = Date.now();
  const proposalId = await invoke("ask", "明天下午交周报", list.id);
  snapshot = await invoke("snapshot");
  const created = snapshot.tasks.find((t) => t.id !== manual.id);
  assert.ok(created, "AI must create a task via Mac TaskService");
  assert.equal(created.due_kind, "datetime");
  assert.equal(created.time_zone, "Asia/Shanghai");
  assert.match(created.title, /周报/);
  assert.equal(
    snapshot.proposals.find((p) => p.id === proposalId).status,
    "applied",
  );
  await page.reload();
  await page.waitForSelector(".app-shell");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/telldo-mac-ssh.png" });
  await invoke("undoProposal", proposalId);
  snapshot = await invoke("snapshot");
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].id, manual.id);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        platform: process.platform,
        arch: process.arch,
        transport: "ssh",
        version: snapshot.capabilities.version,
        elapsedMs: Date.now() - start,
        manualPreserved: true,
        autoCreateAndUndo: true,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await application.close();
  await rm(dir, { recursive: true, force: true });
}
