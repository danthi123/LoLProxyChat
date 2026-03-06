import { GEPService } from '../services/gep';
import { GameStateService } from '../services/game-state';

const gep = new GEPService();
const gameState = new GameStateService();

let localSummonerName = '';

function onGameEvent(name: string, data: any): void {
  console.log('Game event: ' + name, data);

  if (name === 'matchEnd' || name === 'match_end') {
    console.log('Match ended - cleaning up session');
    gameState.clearSession();
  }
}

function onInfoUpdate(info: any): void {
  if (info.feature === 'live_client_data' && info.info?.live_client_data?.all_players) {
    try {
      const playersData = JSON.parse(info.info.live_client_data.all_players);
      const players = gameState.parsePlayerList({ players: playersData });

      if (players.length > 0 && !gameState.getSession()) {
        if (info.info.live_client_data.active_player) {
          const activePlayer = JSON.parse(info.info.live_client_data.active_player);
          localSummonerName = activePlayer.summonerName || '';
        }

        const gameMode = info.info.live_client_data.game_data
          ? JSON.parse(info.info.live_client_data.game_data).gameMode || 'CLASSIC'
          : 'CLASSIC';

        const session = gameState.createSession(players, localSummonerName, gameMode);
        if (session) {
          console.log('Session created: room=' + session.roomId + ', players=' + session.eligiblePlayers.length);
        }
      }
    } catch (e) {
      console.error('Failed to parse player data:', e);
    }
  }
}

overwolf.games.onGameInfoUpdated.addListener((event) => {
  if (event.gameInfo?.isRunning && event.gameInfo.classId === 5426) {
    console.log('League of Legends detected - starting GEP');
    gep.start(onGameEvent, onInfoUpdate);
  }
});

overwolf.games.getRunningGameInfo((result) => {
  if (result?.classId === 5426) {
    console.log('League of Legends already running - starting GEP');
    gep.start(onGameEvent, onInfoUpdate);
  }
});

console.log('LoLProxChat background service started');
