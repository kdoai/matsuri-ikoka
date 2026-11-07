/** 非同期の応答のうち、いちばん新しい頼みの分だけを受け取るための札 */
export function latestOnly(): { next(): number; isCurrent(ticket: number): boolean } {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(ticket) {
      return ticket === current;
    },
  };
}
