import { describe, expect, it } from "vitest";
import { readAccountConfig } from "./firebase";
import { bearerToken } from "./idToken";

describe("bearerToken", () => {
  it("Authorization の Bearer のトークンだけを取り出す", () => {
    expect(bearerToken("Bearer abc.def-ghi_jkl")).toBe("abc.def-ghi_jkl");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(`Bearer ${"a".repeat(5000)}`)).toBeNull();
  });
});

describe("readAccountConfig", () => {
  it("既定はメモリに保存し、ログインなし", () => {
    expect(readAccountConfig({})).toEqual({
      storage: "memory",
      projectId: null,
      databaseId: null,
      web: { enabled: false },
    });
  });

  it("Firebase の公開の設定がそろえば、ログインを出す。エミュレーターなら画面にも伝える", () => {
    const config = readAccountConfig({
      MATSURI_STORAGE: "firestore",
      FIREBASE_PROJECT_ID: "demo-project",
      FIREBASE_WEB_API_KEY: "public-key",
      FIREBASE_AUTH_DOMAIN: "demo-project.firebaseapp.com",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    });
    expect(config.storage).toBe("firestore");
    expect(config.web).toEqual({
      enabled: true,
      apiKey: "public-key",
      authDomain: "demo-project.firebaseapp.com",
      projectId: "demo-project",
      emulatorUrl: "http://127.0.0.1:9099",
    });
  });

  it("Firestore にはプロジェクト ID が要る。保存先の名前を確かめる", () => {
    expect(() => readAccountConfig({ MATSURI_STORAGE: "firestore" })).toThrow(
      "FIREBASE_PROJECT_ID",
    );
    expect(() => readAccountConfig({ MATSURI_STORAGE: "disk" })).toThrow("MATSURI_STORAGE");
  });
});
