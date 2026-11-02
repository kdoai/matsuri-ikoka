import { describe, expect, it } from "vitest";
import type { FestivalInput } from "../packages/schema/src";
import { fictionalFestival, fictionalSource } from "../packages/schema/src/testing";
import {
  type FestivalFile,
  type Finding,
  type ValidateOptions,
  validateFestivalFiles,
} from "./festival-validation";

// 架空の祭りの出典は 2026-04-01 に確認、開催は 2026-08-16
const FRESH: ValidateOptions = { today: "2026-04-02", allowExampleSources: true };

function fileOf(festival: unknown, name?: string): FestivalFile {
  const id = (festival as FestivalInput).id;
  return { name: name ?? `${id}.json`, content: JSON.stringify(festival) };
}

function messages(findings: Finding[], level: Finding["level"]): string[] {
  return findings.filter((f) => f.level === level).map((f) => f.message);
}

describe("validateFestivalFiles", () => {
  it("架空の祭りのファイルは、エラーも警告もなく通る", () => {
    expect(validateFestivalFiles([fileOf(fictionalFestival())], FRESH)).toEqual([]);
  });

  describe("エラー", () => {
    it("JSON として読めないファイル", () => {
      const findings = validateFestivalFiles([{ name: "broken.json", content: "{" }], FRESH);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: "broken.json", level: "error" });
    });

    it("スキーマに合わないファイルは、項目の場所つきで知らせる", () => {
      const festival = { ...fictionalFestival(), sources: [] };
      const errors = messages(validateFestivalFiles([fileOf(festival)], FRESH), "error");
      expect(errors.some((m) => m.startsWith("sources："))).toBe(true);
    });

    it("ファイル名と id が違う", () => {
      const findings = validateFestivalFiles([fileOf(fictionalFestival(), "other.json")], FRESH);
      expect(messages(findings, "error")).toEqual([
        "ファイル名を id に合わせてください（suzunari-toro.json）",
      ]);
    });

    it("同じ id の祭りが2つある", () => {
      const files = [fileOf(fictionalFestival()), fileOf(fictionalFestival(), "copy.json")];
      const duplicates = validateFestivalFiles(files, FRESH).filter((f) =>
        f.message.includes("重複"),
      );
      expect(duplicates.map((f) => f.file).sort()).toEqual(["copy.json", "suzunari-toro.json"]);
    });

    it("例示用のドメインの出典は、実在の祭りのデータに入れられない", () => {
      const findings = validateFestivalFiles([fileOf(fictionalFestival())], {
        today: FRESH.today,
      });
      expect(messages(findings, "error")).toHaveLength(1);
      expect(messages(findings, "error")[0]).toContain("例示用のドメイン");
    });

    it("確認した日が今日より後", () => {
      const festival = fictionalFestival();
      festival.sources = [{ ...fictionalSource("about"), checkedAt: "2026-04-03" }];
      expect(messages(validateFestivalFiles([fileOf(festival)], FRESH), "error")).toEqual([
        "sources.0：確認した日（2026-04-03）が今日より後です",
      ]);
    });
  });

  describe("警告：確認日の古さ", () => {
    function occurrenceWarnings(festival: FestivalInput, today: string): string[] {
      return messages(
        validateFestivalFiles([fileOf(festival)], { ...FRESH, today }),
        "warning",
      ).filter((m) => m.startsWith("occurrences"));
    }

    it("4週間以内の開催回は、確認から7日を過ぎると警告", () => {
      const festival = fictionalFestival();
      festival.occurrences[0]!.sources = [{ ...fictionalSource("2026"), checkedAt: "2026-08-01" }];
      expect(occurrenceWarnings(festival, "2026-08-08")).toEqual([]);
      expect(occurrenceWarnings(festival, "2026-08-09")).toEqual([
        "occurrences.0（2026-08-16）：確認から8日たっています（期限は7日）",
      ]);
    });

    it("1〜3か月先の開催回は、確認から30日を過ぎると警告", () => {
      const festival = fictionalFestival();
      festival.occurrences[0]!.sources = [{ ...fictionalSource("2026"), checkedAt: "2026-05-15" }];
      expect(occurrenceWarnings(festival, "2026-06-14")).toEqual([]);
      expect(occurrenceWarnings(festival, "2026-06-15")).toHaveLength(1);
    });

    it("出典が複数あれば、いちばん新しい確認日で測る", () => {
      const festival = fictionalFestival();
      festival.occurrences[0]!.sources = [
        fictionalSource("2026"),
        { ...fictionalSource("2026-news", "corroborated"), checkedAt: "2026-08-05" },
      ];
      expect(occurrenceWarnings(festival, "2026-08-10")).toEqual([]);
    });

    it("終わった開催回は警告しないが、先の開催回がなければ知らせる", () => {
      const warnings = messages(
        validateFestivalFiles([fileOf(fictionalFestival())], { ...FRESH, today: "2026-09-01" }),
        "warning",
      );
      expect(warnings.some((m) => m.startsWith("occurrences"))).toBe(false);
      expect(warnings).toContain("これから先の開催回がありません。次の回の開催日を調べてください");
    });

    it("周辺の場所は、確認から30日を過ぎると警告", () => {
      const warnings = messages(
        validateFestivalFiles([fileOf(fictionalFestival())], { ...FRESH, today: "2026-05-02" }),
        "warning",
      );
      expect(warnings).toEqual([
        "nearby.0（鈴鳴和紙の館）：確認から31日たっています（期限は30日）",
      ]);
    });

    it("由来や作法などの変わりにくい情報は、確認から365日を過ぎると警告", () => {
      const festival = fictionalFestival();
      festival.occurrences = [{ ...festival.occurrences[0]!, date: "2027-08-16" }];
      festival.nearby = [];
      const warnings = messages(
        validateFestivalFiles([fileOf(festival)], { ...FRESH, today: "2027-04-02" }),
        "warning",
      );
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^sources：/),
          expect.stringMatching(/^etiquette\.sources：/),
          expect.stringMatching(/^access\.sources：/),
          expect.stringMatching(/^trivia\.0：/),
        ]),
      );
    });
  });

  it("同じ周辺の場所の id が、別の祭りで別の場所を指していれば警告", () => {
    const other = fictionalFestival();
    other.id = "kazami-bon-odori";
    other.nearby = [{ ...other.nearby[0]!, name: "風見の資料館" }];
    const warnings = messages(
      validateFestivalFiles([fileOf(fictionalFestival()), fileOf(other)], FRESH),
      "warning",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("suzunari-craft-hall");
  });
});
