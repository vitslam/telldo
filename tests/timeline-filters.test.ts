import { describe, expect, it } from "vitest";
import { defaultTimelineFilters, readTimelineFilters, matchesTimelineFilters, timelineRange, attachmentMatches } from "../src/shared/timeline-filters";
const zone="Asia/Shanghai";
const image={id:"img",name:"sample.png",kind:"image" as const,mime:"image/png",bytes:1};
const pdf={...image,id:"pdf",name:"report.PDF",kind:"file" as const,mime:"application/pdf"};
const row={kind:"task" as const,at:"2031-02-10T16:30:00Z",listIds:["work"],attachments:[image,pdf],content:"Release review"};
describe("composable timeline filters",()=>{
 it("intersects dimensions and unions values within each dimension",()=>{
  const f={...defaultTimelineFilters(zone),lists:["work","life"],kinds:["task" as const],attachments:["image" as const,"audio" as const],search:"release"};
  expect(matchesTimelineFilters(row,f,zone)).toBe(true);
  expect(matchesTimelineFilters({...row,listIds:["travel"]},f,zone)).toBe(false);
  expect(matchesTimelineFilters({...row,kind:"memo"},f,zone)).toBe(false);
  expect(matchesTimelineFilters({...row,attachments:[pdf]},f,zone)).toBe(false);
 });
 it("uses local calendar dates with inclusive range ends, never due dates",()=>{
  const f={...defaultTimelineFilters(zone),period:"custom" as const,start:"2031-02-11",end:"2031-02-11"};
  expect(matchesTimelineFilters(row,f,zone)).toBe(true);
  expect(matchesTimelineFilters({...row,at:"2031-02-11T16:00:00Z"},f,zone)).toBe(false);
  expect(matchesTimelineFilters(row,{...f,start:"2031-02-12"},zone)).toBe(false);
 });
 it("supports Monday weeks, leap months and daylight-saving local days",()=>{
  expect(timelineRange({...defaultTimelineFilters(zone),period:"week",anchor:"2031-02-12"},zone)).toEqual({start:"2031-02-10",end:"2031-02-16"});
  expect(timelineRange({...defaultTimelineFilters(zone),period:"month",anchor:"2028-02-10"},zone)).toEqual({start:"2028-02-01",end:"2028-02-29"});
  const f={...defaultTimelineFilters(zone),period:"day" as const,anchor:"2026-03-08"};
  expect(matchesTimelineFilters({...row,at:"2026-03-09T03:59:59Z"},f,"America/New_York")).toBe(true);
  expect(matchesTimelineFilters({...row,at:"2026-03-09T04:00:00Z"},f,"America/New_York")).toBe(false);
 });
 it("handles unassigned records and attachment subtypes",()=>{
  const f={...defaultTimelineFilters(zone),lists:["__unassigned"],attachments:["none" as const]};
  expect(matchesTimelineFilters({...row,listIds:[],attachments:[]},f,zone)).toBe(true);
  expect(matchesTimelineFilters(row,f,zone)).toBe(false);
  expect(attachmentMatches(pdf,"pdf")).toBe(true);expect(attachmentMatches(pdf,"file")).toBe(true);expect(attachmentMatches(pdf,"image")).toBe(false);
  expect(attachmentMatches({...pdf,name:"clip.mp4",mime:"video/mp4"},"video")).toBe(true);
 });
 it("restores valid preferences and safely ignores malformed storage",()=>{
  expect(readTimelineFilters("broken",zone)).toMatchObject({lists:[],period:"all"});
  const saved={...defaultTimelineFilters(zone),lists:["work"],kinds:["memo"],attachments:["pdf"],period:"custom",start:"2031-02-01",end:"2031-02-28"};
  expect(readTimelineFilters(JSON.stringify(saved),zone)).toEqual(saved);
  expect(readTimelineFilters(JSON.stringify({lists:[1,"work","work"],attachments:["hacked"],period:"invalid"}),zone)).toMatchObject({lists:["work"],attachments:[],period:"all"});
 });
});
