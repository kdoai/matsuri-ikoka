import { type CheckedChange, GuideNoticeSchema, type NoticeContent } from "@matsuri-ikoka/schema";
import { fictionalCheckedChange, fictionalItinerary } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import {
  evictionFor,
  noticeExpiresAt,
  noticeFor,
  noticeId,
  noticeSummary,
  noticeToEvict,
} from "./notices";
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

describe("noticeId", () => {
  const announcement = (topic: "traffic" | "venue", fingerprint: string): CheckedChange => ({
    ...fictionalCheckedChange(),
    fingerprint,
    content: { kind: "announcement", festivalId: FESTIVAL_ID, date: PATROL_DATE, topic },
  });

  it("お知らせは、祭りと開催日と種類ごとに1つの ID に畳む", () => {
    const first = noticeId(announcement("traffic", "0123456789abcdef"));

    expect(noticeId(announcement("traffic", "fedcba9876543210"))).toBe(first);
    expect(noticeId(announcement("venue", "0123456789abcdef"))).not.toBe(first);
  });

  it("開催の変更と中止は、変化ごとの ID にする", () => {
    const change = fictionalCheckedChange();

    expect(noticeId(change)).toBe(`n-${change.fingerprint}`);
  });
});

describe("noticeToEvict", () => {
  const NOW_MS = Date.parse("2026-08-16T12:00:00+09:00");
  const notice = (id: string, kind: string, createdAt: string, readAt: string | null = null) => ({
    id,
    kind,
    createdAt,
    readAt,
  });

  it("古いお知らせから押し出す", () => {
    expect(
      noticeToEvict(
        [
          notice("a", "cancellation", "2026-08-01"),
          notice("b", "announcement", "2026-08-03"),
          notice("c", "announcement", "2026-08-02"),
        ],
        NOW_MS,
      ),
    ).toBe("c");
  });

  it("お知らせがなければ、読んだ古い通知を押し出す", () => {
    expect(
      noticeToEvict(
        [
          notice("a", "schedule_change", "2026-08-01"),
          notice("b", "availability", "2026-08-03", "2026-08-04"),
          notice("c", "cancellation", "2026-08-02", "2026-08-05"),
        ],
        NOW_MS,
      ),
    ).toBe("c");
  });

  it("未読の開催の変更と中止は押し出さない", () => {
    expect(
      noticeToEvict(
        [notice("a", "schedule_change", "2026-08-01"), notice("b", "cancellation", "2026-08-02")],
        NOW_MS,
      ),
    ).toBeNull();
  });

  it("役目を終えた声かけは、未読でも先に押し出す。届けたばかりの声かけは押し出さない", () => {
    const items = [
      notice("a", "announcement", "2026-08-01T00:00:00+09:00"),
      notice("b", "reminder", "2026-08-16T08:00:00+09:00"),
      notice("c", "reminder", "2026-08-16T11:30:00+09:00"),
    ];
    expect(noticeToEvict(items, NOW_MS)).toBe("b");
    expect(noticeToEvict(items.slice(2), NOW_MS)).toBeNull();
  });

  it("新しい声かけのためには、役目を終えた声かけだけを押し出す", () => {
    const items = [
      notice("a", "announcement", "2026-08-01T00:00:00+09:00"),
      notice("b", "availability", "2026-08-02T00:00:00+09:00", "2026-08-03T00:00:00+09:00"),
    ];
    expect(noticeToEvict(items, NOW_MS, { onlySpentReminders: true })).toBeNull();
    expect(
      noticeToEvict([...items, notice("c", "reminder", "2026-08-16T08:00:00+09:00")], NOW_MS, {
        onlySpentReminders: true,
      }),
    ).toBe("c");
  });
});

describe("evictionFor", () => {
  it("開催の変更と中止は何でも、声かけは役目を終えた声かけだけを押し出せる", () => {
    expect(
      evictionFor({
        content: { kind: "cancellation", festivalId: "suzunari-toro", date: "2026-08-16" },
      }),
    ).toBe("any");
    expect(
      evictionFor({
        content: { kind: "reminder", slot: "eve", date: "2026-08-16", at: "18:00", itemId: null },
      }),
    ).toBe("spent_reminders");
    expect(
      evictionFor({
        content: {
          kind: "announcement",
          festivalId: "suzunari-toro",
          date: "2026-08-16",
          topic: "other",
        },
      }),
    ).toBeNull();
  });
});
