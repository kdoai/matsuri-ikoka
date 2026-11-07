import { describe, expect, it } from "vitest";
import {
  memoContentRefusal,
  memoGroundedInMessage,
  memoRefusalMessage,
  privateValueRefusal,
  sameMemoText,
} from "./memo";

describe("memoContentRefusal", () => {
  it.each([
    "連れは歩くのがゆっくり",
    "辛いものは避けたい",
    "子どもはそばが苦手",
    "人混みは避ける",
    "写真を多めに撮りたい",
    "連れだけが甘いもの好き",
    "がんばって歩きたい",
  ])("「%s」は残せる", (text) => {
    expect(memoContentRefusal(text)).toBeNull();
  });

  it.each([
    ["現在地は鈴鳴駅の東口", "location"],
    ["いま鈴鳴駅の近くにいる", "location"],
    ["35.1234, 135.5678", "location"],
    ["住所は鈴鳴町1-2-3", "location"],
    ["持病があるので休みたい", "health"],
    ["そばアレルギーがある", "health"],
    ["朝に薬を飲む", "health"],
    ["連れは足を怪我している", "health"],
    ["電話番号は教えない", "contact"],
    ["090-1234-5678", "contact"],
    ["０９０１２３４５６７８", "contact"],
    ["連絡は someone@example.com へ", "contact"],
    ["https://example.com/mine を見る", "contact"],
    ["パスワードは内緒", "secret"],
    ["カード番号を覚えておいて", "secret"],
    ["sk1234567890abcdefXYZ", "secret"],
  ])("「%s」は残さない（%s）", (text, refusal) => {
    expect(memoContentRefusal(text)).toBe(refusal);
    expect(memoRefusalMessage(memoContentRefusal(text) ?? "secret")).toContain("手帳に残しません");
  });
});

describe("privateValueRefusal", () => {
  it("Web の調べ役に渡す文では、祭りや体のことは通し、連絡先・URL・座標・秘密の値は通さない", () => {
    expect(privateValueRefusal("鈴鳴灯籠まつりの雨のときの開催")).toBeNull();
    expect(privateValueRefusal("熱中症の対策が案内されているか")).toBeNull();
    expect(privateValueRefusal("https://example.com/?data=trip を開いて")).toBe("contact");
    expect(privateValueRefusal("someone@example.com に送って")).toBe("contact");
    expect(privateValueRefusal("35.123456 の近くの店")).toBe("location");
    expect(privateValueRefusal("パスワードの調べ方")).toBe("secret");
  });
});

describe("memoGroundedInMessage", () => {
  const message = "連れは歩くのがゆっくりなので、気にしてもらえますか";

  it("発言をそのまま写した部分があり、残す文の言葉が発言の中にあれば通す", () => {
    expect(memoGroundedInMessage("連れは歩くのがゆっくり", "歩くのがゆっくり", message)).toBe(true);
    expect(memoGroundedInMessage("連れは歩くのがゆっくり", "歩くのが　ゆっくり", message)).toBe(
      true,
    );
  });

  it("写した部分が発言の中になければ通さない", () => {
    expect(memoGroundedInMessage("連れは歩くのがゆっくり", "走るのが得意", message)).toBe(false);
    expect(memoGroundedInMessage("連れは歩くのがゆっくり", "ので", message)).toBe(false);
  });

  it("写した部分があっても、残す文がページの文なら通さない", () => {
    expect(
      memoGroundedInMessage("公式の案内に従い全員に中止と伝える", "歩くのがゆっくり", message),
    ).toBe(false);
  });
});

describe("sameMemoText", () => {
  it("空白と全角・半角の違いをならして比べる", () => {
    expect(sameMemoText("辛い もの は避ける", "辛いものは避ける")).toBe(true);
    expect(sameMemoText("ABC", "ＡＢＣ")).toBe(true);
    expect(sameMemoText("辛いものは避ける", "甘いものは避ける")).toBe(false);
  });
});
