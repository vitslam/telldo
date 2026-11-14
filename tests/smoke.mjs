import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "telldo-smoke-"));
const application = await electron.launch({
  ...(process.env.TELLDO_EXECUTABLE
    ? { executablePath: process.env.TELLDO_EXECUTABLE }
    : {}),
  args: [
    ...(process.env.TELLDO_EXECUTABLE ? [] : ["out/main/index.js"]),
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ],
  env: {
    ...process.env,
    TELLDO_TEST_DATA: dir,
    PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin",
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
  await invoke("settings", { language: "en", timeZone: "Asia/Shanghai" });
  await page.reload();
  await page.waitForSelector(".app-shell");
  await page.waitForFunction(
    () => document.querySelector(".ai-bar input")?.disabled,
  );
  const initial = await invoke("snapshot");
  assert.equal(initial.tasks.length, 0);
  assert.equal(initial.capabilities.available, false);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/telldo-empty.png" });
  await page.getByLabel("New task", { exact: true }).fill("明天下午交周报");
  await page.getByLabel("New task", { exact: true }).press("Enter");
  await page.waitForFunction(
    () => document.querySelector('[aria-label="New task"]').value === "",
  );
  let snapshot = await invoke("snapshot");
  assert.equal(snapshot.tasks.length, 1);
  const task = snapshot.tasks[0];
  assert.equal(task.title, "交周报");
  assert.equal(task.due_kind, "datetime");
  assert.equal(task.time_zone, "Asia/Shanghai");
  await page.locator("nav .nav-item").nth(1).click();
  await page.locator(".task-body").first().click();
  await page
    .getByPlaceholder("Add a little context…")
    .fill("Quarterly finance review");
  await page.getByPlaceholder("Comma separated").fill("work, report");
  await page.getByText("Save changes", { exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".toast")?.textContent.includes("Saved"),
  );
  await page
    .getByPlaceholder("Add subtask", { exact: true })
    .fill("Check the numbers");
  await page.getByPlaceholder("Add subtask", { exact: true }).press("Enter");
  await page.waitForSelector(".subtask");
  snapshot = await invoke("snapshot");
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(
    snapshot.tasks.find((t) => t.id === task.id).notes,
    "Quarterly finance review",
  );
  await page.getByPlaceholder("Search tasks, notes, tags…").fill("numbers");
  await page.waitForFunction(() =>
    document
      .querySelector(".task-title")
      ?.textContent.includes("Check the numbers"),
  );
  assert.equal(await page.locator(".task-row").count(), 1);
  await page.getByPlaceholder("Search tasks, notes, tags…").fill("finance");
  await page.waitForSelector(".task-row");
  assert.equal(await page.locator(".task-row").count(), 1);
  await page.getByPlaceholder("Search tasks, notes, tags…").fill("");
  await page.locator(".task-row .check-button").first().click();
  snapshot = await invoke("snapshot");
  assert.equal(snapshot.tasks.find((t) => t.id === task.id).status, "done");
  await page.getByText("Show completed", { exact: true }).click();
  await page.waitForSelector(".task-row.completed");
  await page.locator(".task-row .check-button").first().click();
  await page.getByRole("button", { name: "Close details" }).click();
  await page
    .getByRole("button", { name: "New list", exact: true })
    .last()
    .click();
  await page.locator(".dialog input").fill("Studio");
  await page
    .locator(".dialog")
    .getByText("Save changes", { exact: true })
    .click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".list-nav button")].some((e) =>
      e.textContent.includes("Studio"),
    ),
  );
  await page.screenshot({
    path: "artifacts/telldo-manual.png",
    fullPage: true,
  });
  await invoke("settings", { language: "zh" });
  await invoke("createTask", {
    title: "梳理 Telldo 第一版验收清单",
    list_id: initial.lists[0].id,
    planned_date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    priority: "high",
    tags: ["Telldo", "产品"],
    notes: "让手动操作保持简单，让每一次 AI 修改都可验证。",
  });
  await invoke("createTask", {
    title: "读完桌上的那本书",
    list_id: initial.lists[1].id,
    planned_date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    priority: "low",
    tags: ["阅读"],
  });
  await page.reload();
  await page.waitForSelector(".task-row");
  await page.locator(".task-body").first().click();
  await page.waitForSelector(".detail");
  await page.screenshot({
    path: "artifacts/telldo-preview.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Electron manual flow without Codex, Chinese date, notes, tags, subtask, search, completion, list creation; no renderer errors.",
  );
} finally {
  await application.close();
  await rm(dir, { recursive: true, force: true });
}
