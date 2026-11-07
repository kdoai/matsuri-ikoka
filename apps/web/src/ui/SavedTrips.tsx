import type { TripSummary } from "@matsuri-ikoka/schema";
import { useEffect, useState } from "react";
import { useAccountClient } from "../account/context";
import { useActions, useT } from "../state/react";
import { buttonSecondary } from "./common";

// 店の外観に出す、残した旅の入口。ログインしていて旅を残してあれば、そこから縁日の通りへ戻れる。
// ログインを用意していないとき・ログインしていないときは何も出さない。

export function SavedTrips() {
  const t = useT();
  const actions = useActions();
  const client = useAccountClient();
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (client === null) return;
    let active = true;
    const stop = client.onUser((user) => {
      if (user === null) {
        setTrips([]);
        return;
      }
      client.listTrips().then(
        (list) => {
          if (active) setTrips(list);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      stop();
    };
  }, [client]);

  if (trips.length === 0) return null;
  return (
    <section className="mx-auto mt-5 max-w-md" data-testid="saved-trips">
      <h2 className="font-bold text-ink">{t.street.savedTitle}</h2>
      <ul className="mt-1 grid gap-1.5">
        {trips.slice(0, 3).map((trip) => (
          <li key={trip.itineraryId}>
            <button
              type="button"
              className={`${buttonSecondary} w-full`}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setFailed(false);
                void actions.openSavedTrip(trip.itineraryId).then((opened) => {
                  setBusy(false);
                  setFailed(!opened);
                });
              }}
            >
              {t.street.savedOpen(trip.title)}
            </button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="mt-1 text-shu-700 text-sm">
          {t.street.savedFailed}
        </p>
      ) : null}
    </section>
  );
}
