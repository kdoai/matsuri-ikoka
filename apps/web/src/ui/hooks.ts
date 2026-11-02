import { useEffect, useState } from "react";

function query(media: string): MediaQueryList | null {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(media);
}

/** メディアクエリに合っているか。変わったら描き直す */
export function useMediaQuery(media: string): boolean {
  const [matches, setMatches] = useState(() => query(media)?.matches ?? false);
  useEffect(() => {
    const list = query(media);
    if (list === null) {
      return;
    }
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [media]);
  return matches;
}

/** 動きを減らす設定（prefers-reduced-motion）か */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}
