import { z } from "zod";
import { DateTime, IANAZone } from "luxon";
import type { AIResponse, ProposalInput, TaskPatch } from "./types";
import { splitRecurringTask } from "./recurrence";
import { contextQuerySchema } from "./context-query";

export const MAX_ACTIONS = 50;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => DateTime.fromISO(v).isValid, "Invalid calendar date");
const instant = z
  .string()
  .refine(
    (v) => /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && DateTime.fromISO(v).isValid,
    "Timestamp must include a UTC offset",
  )
  .transform((v) => DateTime.fromISO(v).toUTC().toISO()!);
export const taskPatchSchema = z
  .object({
    list_id: z.string().min(1).max(200).optional(),
    parent_id: z.string().min(1).max(200).nullable().optional(),
    title: z.string().trim().min(1).max(500).optional(),
    notes: z.string().max(20000).optional(),
    status: z.enum(["todo", "done"]).optional(),
    priority: z.enum(["none", "low", "medium", "high"]).optional(),
    due_kind: z.enum(["none", "date", "datetime"]).optional(),
    due_date: day.nullable().optional(),
    due_at: instant.nullable().optional(),
    time_zone: z
      .string()
      .refine((v) => IANAZone.isValidZone(v), "Invalid IANA time zone")
      .nullable()
      .optional(),
    planned_date: day.nullable().optional(),
    reminder_at: instant.nullable().optional(),
    sort_order: z.number().finite().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  })
  .strict();
export function parseTaskPatch(value: unknown): TaskPatch {
  return taskPatchSchema.parse(value);
}
const taskActionSchema = z
  .object({
    type: z.enum([
      "create",
      "update",
      "complete",
      "uncomplete",
      "reschedule",
      "delete",
      "add_subtask",
      "set_tags",
    ]),
    target_id: z.string().min(1).max(200).optional(),
    temp_id: z.string().min(1).max(200).optional(),
    expected_version: z.number().int().positive().optional(),
    patch: taskPatchSchema,
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.type === "create") {
      if (!a.patch.title || !a.patch.list_id)
        ctx.addIssue({
          code: "custom",
          message: "Create requires title and list_id",
        });
      if (a.target_id)
        ctx.addIssue({
          code: "custom",
          message: "Create cannot target an existing task",
        });
    } else if (!a.target_id || !a.expected_version)
      ctx.addIssue({
        code: "custom",
        message: "Updates require target_id and expected_version",
      });
    if (a.type === "add_subtask" && !a.patch.title)
      ctx.addIssue({ code: "custom", message: "Subtask requires title" });
    const allowed: Record<string, string[]> = {
      complete: [],
      uncomplete: [],
      delete: [],
      reschedule: [
        "due_kind",
        "due_date",
        "due_at",
        "time_zone",
        "planned_date",
        "reminder_at",
      ],
      set_tags: ["tags"],
    };
    if (
      allowed[a.type] &&
      Object.keys(a.patch).some((k) => !allowed[a.type].includes(k))
    )
      ctx.addIssue({
        code: "custom",
        message: "Patch contains fields outside action scope",
      });
    if (a.type === "set_tags" && !a.patch.tags)
      ctx.addIssue({ code: "custom", message: "set_tags requires tags" });
    if (a.type === "reschedule" && !Object.keys(a.patch).length)
      ctx.addIssue({ code: "custom", message: "Reschedule patch is empty" });
  });
const createListActionSchema = z
  .object({
    type: z.literal("create_list"),
    temp_id: z.string().min(1).max(200),
    patch: z
      .object({
        name: z.string().trim().min(1).max(200),
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i, "Invalid list color")
          .optional(),
      })
      .strict(),
  })
  .strict();
const recurringPatchSchema = taskPatchSchema
  .extend({
    title: z.string().trim().min(1).max(500),
    list_id: z.string().min(1).max(200),
    parent_id: z.null().optional(),
    status: z.literal("todo").optional(),
    due_kind: z.enum(["date", "datetime"]),
    due_date: day,
    rrule: z.string().min(1).max(200),
    dtstart: z.string().min(1).max(80),
    tzid: z
      .string()
      .refine((v) => IANAZone.isValidZone(v), "Invalid IANA time zone"),
    until: day.nullable().optional(),
    count: z.number().int().min(1).max(10000).nullable().optional(),
  })
  .superRefine((patch, ctx) => {
    try {
      splitRecurringTask(patch);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message:
          error instanceof Error ? error.message : "Invalid recurring task",
      });
    }
  })
  .transform((patch) => {
    const { recurrence } = splitRecurringTask(patch);
    return {
      ...patch,
      rrule: recurrence.rrule,
      dtstart: recurrence.dtstart,
      tzid: recurrence.tzid,
      until: recurrence.until,
      count: recurrence.count,
    };
  });
const createRecurringActionSchema = z
  .object({
    type: z.literal("create_recurring"),
    temp_id: z.string().min(1).max(200),
    patch: recurringPatchSchema,
  })
  .strict();
const updateRecurringActionSchema = z
  .object({
    type: z.literal("update_recurring"),
    temp_id: z.never().optional(),
    target_id: z.string().min(1).max(200),
    expected_version: z.number().int().positive(),
    patch: recurringPatchSchema,
  })
  .strict();
const actionSchema = z.union([
  updateRecurringActionSchema,
  taskActionSchema,
  createListActionSchema,
  createRecurringActionSchema,
]);
export const proposalSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(2000),
    idempotency_key: z.string().min(1).max(200),
    risk: z.enum(["low", "high"]),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  })
  .strict();
function normalizeWireActions(value: unknown): unknown {
  // Structured-output transport uses a key/value array so every schema property
  // can be required without confusing an omitted field with an explicit null.
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as any).actions)
  ) {
    value = {
      ...value,
      actions: (value as any).actions.map((raw: any) => {
        if (!raw || typeof raw !== "object") return raw;
        const action = { ...raw };
        for (const key of ["target_id", "temp_id", "expected_version"])
          if (action[key] === null) delete action[key];
        if (Array.isArray(action.patch)) {
          const patch: Record<string, unknown> = {};
          for (const entry of action.patch) {
            if (
              !entry ||
              typeof entry !== "object" ||
              Object.keys(entry).sort().join(",") !== "key,value" ||
              typeof entry.key !== "string" ||
              Object.hasOwn(patch, entry.key)
            )
              throw new Error("Invalid or duplicate patch field");
            Object.defineProperty(patch, entry.key, {
              value: entry.value,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          action.patch = patch;
        }
        return action;
      }),
    };
  }
  return value;
}

export function parseProposal(value: unknown): ProposalInput {
  value = normalizeWireActions(value);
  const result = proposalSchema.parse(value);
  const targets = result.actions.flatMap((a) =>
    a.type === "create" ||
    a.type === "create_list" ||
    a.type === "create_recurring"
      ? []
      : [a.target_id],
  );
  if (new Set(targets).size !== targets.length)
    throw new Error("A proposal may change each existing task only once");
  const temps = result.actions.map((a) => a.temp_id).filter(Boolean);
  if (new Set(temps).size !== temps.length)
    throw new Error("Duplicate temporary entity ID");
  const definitions = new Map(
    result.actions.flatMap((a, index) =>
      a.temp_id
        ? [
            [
              a.temp_id,
              {
                index,
                kind:
                  a.type === "create_list"
                    ? "list"
                    : a.type === "create_recurring"
                      ? "recurring_task"
                      : a.type === "create" || a.type === "add_subtask"
                        ? "task"
                        : "unused",
              },
            ] as const,
          ]
        : [],
    ),
  );
  for (const [index, action] of result.actions.entries()) {
    if (action.type === "create_list") continue;
    if (
      action.type !== "create_recurring" &&
      action.target_id &&
      definitions.has(action.target_id)
    )
      throw new Error(
        "An action target must be an existing task, not a temporary entity",
      );
    for (const [reference, kind] of [
      [action.patch.list_id, "list"],
      [action.patch.parent_id, "task"],
    ] as const) {
      if (!reference) continue;
      const definition = definitions.get(reference);
      // Unknown references are resolved against live entities in service preflight.
      if (!definition) continue;
      if (definition.kind !== kind)
        throw new Error(`Temporary reference requires a ${kind}`);
      if (definition.index >= index)
        throw new Error(
          "Temporary references must follow their creation action",
        );
    }
  }
  if (
    result.actions.length !== 1 ||
    result.actions[0].type !== "create" ||
    result.actions[0].patch.parent_id
  )
    result.risk = "high";
  return result;
}

// An answer is validated separately; it can never enter the mutation pipeline.
const memoActionSchema = z
  .object({
    type: z.literal("save_memo"),
    temp_id: z.string().min(1).max(200),
    patch: z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        text: z
          .string()
          .min(1)
          .max(20000)
          .refine((text) => text.trim().length > 0, "Memo text is empty"),
        summary: z.string().trim().min(1).max(500).optional(),
        attachment_ids: z.array(z.string().min(1).max(200)).max(12).optional(),
      })
      .strict(),
  })
  .strict();

const contextRequestSchema = z
  .object({
    type: z.literal("request_context"),
    patch: contextQuerySchema,
  })
  .strict();

export function parseAIResponse(value: unknown): AIResponse {
  value = normalizeWireActions(value);
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as any).actions)
  )
    return parseProposal(value);
  const raw = value as any;
  if (raw.actions.some((action: any) => action?.type === "request_context")) {
    const result = proposalSchema
      .extend({ actions: z.array(contextRequestSchema).length(1) })
      .parse(raw);
    return {
      ...result,
      risk: "low",
      actions: [],
      query: result.actions[0].patch,
    };
  }
  const memoActions = raw.actions.filter((a: any) => a?.type === "save_memo");
  if (memoActions.length > 1) throw Error("One record per input");
  const memoAction = memoActions.length
    ? memoActionSchema.parse(memoActions[0])
    : undefined;
  const assetAssignments: { actionIndex: number; attachmentIds: string[] }[] =
    [];
  const tasks = raw.actions
    .filter((a: any) => a?.type !== "save_memo")
    .map((a: any, index: number) => {
      if (
        !a ||
        typeof a !== "object" ||
        !a.patch ||
        typeof a.patch !== "object" ||
        Array.isArray(a.patch)
      )
        return a;
      const { attachment_ids, ...patch } = a.patch;
      if (attachment_ids !== undefined) {
        const ids = z
          .array(z.string().min(1).max(200))
          .max(12)
          .parse(attachment_ids);
        if (a.type === "create_list" || a.type === "delete")
          throw Error("This action cannot attach files");
        assetAssignments.push({
          actionIndex: index,
          attachmentIds: [...new Set(ids)],
        });
      }
      return { ...a, patch };
    });
  const result = tasks.length
    ? parseProposal({ ...raw, actions: tasks })
    : proposalSchema
        .extend({ actions: z.array(z.never()).length(0) })
        .parse({ ...raw, actions: [] });
  const memo = memoAction
    ? {
        tempId: memoAction.temp_id,
        title: memoAction.patch.title,
        text: memoAction.patch.text,
        summary: memoAction.patch.summary,
        attachmentIds: memoAction.patch.attachment_ids,
      }
    : undefined;
  return {
    ...result,
    ...(memo ? { memo } : {}),
    ...(assetAssignments.length ? { assetAssignments } : {}),
  };
}
