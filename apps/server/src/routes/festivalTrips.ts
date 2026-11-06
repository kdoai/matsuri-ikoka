import {
  type AnchorPlan,
  type AnchorPlanRequest,
  AnchorPlanRequestSchema,
} from "@matsuri-ikoka/schema";
import { computeAnchorPlan, refuseAnchor } from "../domain/anchorPlan";
import type { Session } from "../session/sessionStore";
import { type ChatDeps, pastCheckDay, todayOf } from "./chat";
import { apiError } from "./errors";
import type { SecureRoutes } from "./policy";

// 祭りを決めたあとの旅の組み立てを、旅程を組む前の確認の画面に返す（モデルは呼ばない）。
// 確認の画面で選んだ出発地・泊数・寄りたい場所は、そのあとの発言で旅程を組むときにも使うので、相談の状態に残す。
// 組み立ては公開の祭りのデータだけから計算するので、相談が見つからなくても返す。ほかの人の相談は見つからないものと同じに扱い、何も残さない。

/** 確認の画面で選んだ条件を、相談の条件に書き足す */
function rememberChoices(session: Session, request: AnchorPlanRequest): void {
  const { conditions } = session;
  session.conditions = {
    ...conditions,
    origin: request.origin,
    nights: request.nights,
    ...(request.pace === undefined ? {} : { pace: request.pace }),
    ...(request.wishes.length === 0 && conditions.route === undefined
      ? {}
      : { route: { shape: conditions.route?.shape ?? "auto", areas: request.wishes } }),
  };
}

export function registerFestivalTripRoutes(
  routes: SecureRoutes,
  deps: Pick<ChatDeps, "festivals" | "persistence" | "stations" | "today" | "runner">,
) {
  routes.consultation("POST", "/api/festival-trips/preview", async (c, { open }) => {
    const parsed = AnchorPlanRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json(apiError("bad_request", "送った内容の形が正しくありません。", false), 400);
    }
    const request = parsed.data;
    const festival = deps.festivals.get(request.anchor.festivalId);
    const refusal = refuseAnchor(festival, request.anchor.date, pastCheckDay(deps));
    if (refusal !== null || festival === undefined) {
      return c.json(
        apiError("bad_request", refusal?.message ?? "祭りが見つかりません。", false),
        refusal?.status ?? 404,
      );
    }
    const plan: AnchorPlan = computeAnchorPlan(
      {
        festival,
        anchor: request.anchor,
        origin: request.origin,
        nights: request.nights,
        wishes: request.wishes,
        pace: request.pace,
        today: todayOf(deps),
      },
      deps.stations,
    );
    const session = await open(request.sessionId);
    if (session !== undefined && !session.busy) {
      rememberChoices(session, request);
      await deps.persistence.saveSession(session);
    }
    return c.json(plan);
  });
}
