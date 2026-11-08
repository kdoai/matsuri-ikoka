import { GUIDE_PHOTO_MAX_EDGE, MAX_GUIDE_PHOTO_BYTES } from "@matsuri-ikoka/schema";
import { fictionalPhoto } from "@matsuri-ikoka/schema/testing";
import { describe, expect, it } from "vitest";
import { bytesToBase64, fitWithin, photoFromBytes, preparePhoto } from "./photo";

const bytesOf = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

describe("photoFromBytes", () => {
  it("形式が中身と合う JPEG・PNG・WebP を送れる形にする", () => {
    for (const mediaType of ["image/jpeg", "image/png", "image/webp"] as const) {
      const photo = fictionalPhoto({ mediaType });
      expect(photoFromBytes(bytesOf(photo.data), mediaType)).toEqual(photo);
    }
  });

  it("形式が合わないもの、画像でないもの、大きすぎるものは送らない", () => {
    const png = fictionalPhoto({ mediaType: "image/png" });
    expect(photoFromBytes(bytesOf(png.data), "image/jpeg")).toBeNull();
    expect(photoFromBytes(new TextEncoder().encode("<svg></svg>"), "image/svg+xml")).toBeNull();
    expect(photoFromBytes(new Uint8Array(), "image/jpeg")).toBeNull();
    const large = fictionalPhoto({ bytes: MAX_GUIDE_PHOTO_BYTES + 1 });
    expect(photoFromBytes(bytesOf(large.data), "image/jpeg")).toBeNull();
  });

  it("大きなバイト列も base64 にできる", () => {
    const bytes = new Uint8Array(200_000).fill(0x41);
    expect(bytesToBase64(bytes)).toBe(btoa("A".repeat(200_000)));
  });
});

describe("fitWithin", () => {
  it("長い辺を上限に収め、縦横の比を保つ。小さいものは広げない", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: GUIDE_PHOTO_MAX_EDGE, height: 960 });
    expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("preparePhoto", () => {
  it("縮められない端末でも、決まりに合う写真はそのまま使う", async () => {
    const photo = fictionalPhoto();
    const file = new Blob([bytesOf(photo.data)], { type: "image/jpeg" });
    expect(await preparePhoto(file)).toEqual(photo);
  });

  it("縮められない端末で、決まりに合わない写真は送らない", async () => {
    const file = new Blob([new TextEncoder().encode("GIF89a")], { type: "image/gif" });
    expect(await preparePhoto(file)).toBeNull();
  });
});
