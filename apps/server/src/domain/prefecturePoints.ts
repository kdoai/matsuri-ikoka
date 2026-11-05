import type { LatLng, Prefecture } from "@matsuri-ikoka/schema";
import { distanceKm } from "./lodging";

// 都道府県の代表の位置。寄りたい場所を県で言われたときの、移動の見積もりに使う。
// 県庁所在地の中心駅の位置で、data/stations/points.json（国土数値情報の鉄道データ、出典は docs/stations.md）から写した。
// その県の祭りの会場は使わない（祭りのデータが増えると、代表の位置が変わってしまうため）。

export const PREFECTURE_POINTS: Readonly<Record<Prefecture, LatLng>> = {
  北海道: { lat: 43.0688, lng: 141.3527 }, // 札幌
  青森県: { lat: 40.8291, lng: 140.7341 }, // 青森
  岩手県: { lat: 39.6997, lng: 141.138 }, // 盛岡
  宮城県: { lat: 38.2591, lng: 140.8803 }, // 仙台
  秋田県: { lat: 39.7184, lng: 140.1295 }, // 秋田
  山形県: { lat: 38.2492, lng: 140.3279 }, // 山形
  福島県: { lat: 37.7534, lng: 140.4601 }, // 福島
  茨城県: { lat: 36.371, lng: 140.4788 }, // 水戸
  栃木県: { lat: 36.5569, lng: 139.8976 }, // 宇都宮
  群馬県: { lat: 36.3837, lng: 139.0747 }, // 前橋
  埼玉県: { lat: 35.8578, lng: 139.6576 }, // 浦和
  千葉県: { lat: 35.6116, lng: 140.1137 }, // 千葉
  東京都: { lat: 35.683, lng: 139.7681 }, // 東京
  神奈川県: { lat: 35.4669, lng: 139.6228 }, // 横浜
  新潟県: { lat: 37.9118, lng: 139.0594 }, // 新潟
  富山県: { lat: 36.702, lng: 137.2132 }, // 富山
  石川県: { lat: 36.5793, lng: 136.6486 }, // 金沢
  福井県: { lat: 36.0622, lng: 136.2223 }, // 福井
  山梨県: { lat: 35.6666, lng: 138.5699 }, // 甲府
  長野県: { lat: 36.6441, lng: 138.1886 }, // 長野
  岐阜県: { lat: 35.4097, lng: 136.7546 }, // 岐阜
  静岡県: { lat: 34.9728, lng: 138.3916 }, // 静岡
  愛知県: { lat: 35.1698, lng: 136.882 }, // 名古屋
  三重県: { lat: 34.7334, lng: 136.5108 }, // 津
  滋賀県: { lat: 35.0029, lng: 135.8668 }, // 大津
  京都府: { lat: 34.9862, lng: 135.7599 }, // 京都
  大阪府: { lat: 34.7029, lng: 135.4972 }, // 大阪
  兵庫県: { lat: 34.6806, lng: 135.1784 }, // 神戸
  奈良県: { lat: 34.6794, lng: 135.8183 }, // 奈良
  和歌山県: { lat: 34.2316, lng: 135.1916 }, // 和歌山
  鳥取県: { lat: 35.4937, lng: 134.2272 }, // 鳥取
  島根県: { lat: 35.4643, lng: 133.0652 }, // 松江
  岡山県: { lat: 34.6684, lng: 133.919 }, // 岡山
  広島県: { lat: 34.3966, lng: 132.475 }, // 広島
  山口県: { lat: 34.1733, lng: 131.4816 }, // 山口
  徳島県: { lat: 34.074, lng: 134.5525 }, // 徳島
  香川県: { lat: 34.3501, lng: 134.0442 }, // 高松
  愛媛県: { lat: 33.8407, lng: 132.7509 }, // 松山
  高知県: { lat: 33.5669, lng: 133.5445 }, // 高知
  福岡県: { lat: 33.591, lng: 130.4206 }, // 博多
  佐賀県: { lat: 33.2644, lng: 130.2991 }, // 佐賀
  長崎県: { lat: 32.7513, lng: 129.8687 }, // 長崎
  熊本県: { lat: 32.7879, lng: 130.6877 }, // 熊本
  大分県: { lat: 33.2323, lng: 131.6073 }, // 大分
  宮崎県: { lat: 31.915, lng: 131.4321 }, // 宮崎
  鹿児島県: { lat: 31.584, lng: 130.5395 }, // 鹿児島中央
  沖縄県: { lat: 26.2142, lng: 127.6792 }, // 県庁前
};

/** 都道府県のうち、その地点の代表の位置がいちばん近いもの */
export function nearestPrefecture(
  point: LatLng,
  among: readonly Prefecture[] = Object.keys(PREFECTURE_POINTS) as Prefecture[],
): Prefecture | null {
  let best: Prefecture | null = null;
  let bestKm = Number.POSITIVE_INFINITY;
  for (const prefecture of among) {
    const km = distanceKm(point, PREFECTURE_POINTS[prefecture]);
    if (km < bestKm) {
      best = prefecture;
      bestKm = km;
    }
  }
  return best;
}
