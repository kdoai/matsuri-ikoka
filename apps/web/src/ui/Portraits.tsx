import type { StaffId } from "@matsuri-ikoka/schema";

// 会話の窓に出す顔の絵。3D のスタッフ（ひよこ・フクロウ・にわとり・スズメ）と旅人のペンギンを、
// 丸い枠に収まる簡単な絵にしたもの。どれもこのアプリのために描いた形で、飾りなので読み上げない。

export type Speaker = StaffId | "player";

function Eyes({ y = 52, gap = 14, size = 4.2 }: { y?: number; gap?: number; size?: number }) {
  return (
    <>
      <circle cx={50 - gap} cy={y} r={size} fill="#2b2118" />
      <circle cx={50 + gap} cy={y} r={size} fill="#2b2118" />
      <circle cx={50 - gap + 1.4} cy={y - 1.5} r={1.3} fill="#fff" />
      <circle cx={50 + gap + 1.4} cy={y - 1.5} r={1.3} fill="#fff" />
    </>
  );
}

function Cheeks({ y = 62 }: { y?: number }) {
  return (
    <>
      <ellipse cx={28} cy={y} rx={6} ry={3.6} fill="#f39a8c" opacity={0.7} />
      <ellipse cx={72} cy={y} rx={6} ry={3.6} fill="#f39a8c" opacity={0.7} />
    </>
  );
}

function Happi({ color = "#213c63" }: { color?: string }) {
  return (
    <path d="M14 100 C18 80 32 76 50 76 C68 76 82 80 86 100 Z" fill={color} stroke="#13223a" />
  );
}

const FACES: Record<Speaker, () => React.ReactElement> = {
  concierge: () => (
    <>
      <Happi />
      <path d="M44 22 C46 12 52 12 54 20 C58 14 62 18 58 24" fill="#f7cf4b" />
      <circle cx={50} cy={50} r={30} fill="#fbd84f" stroke="#e2b52c" strokeWidth={1.5} />
      <Eyes />
      <Cheeks />
      <path d="M43 60 L57 60 L50 67 Z" fill="#f08a2b" />
    </>
  ),
  researcher: () => (
    <>
      <Happi />
      <path d="M22 30 L30 18 L38 28 Z M62 28 L70 18 L78 30 Z" fill="#8a5a35" />
      <circle cx={50} cy={50} r={31} fill="#9c6939" />
      <ellipse cx={50} cy={56} rx={22} ry={18} fill="#e9d2ad" />
      <circle cx={38} cy={50} r={9} fill="#fff" stroke="#2b2118" strokeWidth={2} />
      <circle cx={62} cy={50} r={9} fill="#fff" stroke="#2b2118" strokeWidth={2} />
      <path d="M47 50 L53 50" stroke="#2b2118" strokeWidth={2} />
      <circle cx={38} cy={50} r={3.6} fill="#2b2118" />
      <circle cx={62} cy={50} r={3.6} fill="#2b2118" />
      <path d="M46 60 L54 60 L50 67 Z" fill="#e2a03f" />
    </>
  ),
  scout: () => (
    <>
      <Happi color="#2c4a78" />
      <path d="M40 22 C40 12 48 12 50 20 C52 10 60 12 58 22 C64 16 68 22 60 26 Z" fill="#d83a2c" />
      <circle cx={50} cy={50} r={30} fill="#fbf7ef" stroke="#e5ddcf" strokeWidth={1.5} />
      <Eyes />
      <Cheeks />
      <path d="M44 59 L56 59 L50 66 Z" fill="#f0a531" />
      <path d="M47 67 C47 73 53 73 53 67 Z" fill="#d83a2c" />
    </>
  ),
  planner: () => (
    <>
      <Happi />
      <circle cx={50} cy={52} r={29} fill="#8b5e3c" />
      <ellipse cx={50} cy={60} rx={20} ry={15} fill="#efe1c8" />
      <path d="M24 34 C26 20 74 20 76 34 L76 38 L24 38 Z" fill="#1a2f4e" />
      <rect x={20} y={36} width={60} height={6} rx={3} fill="#13223a" />
      <circle cx={50} cy={29} r={4} fill="#e9b528" />
      <Eyes y={53} />
      <path d="M45 60 L55 60 L50 66 Z" fill="#3d342b" />
    </>
  ),
  player: () => (
    <>
      <path d="M14 100 C18 82 32 78 50 78 C68 78 82 82 86 100 Z" fill="#2b3a52" />
      <path d="M30 80 C40 86 60 86 70 80 L70 88 C60 93 40 93 30 88 Z" fill="#c2462c" />
      <circle cx={50} cy={54} r={28} fill="#2b3a52" />
      <ellipse cx={50} cy={60} rx={19} ry={17} fill="#fdfaf3" />
      <ellipse cx={50} cy={30} rx={38} ry={8} fill="#e8c77a" stroke="#c9a457" />
      <path d="M30 30 C30 14 70 14 70 30 Z" fill="#efd28d" stroke="#c9a457" />
      <rect x={30} y={26} width={40} height={4} fill="#213c63" />
      <Eyes y={56} gap={11} size={3.8} />
      <path d="M45 63 L55 63 L50 69 Z" fill="#f0a531" />
    </>
  ),
};

/** 丸い枠の顔の絵 */
export function Portrait({ speaker, className = "" }: { speaker: Speaker; className?: string }) {
  const Face = FACES[speaker];
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full border-4 border-kinari-50 bg-gradient-to-b from-[#fde9b8] to-[#f3c98b] shadow-[0_4px_14px_rgb(0_0_0/0.28)] ring-2 ring-wood-700/60 ${className}`}
    >
      <svg viewBox="0 0 100 100" className="size-full" role="presentation">
        <Face />
      </svg>
    </span>
  );
}
