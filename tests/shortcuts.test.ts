import { describe, expect, it } from "vitest";
import { matchShortcut, shortcutLabel, SHORTCUTS } from "../src/shared/shortcuts";
const key = { key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
describe("Telldo shortcut matching", () => {
  it("uses Command on Mac and Control on other platforms", () => {
    expect(matchShortcut(key, true)).toBe("focus-ai");
    expect(matchShortcut({ ...key, metaKey: false, ctrlKey: true }, true)).toBeNull();
    expect(matchShortcut({ ...key, metaKey: false, ctrlKey: true }, false)).toBe("focus-ai");
    expect(matchShortcut(key, false)).toBeNull();
  });
  it("doesn't intercept IME, repeat, Option combinations, or standard editing", () => {
    for (const extra of [{isComposing:true},{keyCode:229},{repeat:true},{altKey:true},{code:"KeyV",key:"v"},{code:"KeyZ",key:"z"}]) expect(matchShortcut({...key,...extra},true)).toBeNull();
  });
  it("distinguishes new chat and new list and supports physical keys in non-Latin input", () => {
    expect(matchShortcut({...key,code:"KeyN",key:"n"},true)).toBe("new-chat");
    expect(matchShortcut({...key,code:"KeyN",key:"N",shiftKey:true},true)).toBe("new-list");
    expect(matchShortcut({...key,code:"KeyJ",key:"о"},true)).toBe("focus-ai");
    expect(matchShortcut({...key,code:"NumpadEnter",key:"Enter"},true)).toBe("submit");
    expect(shortcutLabel("history",true)).toBe("⌘⇧H");
    expect(shortcutLabel("settings",false)).toBe("Ctrl+,");
  });
  it("has no conflicting key combinations", () => {
    const codes=SHORTCUTS.map(item=>`${item.shift || false}:${item.code}`);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
