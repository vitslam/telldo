import { z } from "zod";
import { DateTime } from "luxon";
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => DateTime.fromISO(value, { zone: "UTC" }).isValid,
    "Invalid query date",
  );
const search = z
  .object({
    entity: z.enum(["tasks", "memos", "schedule"]),
    keywords: z.string().trim().max(200).optional(),
    status: z.enum(["todo", "done", "all"]).optional(),
    list_id: z.string().min(1).max(200).optional(),
    from: day.optional(),
    to: day.optional(),
    limit: z.number().int().min(1).max(30).optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.from && query.to && query.from > query.to)
      ctx.addIssue({ code: "custom", message: "Query date range is reversed" });
    if (query.entity === "schedule") {
      if (!query.from || !query.to)
        ctx.addIssue({
          code: "custom",
          message: "Schedule query requires from and to",
        });
      else if (
        DateTime.fromISO(query.to, { zone: "UTC" }).diff(
          DateTime.fromISO(query.from, { zone: "UTC" }),
          "days",
        ).days > 30
      )
        ctx.addIssue({
          code: "custom",
          message: "Schedule queries cover at most 31 calendar days",
        });
    }
  });
const record = z
  .object({
    entity: z.literal("record"),
    kind: z.enum(["memo", "task"]),
    id: z.string().min(1).max(200),
  })
  .strict();
export const contextQuerySchema = z.union([search, record]);
export type ContextQuery = z.infer<typeof contextQuerySchema>;
export type SearchContextQuery = Extract<
  ContextQuery,
  { entity: "tasks" | "memos" | "schedule" }
>;
export function parseContextQuery(value: unknown): ContextQuery {
  return contextQuerySchema.parse(value);
}
