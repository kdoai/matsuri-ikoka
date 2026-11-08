import {
  GUIDE_PHOTO_MAX_EDGE,
  GUIDE_PHOTO_TYPES,
  type GuidePhoto,
  GuidePhotoSchema,
  type GuidePhotoType,
  MAX_GUIDE_PHOTO_BYTES,
} from "@matsuri-ikoka/schema";

// ガイドに見せる写真を、送れる形にする。端末で長い辺を縮めて JPEG にし、位置などの撮影の情報（Exif）を落とす。
// 写真は送るときに1回だけ使い、ストアにも端末の保存にも残さない。

/** バイト列を base64 にする */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 送れる写真か確かめる。形式が中身と合わない・大きすぎるものは null */
export function photoFromBytes(bytes: Uint8Array, mediaType: string): GuidePhoto | null {
  if (bytes.length === 0 || bytes.length > MAX_GUIDE_PHOTO_BYTES) return null;
  if (!(GUIDE_PHOTO_TYPES as readonly string[]).includes(mediaType)) return null;
  const parsed = GuidePhotoSchema.safeParse({
    mediaType: mediaType as GuidePhotoType,
    data: bytesToBase64(bytes),
  });
  return parsed.success ? parsed.data : null;
}

/** 長い辺を maxEdge に収める大きさ。小さいものは広げない */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = GUIDE_PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** 縮めるときに試す JPEG の質。上限に収まるまで下げる */
const JPEG_QUALITIES = [0.85, 0.7, 0.55] as const;

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** 端末で縮めて JPEG にする。縮められない端末では null */
async function shrink(file: Blob): Promise<GuidePhoto | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of JPEG_QUALITIES) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob === null) return null;
      const photo = photoFromBytes(await blobBytes(blob), "image/jpeg");
      if (photo !== null) return photo;
    }
    return null;
  } finally {
    bitmap.close();
  }
}

/**
 * 選んだ写真を、ガイドに送れる形にする。縮められなければ、元の写真が形式と大きさの決まりに合うときだけそのまま使う。
 * 送れなければ null
 */
export async function preparePhoto(file: Blob): Promise<GuidePhoto | null> {
  const shrunk = await shrink(file);
  if (shrunk !== null) return shrunk;
  if (file.size > MAX_GUIDE_PHOTO_BYTES) return null;
  return photoFromBytes(await blobBytes(file), file.type);
}
