// 入店のカメラは、店に入るたびに1回流す（しおりから店内に戻ったときは流さない）。

let played = false;

export function shouldPlayEntry(): boolean {
  return !played;
}

export function markEntryPlayed(): void {
  played = true;
}

/** 店の外へ出たら、次に入るときにまた入店のカメラを流す */
export function resetEntry(): void {
  played = false;
}
