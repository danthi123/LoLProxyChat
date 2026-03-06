export function generateRoomId(playerNames: string[]): string {
  const sorted = [...playerNames].sort();
  const combined = sorted.join('|');
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
