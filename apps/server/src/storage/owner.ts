// 持ち主の ID と、持ち主を含む置き場のパス（docs/spec/account.md の「利用者ごとの分離」）。
// Firestore のルールは Admin SDK に効かないので、行単位の制限はサーバーのコードだけが担う。
// 持ち主の ID を型で分け、ただの文字列では利用者のデータを読み書きできないようにする。

declare const ownerBrand: unique symbol;

/** 確かめた利用者の ID。ただの文字列からは作れない */
export type OwnerId = string & { readonly [ownerBrand]: true };

/**
 * 確かめた利用者の ID を、持ち主の ID にする。呼んでよいのは、ID トークンを確かめた直後
 * （account/idToken.ts）と、保存した持ち主を戻すとき（session/persistence.ts）だけ。
 * ほかから呼ばれていないことは owner.test.ts で確かめる
 */
export function ownerIdOf(uid: string): OwnerId {
  return uid as OwnerId;
}

/** Firestore の文書の ID の長さの上限（どの ID もこれより短い） */
const MAX_DOCUMENT_ID_LENGTH = 128;

/**
 * Firestore の文書の ID として読めるか。外から届いた ID に `/` が入っていると、
 * 別の文書やサブコレクションを指せてしまうので、読み書きの前に確かめる
 */
export function isDocumentId(id: string): boolean {
  return (
    id.length >= 1 &&
    id.length <= MAX_DOCUMENT_ID_LENGTH &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id)
  );
}

/**
 * 持ち主の旅の、新しいデータの置き場（users/{持ち主}/trips/{旅}/…）。
 * 持ち主を決めてからでないと、パスを作れない。読めない ID は例外にする
 */
export function ownerTripPath(owner: OwnerId, tripId: string, ...rest: string[]): string {
  const segments = [owner, tripId, ...rest];
  if (!segments.every(isDocumentId)) {
    throw new Error("保存の置き場の ID の形が正しくありません");
  }
  return ["users", owner, "trips", tripId, ...rest].join("/");
}
