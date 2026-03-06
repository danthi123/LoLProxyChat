import { Player, MapType } from '../core/types';
import { isStreamerMode } from '../core/streamer-detect';
import { generateRoomId } from '../core/room';

export interface GameSession {
  roomId: string;
  localPlayer: Player;
  allPlayers: Player[];
  eligiblePlayers: Player[]; // excludes streamers
  mapType: MapType;
  gameMode: string;
}

export class GameStateService {
  private session: GameSession | null = null;

  parsePlayerList(liveClientData: any): Player[] {
    if (!liveClientData?.players) return [];
    return liveClientData.players.map((p: any) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team === 'ORDER' ? 'ORDER' : 'CHAOS',
      isDead: p.isDead ?? false,
      respawnTimer: p.respawnTimer ?? 0,
    }));
  }

  createSession(
    allPlayers: Player[],
    localSummonerName: string,
    gameMode: string,
  ): GameSession | null {
    const localPlayer = allPlayers.find(
      (p) => p.summonerName === localSummonerName,
    );
    if (!localPlayer) return null;

    if (isStreamerMode(localPlayer)) {
      console.log('Local player has streamer mode on - not joining proximity chat');
      return null;
    }

    const eligiblePlayers = allPlayers.filter((p) => !isStreamerMode(p));
    const playerNames = allPlayers.map((p) => p.summonerName);
    const roomId = generateRoomId(playerNames);

    const mapType = this.detectMapType(gameMode);

    this.session = {
      roomId,
      localPlayer,
      allPlayers,
      eligiblePlayers,
      mapType,
      gameMode,
    };

    return this.session;
  }

  getSession(): GameSession | null {
    return this.session;
  }

  clearSession(): void {
    this.session = null;
  }

  private detectMapType(gameMode: string): MapType {
    const mode = gameMode.toLowerCase();
    if (mode.includes('aram') || mode.includes('howling')) return 'howling_abyss';
    if (mode.includes('classic') || mode.includes('ranked') || mode.includes('normal'))
      return 'summoners_rift';
    return 'unknown';
  }
}
