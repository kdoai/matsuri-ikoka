import { GuideNoticeSchema, type NoticeContent } from "@matsuri-ikoka/schema";
import { fictionalCheckedChange, fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { noticeExpiresAt, noticeFor, noticeId, noticeSummary } from "./notices";
import { FESTIVAL_ID, NOW, PATROL_DATE } from "./testing";

describe("noticeSummary", () => {
  const name = "鈴鳴灯籠まつり";
  const base = { festivalId: FESTIVAL_ID, date: PATROL_DATE };

  it.each<[string, NoticeContent, string]>([
    [
      "開催日の変更",
      {
        ...base,
        kind: "schedule_change",
        changes: [{ field: "date", before: PATROL_DATE, after: "2026-08-23" }],
      },
      "鈴鳴灯籠まつり：開催日が 8月16日 から 8月23日 に変わりました",
    ],
    [
      "新しい日が分からない延期",
      {
        ...base,
        kind: "schedule_change",
        changes: [{ field: "date", before: PATROL_DATE, after: null }],
      },
      "鈴鳴灯籠まつり：8月16日の開催は延期になりました。新しい日はまだ分かりません",
    ],
    [
      "時刻の変更",
      {
        ...base,
        kind: "schedule_change",
        changes: [
          { field: "start", before: "18:30", after: "19:30" },
          { field: "end", before: null, after: "21:30" },
        ],
      },
      "鈴鳴灯籠まつり：開始が 18:30 から 19:30 に変わりました。終了が 21:30 と分かりました",
    ],
    ["中止", { ...base, kind: "cancellation" }, "鈴鳴灯籠まつり（8月16日）は中止になりました"],
    [
      "お知らせ",
      { ...base, kind: "announcement", topic: "traffic" },
      "鈴鳴灯籠まつりに主催者のお知らせ（交通規制）があります。くわしくは出典のページをご覧ください",
    ],
    [
      "宿の空き",
      {
        kind: "availability",
        lodgingName: "（架空）川べりの宿",
        checkIn: PATROL_DATE,
        checkOut: "2026-08-17",
        available: false,
        nightlyTotalYen: null,
        bookingUrl: null,
      },
      "8月16日の宿「（架空）川べりの宿」の空きが見つからなくなりました",
    ],
  ])("%sの短い文を、通知の中身から作る", (_name, content, summary) => {
    expect(noticeSummary(content, name)).toBe(summary);
  });
});

describe("noticeFor", () => {
  it("通知の形で作り、同じ変化からは同じ ID にする", () => {
    const change = fictionalCheckedChange();

    const notice = noticeFor({
      change,
      tripId: "trip-a",
      itinerary: fictionalItinerary(),
      festivalName: "鈴鳴灯籠まつり",
      now: NOW,
    });

    expect(GuideNoticeSchema.parse(notice)).toEqual(notice);
    expect(notice.id).toBe(noticeId(change));
    expect(notice).toMatchObject({ tripId: "trip-a", proposalId: null, readAt: null });
    expect(notice.affectedItemIds.length).toBeGreaterThan(0);
  });

  it("通知は旅の最終日から30日で消える", () => {
    const itinerary = fictionalItinerary();
    const last = itinerary.days.at(-1)?.date;

    expect(new Date(noticeExpiresAt(itinerary)).toISOString().slice(0, 10)).toBe(
      new Date(Date.parse(`${last}T00:00:00+09:00`) + 30 * 86_400_000).toISOString().slice(0, 10),
    );
  });
});
