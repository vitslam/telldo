import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "telldo-calendar-"));
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
    PATH: "/usr/bin:/bin",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
});
try {
  const page = await application.firstWindow(),
    errors = [];
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
  await invoke("settings", { language: "en", timeZone: "Asia/Shanghai" });
  let data = await invoke("snapshot");
  const [work, life] = data.lists;
  const create = (patch) =>
    invoke("createTask", { list_id: work.id, ...patch });
  const planned = await create({
    title: "Release notes",
    planned_date: "2031-02-10",
    due_kind: "date",
    due_date: "2031-02-15",
  });
  const timed = await create({
    title: "Submit report",
    due_kind: "datetime",
    due_date: "2031-02-14",
    due_at: "2031-02-14T07:00:00.000Z",
    time_zone: "Asia/Shanghai",
    reminder_at: "2031-02-14T06:00:00.000Z",
  });
  const cross = await create({
    title: "Annual budget",
    planned_date: "2031-01-30",
    due_kind: "date",
    due_date: "2031-02-25",
  });
  const pending = await create({ title: "Unscheduled idea" });
  await create({
    title: "Archived checklist",
    status: "done",
    due_kind: "date",
    due_date: "2031-02-11",
  });
  const template = await create({
    title: "Read ten pages",
    list_id: life.id,
    due_kind: "date",
    due_date: "2031-02-01",
  });
  const series = await invoke("setRecurrence", template.id, {
    rrule: "FREQ=DAILY",
    dtstart: "2031-02-01",
    tzid: "Asia/Shanghai",
    count: 28,
    until: null,
    exdates: [],
  });
  const range = {
    start: "2031-02-01",
    end: "2031-03-01",
    zone: "Asia/Shanghai",
  };
  const snapshot = () => invoke("snapshot", range);
  const waitTask = (id, field, value) =>
    page.waitForFunction(
      async ({ id, field, value, range }) =>
        (await window.telldo.invoke("snapshot", range)).tasks.find(
          (t) => t.id === id,
        )?.[field] === value,
      { id, field, value, range },
    );
  await page.reload();
  await page.waitForSelector(".app-shell");
  await page.locator("nav .nav-item").nth(1).click();
  await page.locator('input[type="month"]').fill("2031-02");
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="calendar-count"]')
      ?.textContent.includes("31"),
  );
  const listIds = (
    await page
      .locator(".calendar-list [data-row-id]")
      .evaluateAll((es) => es.map((e) => e.dataset.rowId))
  ).sort();
  await page.getByRole("button", { name: "Month view", exact: true }).click();
  const monthIds = [
    ...new Set(
      await page
        .locator(".calendar-grid [data-row-id]")
        .evaluateAll((es) => es.map((e) => e.dataset.rowId)),
    ),
  ].sort();
  assert.deepEqual(
    monthIds,
    listIds,
    "List and calendar must show the same unique entities",
  );
  assert.equal(
    await page
      .locator(
        `.calendar-day[data-date="2031-02-25"] .deadline[data-task-id="${cross.id}"]`,
      )
      .count(),
    1,
  );
  const card = (id) =>
    page
      .locator(
        `.calendar-grid .calendar-card[data-task-id="${id}"][draggable="true"]:not(.deadline)`,
      )
      .first();
  const cell = (date) => page.locator(`.calendar-day[data-date="${date}"]`);
  async function drag(source, target) {
    // Scroll before holding the mouse; avoid Playwright scrolling mid-gesture.
    await target.scrollIntoViewIfNeeded();
    await source.hover();
    const from = await source.boundingBox(),
      to = await target.boundingBox();
    await page.mouse.down();
    await page.mouse.move(
      from.x + from.width / 2 + 8,
      from.y + from.height / 2,
      { steps: 4 },
    );
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 12,
    });
    await page.mouse.move(to.x + to.width / 2 + 1, to.y + to.height / 2 + 1);
    await page.mouse.up();
  }
  const undo = async () => {
    await page
      .locator(".planned-view .undo-bar")
      .getByRole("button", { name: "Undo", exact: true })
      .click();
  };
  await drag(card(planned.id), cell("2031-02-12"));
  await waitTask(planned.id, "planned_date", "2031-02-12");
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === planned.id).due_date,
    "2031-02-15",
  );
  await undo();
  await waitTask(planned.id, "planned_date", "2031-02-10");
  // Dragging a due time with a reminder requires an explicit reminder decision.
  await drag(card(timed.id), cell("2031-02-18"));
  const dialog = page.getByRole("dialog", { name: "Review date change" });
  await dialog.waitFor();
  assert.equal(
    await dialog.getByRole("button", { name: "Save dates" }).isDisabled(),
    true,
  );
  await dialog.getByLabel("Reminder behavior").selectOption("keep");
  await dialog.getByRole("button", { name: "Save dates" }).click();
  await waitTask(timed.id, "due_date", "2031-02-18");
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === timed.id).reminder_at,
    "2031-02-14T06:00:00.000Z",
  );
  await undo();
  await waitTask(timed.id, "due_date", "2031-02-14");
  await drag(card(timed.id), cell("2031-02-18"));
  await dialog.getByLabel("Reminder behavior").selectOption("follow");
  await dialog.getByRole("button", { name: "Save dates" }).click();
  await waitTask(timed.id, "due_date", "2031-02-18");
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === timed.id).reminder_at,
    "2031-02-18T06:00:00.000Z",
  );
  // Undo remains available after a renderer reload.
  await page.reload();
  await page.waitForSelector(".app-shell");
  await page.locator("nav .nav-item").nth(1).click();
  await page.locator('input[type="month"]').fill("2031-02");
  await undo();
  await waitTask(timed.id, "due_date", "2031-02-14");
  await page.getByRole("button", { name: /^Unscheduled / }).click();
  await drag(
    page.locator(
      `.calendar-unscheduled [data-task-id="${pending.id}"][draggable="true"]`,
    ),
    cell("2031-02-20"),
  );
  await waitTask(pending.id, "planned_date", "2031-02-20");
  assert.equal(
    (await snapshot()).tasks.find((t) => t.id === pending.id).due_kind,
    "none",
  );
  await undo();
  await waitTask(pending.id, "planned_date", null);
  await drag(
    page.locator(
      '.calendar-grid [data-occurrence-key="2031-02-14"][draggable="true"]',
    ),
    cell("2031-02-16"),
  );
  await page.waitForFunction(
    async ({ series, range }) =>
      (await window.telldo.invoke("snapshot", range)).occurrences.find(
        (o) => o.series_id === series.id && o.occurrence_key === "2031-02-14",
      )?.override_date === "2031-02-16",
    { series, range },
  );
  data = await snapshot();
  assert.equal(
    data.occurrences.find(
      (o) => o.series_id === series.id && o.occurrence_key === "2031-02-15",
    ).override_date,
    null,
  );
  await undo();
  await page
    .getByRole("button", { name: "Schedule task on 2031-02-22", exact: true })
    .click();
  await page
    .getByLabel("Task title", { exact: true })
    .fill("Created from date cell");
  await page
    .getByRole("button", { name: "Schedule on this day", exact: true })
    .click();
  await page.waitForFunction(
    async (range) =>
      (await window.telldo.invoke("snapshot", range)).tasks.some(
        (t) =>
          t.title === "Created from date cell" &&
          t.planned_date === "2031-02-22" &&
          t.due_kind === "none",
      ),
    range,
  );
  await page.getByLabel("Filter list", { exact: true }).selectOption(work.id);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="calendar-count"]')
      ?.textContent.includes("4"),
  );
  await page.locator('.calendar-filters input[type="checkbox"]').check();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="calendar-count"]')
      ?.textContent.includes("5"),
  );
  await page.locator('.calendar-filters input[type="checkbox"]').uncheck();
  await page.getByLabel("Filter list", { exact: true }).selectOption("");
  await page.getByRole("button", { name: "Next month", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="calendar-count"]')
        ?.textContent.trim() === "0 tasks",
  );
  await page
    .getByRole("button", { name: "Previous month", exact: true })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="calendar-count"]')
      ?.textContent.includes("32"),
  );
  const closeDay = page.getByRole("button", { name: "Close day", exact: true });
  if (await closeDay.count()) await closeDay.click();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/telldo-calendar.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      platform: process.platform,
      arch: process.arch,
      checks: [
        "shared list/month entities",
        "cross-month deadline",
        "planned drag preserves due",
        "reminder keep/follow preview",
        "durable undo",
        "unscheduled drag",
        "single recurrence move",
        "date-cell creation",
        "filters/completed",
        "month navigation",
      ],
      rendererErrors: errors,
    }),
  );
} catch (error) {
  const page = await application.firstWindow();
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/telldo-calendar-failure.png",
    fullPage: true,
  });
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await application.close();
  await rm(dir, { recursive: true, force: true });
}
