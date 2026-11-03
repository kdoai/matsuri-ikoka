// 入店のカメラは、ページを開いてから1回だけ流す（しおりから店内に戻ったときは流さない）。

let played = false;

export function shouldPlayEntry(): boolean {
  return !played;
}

export function markEntryPlayed(): void {
  played = true;
}
