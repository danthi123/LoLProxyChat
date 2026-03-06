import { Player } from './types';

export function isStreamerMode(player: Player): boolean {
  return player.summonerName.toLowerCase() === player.championName.toLowerCase();
}
