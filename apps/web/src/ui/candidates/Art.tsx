import { CATEGORY_ICON, CATEGORY_TONE, LanternIcon } from "../icons";

// 祭りの候補の画面の絵。どれもこのアプリのために図形で描いたもので、祭りの写真や他所の画像は使わない。
// 飾りなので読み上げない（中身は文字で別に出す）。動きは付けない。

const LANTERN_GLOW = "#f6c453";

/** 灯りの連なり（ゆるく垂れた綱に、丸い提灯を下げる） */
function LanternString({ width, y, count }: { width: number; y: number; count: number }) {
  const step = width / (count + 1);
  return (
    <g>
      <path
        d={`M0 ${y} Q${width / 2} ${y + 14} ${width} ${y}`}
        stroke="rgb(255 255 255 / 0.45)"
        strokeWidth={1}
        fill="none"
      />
      {Array.from({ length: count }, (_, index) => {
        const x = step * (index + 1);
        // 綱のたるみ（2次ベジエ）に合わせて下げる
        const t = x / width;
        const sag = 2 * t * (1 - t) * 14;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 提灯は位置そのもの
          <g key={index}>
            <circle cx={x} cy={y + sag + 7} r={9} fill={LANTERN_GLOW} opacity={0.25} />
            <ellipse cx={x} cy={y + sag + 7} rx={4.5} ry={5.5} fill={LANTERN_GLOW} />
            <path
              d={`M${x - 4.5} ${y + sag + 7}h9`}
              stroke="#b5481f"
              strokeWidth={0.8}
              opacity={0.6}
            />
          </g>
        );
      })}
    </g>
  );
}

/** 祭りの種類ごとの絵：種類の色・山並み・灯り・紋の図柄。種類の名前を札で出す */
export function ThemeArt({ category, label }: { category: string; label: string | null }) {
  const Emblem = CATEGORY_ICON[category] ?? LanternIcon;
  const tone = CATEGORY_TONE[category] ?? CATEGORY_TONE.other;
  return (
    <div
      className={`relative h-36 overflow-hidden rounded-[0.8rem] bg-gradient-to-br ${tone} text-kinari-50 md:h-auto md:min-h-40 md:w-64 md:shrink-0`}
      data-testid="theme-art"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 256 160"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 size-full"
      >
        {category === "fireworks" ? (
          <g stroke={LANTERN_GLOW} strokeWidth={1.5} strokeLinecap="round" opacity={0.8}>
            {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
              <path key={angle} d="M0 -8v-14" transform={`translate(78 48) rotate(${angle})`} />
            ))}
          </g>
        ) : (
          <LanternString width={256} y={14} count={7} />
        )}
        <path
          d="M0 120 L40 92 L72 110 L116 78 L160 108 L204 86 L256 112 V160 H0 Z"
          fill="rgb(0 0 0 / 0.18)"
        />
        <path d="M0 138 Q128 124 256 138 V160 H0 Z" fill="rgb(0 0 0 / 0.22)" />
      </svg>
      <span aria-hidden="true" className="absolute right-3 bottom-2 text-kinari-50/35">
        <Emblem className="size-24" />
      </span>
      {label === null ? null : (
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border-2 border-kinari-50/80 bg-ink/45 px-2.5 py-0.5 font-bold text-kinari-50 text-sm">
          <Emblem className="size-4" />
          {label}
        </span>
      )}
    </div>
  );
}

/** 上の帯：夜の山並みに、ちょうちん・家並み・鳥居・花火 */
export function FestivalBand({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 600 96"
      preserveAspectRatio="xMidYMax slice"
      className={className}
      data-testid="festival-band"
    >
      <path
        d="M0 96 L0 70 Q60 30 120 52 Q180 18 250 44 Q320 10 390 40 Q460 16 530 46 Q570 34 600 50 L600 96 Z"
        fill="#1a2f4e"
      />
      {/* 花火 */}
      {[
        [210, 30],
        [430, 24],
      ].map(([cx, cy]) => (
        <g key={cx} stroke={LANTERN_GLOW} strokeWidth={1.4} strokeLinecap="round" opacity={0.85}>
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((angle) => (
            <path key={angle} d="M0 -4v-9" transform={`translate(${cx} ${cy}) rotate(${angle})`} />
          ))}
        </g>
      ))}
      {/* 家並み（窓に灯り） */}
      {[60, 150, 270, 480, 540].map((x) => (
        <g key={x}>
          <path d={`M${x} 96 V80 L${x + 14} 70 L${x + 28} 80 V96 Z`} fill="#13223a" />
          <rect x={x + 8} y={83} width={5} height={4} fill={LANTERN_GLOW} />
          <rect x={x + 16} y={83} width={5} height={4} fill={LANTERN_GLOW} />
        </g>
      ))}
      {/* 鳥居 */}
      <g fill="#d0482f">
        <path d="M340 58 Q370 62 400 58 L400 63 Q370 66 340 63 Z" />
        <rect x={346} y={68} width={48} height={4} />
        <rect x={350} y={62} width={5} height={34} />
        <rect x={385} y={62} width={5} height={34} />
      </g>
      <LanternString width={600} y={6} count={9} />
    </svg>
  );
}
