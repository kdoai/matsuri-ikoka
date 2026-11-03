import type { ItineraryItem } from "@matsuri-ikoka/schema";
import {
  Bus,
  Car,
  ClipboardList,
  Coffee,
  Drama,
  Flame,
  Footprints,
  Landmark,
  type LucideIcon,
  Music,
  PartyPopper,
  Sparkles,
  Store,
  TrainFront,
  UtensilsCrossed,
} from "lucide-react";

// 画面のアイコン。lucide のアイコンに、提灯と鳥居（このアプリのために描いた形）を足す。

type IconProps = { className?: string; strokeWidth?: number };

/** 提灯 */
export function LanternIcon({ className = "", strokeWidth = 2 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 3h6M10 3v2M14 3v2" />
      <path d="M8 5h8M8 19h8" />
      <path d="M7 7c-1.5 3-1.5 7 0 10M17 7c1.5 3 1.5 7 0 10" />
      <path d="M8 5C5 8 5 16 8 19M16 5c3 3 3 11 0 14" />
      <path d="M6.5 9.5h11M6 12h12M6.5 14.5h11" />
      <path d="M12 19v2" />
    </svg>
  );
}

/** 鳥居 */
export function ToriiIcon({ className = "", strokeWidth = 2 }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 5c3 1 15 1 18 0" />
      <path d="M5 9h14" />
      <path d="M7 6v15M17 6v15" />
      <path d="M12 6v3" />
    </svg>
  );
}

/** ロゴの印（やぐらと旗） */
export function YaguraIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path d="M24 4v8" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
      <path d="M24 4l9 3-9 3z" fill="currentColor" />
      <path d="M8 22L24 12l16 10z" fill="currentColor" />
      <path
        d="M12 22v18M36 22v18M12 30h24M10 40h28"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <path d="M18 30l6 10 6-10" stroke="currentColor" strokeWidth={2} fill="none" />
    </svg>
  );
}

type IconComponent = LucideIcon | ((props: IconProps) => React.ReactElement);

/** 祭りの種類の紋章 */
export const CATEGORY_ICON: Record<string, IconComponent> = {
  fireworks: Sparkles,
  float: Landmark,
  mikoshi: ToriiIcon,
  dance: Music,
  fire: Flame,
  lantern: LanternIcon,
  performing_arts: Drama,
  ritual: ToriiIcon,
  market: Store,
  other: PartyPopper,
};

/** 祭りの種類の紋章の色 */
export const CATEGORY_TONE: Record<string, string> = {
  fireworks: "from-[#3a2a6b] to-[#6a4bb1]",
  float: "from-[#7d2b1e] to-[#c2462c]",
  mikoshi: "from-[#8a1f1f] to-[#d0482f]",
  dance: "from-[#1f5a4a] to-[#2f8f72]",
  fire: "from-[#8a2a0a] to-[#e2661d]",
  lantern: "from-[#a3471a] to-[#e9a23b]",
  performing_arts: "from-[#4a2a5e] to-[#8a4f9e]",
  ritual: "from-[#8a1f1f] to-[#c2462c]",
  market: "from-[#3d5a2a] to-[#76a34a]",
  other: "from-[#213c63] to-[#3a5a8c]",
};

/** 旅程の予定のアイコン（移動は手段ごと） */
export function itemIcon(item: ItineraryItem): IconComponent {
  switch (item.type) {
    case "move":
      switch (item.move?.means) {
        case "walk":
          return Footprints;
        case "bus":
          return Bus;
        case "car":
        case "taxi":
          return Car;
        default:
          return TrainFront;
      }
    case "sightseeing":
      return Landmark;
    case "meal":
      return UtensilsCrossed;
    case "rest":
      return Coffee;
    case "festival_prep":
      return ClipboardList;
    case "festival":
      return LanternIcon;
  }
}
