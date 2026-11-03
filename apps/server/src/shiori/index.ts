import { loadShioriAssets, type ShioriAsset, type ShioriAssets } from "./assets";
import {
  ChromiumPdfEngine,
  type PdfEngine,
  pdfCacheKey,
  readShioriPdfConfig,
  type ShioriPdfConfig,
  ShioriPdfService,
} from "./pdf";
import { renderShioriHtml } from "./render";
import { type ShioriTrip, toShioriTrip } from "./trip";
import { buildShioriView, type FestivalLookup } from "./viewModel";

export { ShioriPdfBusyError, ShioriPdfTimeoutError } from "./pdf";

/** 旅のしおり：旅程から HTML と PDF を作る */
export interface Shiori {
  html(
    trip: ShioriTrip,
    lookup: FestivalLookup,
    options: { pdfHref: string | null },
  ): Promise<string>;
  pdf(trip: ShioriTrip, lookup: FestivalLookup): Promise<Buffer>;
  /** /shiori/assets/ の下のファイル */
  asset(path: string): ShioriAsset | undefined;
  close(): Promise<void>;
}

export interface ShioriOptions {
  assets?: ShioriAssets;
  engine?: PdfEngine;
  config?: ShioriPdfConfig;
}

export function createShiori(options: ShioriOptions = {}): Shiori {
  const config = options.config ?? readShioriPdfConfig();
  let assets = options.assets;
  let service: ShioriPdfService | undefined;
  const getAssets = () => {
    assets ??= loadShioriAssets();
    return assets;
  };
  const getService = () => {
    service ??= new ShioriPdfService(
      options.engine ?? new ChromiumPdfEngine({ executablePath: config.executablePath }),
      getAssets().files,
      config,
    );
    return service;
  };
  const html = async (trip: ShioriTrip, lookup: FestivalLookup, pdfHref: string | null) =>
    String(await renderShioriHtml(buildShioriView(trip, lookup), getAssets(), { pdfHref }));

  return {
    html: (trip, lookup, { pdfHref }) => html(trip, lookup, pdfHref),
    async pdf(trip, lookup) {
      const page = await html(trip, lookup, null);
      return getService().get({ key: pdfCacheKey(trip.id, trip.version, page), html: page });
    },
    asset: (path) => getAssets().files.get(path),
    close: async () => {
      await service?.close();
    },
  };
}

export { toShioriTrip };
