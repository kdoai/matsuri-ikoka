import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatMonthDay,
  formatMonthDayWithWeekday,
  fromMinutes,
  nowInJapan,
  todayInJapan,
  toMinutes,
  weekdayOf,
} from "./calendar";

describe("calendar", () => {
  it("日付を足し引きし、月をまたげる", () => {
    expect(addDays("2026-08-16", 14)).toBe("2026-08-30");
    expect(addDays("2026-08-16", -14)).toBe("2026-08-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-08-16", "2026-08-03")).toBe(-13);
  });

  it("曜日を月曜始まりの名前で返す", () => {
    expect(weekdayOf("2026-08-16")).toBe("sun");
    expect(weekdayOf("2026-08-17")).toBe("mon");
    expect(weekdayOf("2026-08-18")).toBe("tue");
  });

  it("日本の日付は、UTC の15時で翌日になる", () => {
    expect(todayInJapan(new Date("2026-08-02T14:59:00Z"))).toBe("2026-08-02");
    expect(todayInJapan(new Date("2026-08-02T15:00:00Z"))).toBe("2026-08-03");
    expect(nowInJapan(new Date("2026-08-03T01:15:00Z"))).toBe("2026-08-03T10:15:00+09:00");
  });

  it("表示用の日付", () => {
    expect(formatMonthDay("2026-08-06")).toBe("8月6日");
    expect(formatMonthDayWithWeekday("2026-08-16")).toBe("8月16日（日）");
  });

  it("時刻と分を行き来する", () => {
    expect(toMinutes("18:30")).toBe(1110);
    expect(fromMinutes(1110)).toBe("18:30");
    expect(fromMinutes(1470)).toBe("00:30");
  });
});
