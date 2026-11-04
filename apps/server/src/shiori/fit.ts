// しおりの1ページに、どれだけの中身が入るかを見積もる。
// どのページも A4 1枚の決まった大きさの紙にし、はみ出しそうな中身は「つづき」のページに送る（render.ts）。
// ページの中ではスクリプトを動かせないので、文字の数と箱の大きさから高さ（mm）をコードで見積もる。
// 見積もりは少し多めにし、実際に収まっているかは Chromium で確かめる（fit.test.ts）。

/** 1pt の長さ（mm） */
export const PT_MM = 25.4 / 72;

/** 紙（A4 縦）の外側の大きさ（mm） */
export const PAGE_MM = { width: 210, height: 297 } as const;

/**
 * 紙の中身を置ける高さ（mm）。紙の余白 6mm・紺の二重の枠 1.2mm・枠の内側の余白（上 7mm・下 10mm。下にページ番号）を引く
 */
export const FLOW_HEIGHT_MM = PAGE_MM.height - 6 * 2 - 1.2 * 2 - 7 - 10;

/** 紙の中身を置ける幅（mm）。紙の余白 6mm・枠 1.2mm・枠の内側の余白 9mm を引く */
export const FLOW_WIDTH_MM = PAGE_MM.width - 6 * 2 - 1.2 * 2 - 9 * 2;

/** 見積もりの上乗せ（フォントの字形や行の折り返しのずれの分） */
const SAFETY = 1.02;

/** 半角の文字（英数字・記号）は全角の半分ほど、空白はもっと狭い幅で数える */
function charUnits(char: string): number {
  if (char === " ") return 0.3;
  const code = char.codePointAt(0) ?? 0;
  return code < 0x2000 || (code >= 0xff61 && code <= 0xff9f) ? 0.5 : 1;
}

/** 文字の幅の合計（全角1文字を1とする） */
export function textUnits(text: string): number {
  let units = 0;
  for (const char of text) units += charUnits(char);
  return units;
}

/** 幅 widthMm・文字の大きさ pt で、文が何行になるか（空の文は0行） */
export function lineCount(text: string, widthMm: number, pt: number, firstLineUsedMm = 0): number {
  if (text === "") return 0;
  // 行の終わりで文字が切れるので、1行に入る文字の数は小数を切り捨てる
  const perLine = Math.max(1, Math.floor(widthMm / (pt * PT_MM) + 0.4));
  const firstLine = Math.max(1, Math.floor((widthMm - firstLineUsedMm) / (pt * PT_MM) + 0.4));
  const units = textUnits(text);
  if (units <= firstLine) return 1;
  return 1 + Math.ceil((units - firstLine) / perLine);
}

/** 文の高さ（mm） */
export function textMm(
  text: string,
  widthMm: number,
  pt: number,
  lineHeight: number,
  firstLineUsedMm = 0,
): number {
  return lineCount(text, widthMm, pt, firstLineUsedMm) * pt * PT_MM * lineHeight;
}

/** 箇条書き（1つずつ行を改める）の高さ（mm） */
export function listMm(
  items: readonly string[],
  widthMm: number,
  pt: number,
  lineHeight: number,
  gapMm: number,
): number {
  return items.reduce((sum, item) => sum + textMm(item, widthMm, pt, lineHeight) + gapMm, 0);
}

/** 見積もった高さに上乗せをかける */
export function withSafety(mm: number): number {
  return mm * SAFETY;
}

/** ページに置く中身の1かたまりと、その見積もりの高さ（mm） */
export interface FlowBlock<T> {
  content: T;
  mm: number;
  /** 前のかたまりと同じページに置く（見出しだけがページの最後に残らないように） */
  keepWithNext?: boolean;
}

/**
 * かたまりを順にページへ詰める。1ページ目の高さは first、2ページ目からは rest。
 * 1つのかたまりが1ページより高くても、そのページに1つだけ置く（中身を落とさない）
 */
export function packBlocks<T>(blocks: readonly FlowBlock<T>[], first: number, rest: number): T[][] {
  const pages: T[][] = [[]];
  let room = first;
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as FlowBlock<T>;
    // 次のかたまりと離さないものは、次のかたまりと合わせた高さで入るかを決める
    const next = block.keepWithNext ? blocks[i + 1] : undefined;
    const need = withSafety(block.mm + (next?.mm ?? 0));
    const page = pages[pages.length - 1] as T[];
    if (page.length > 0 && used + need > room) {
      pages.push([block.content]);
      room = rest;
      used = withSafety(block.mm);
    } else {
      page.push(block.content);
      used += withSafety(block.mm);
    }
  }
  return pages;
}

/** かたまりを詰めたあと、最後のページに残る高さ（mm） */
export function roomLeft(blocks: readonly { mm: number }[], height: number): number {
  return height - blocks.reduce((sum, b) => sum + withSafety(b.mm), 0);
}
