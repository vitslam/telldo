import { describe, expect, it } from "vitest";
import { alignRepeatDate, repeatLabel } from "../src/renderer/RepeatSettings";
const value = (rrule: string) => ({ rrule, count: null, until: null });
describe("repeat date selection", () => {
  it("keeps matching dates and advances to the next matching weekday", () => {
    expect(alignRepeatDate(value("FREQ=WEEKLY;BYDAY=MO,FR"), "2031-02-10")).toBe("2031-02-10");
    expect(alignRepeatDate(value("FREQ=WEEKLY;BYDAY=MO,FR"), "2031-02-11")).toBe("2031-02-14");
  });
  it("skips months without the requested day and supports monthly weekday positions", () => {
    expect(alignRepeatDate(value("FREQ=MONTHLY;BYMONTHDAY=31"), "2031-02-10")).toBe("2031-03-31");
    expect(alignRepeatDate(value("FREQ=MONTHLY;BYDAY=-1FR"), "2031-02-10")).toBe("2031-02-28");
    expect(alignRepeatDate(null, "2031-02-10")).toBe("2031-02-10");
  });
  it("summarizes selected weekdays in both languages", () => {
    expect(repeatLabel(value("FREQ=WEEKLY;BYDAY=MO,FR"), false)).toBe("Weekly · Mon, Fri");
    expect(repeatLabel(value("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), true)).toBe("每个工作日");
  });
});
