import { GameStateService } from '../../src/services/game-state';
import { generateRoomId } from '../../src/core/room';
import { calculateDistance, calculateVolume, isInRange } from '../../src/core/proximity';
import { Player } from '../../src/core/types';

describe('Session flow integration', () => {
  const mockPlayers: Player[] = [
    { summonerName: 'Player1', championName: 'Ahri', team: 'ORDER', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player2', championName: 'Zed', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Jinx', championName: 'Jinx', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player4', championName: 'Lux', team: 'ORDER', isDead: false, respawnTimer: 0 },
  ];

  it('creates a session excluding streamer mode players', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Player1', 'CLASSIC');

    expect(session).not.toBeNull();
    expect(session!.eligiblePlayers).toHaveLength(3);
    expect(session!.eligiblePlayers.find(p => p.summonerName === 'Jinx')).toBeUndefined();
  });

  it('returns null session if local player is in streamer mode', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Jinx', 'CLASSIC');
    expect(session).toBeNull();
  });

  it('generates same room ID for all players in the same game', () => {
    const names = mockPlayers.map(p => p.summonerName);
    const id1 = generateRoomId(names);
    const id2 = generateRoomId([...names].reverse());
    expect(id1).toBe(id2);
  });

  it('proximity chain: distance -> volume -> range check', () => {
    const posA = { x: 5000, y: 5000 };
    const posB = { x: 5500, y: 5000 };

    const dist = calculateDistance(posA, posB);
    expect(dist).toBe(500);
    expect(isInRange(dist)).toBe(true);

    const vol = calculateVolume(dist);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });

  it('far away players are out of range', () => {
    const posA = { x: 1000, y: 1000 };
    const posB = { x: 5000, y: 5000 };

    const dist = calculateDistance(posA, posB);
    expect(isInRange(dist)).toBe(false);
    expect(calculateVolume(dist)).toBe(0);
  });
});
