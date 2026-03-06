import { isStreamerMode } from '../../src/core/streamer-detect';
import { Player } from '../../src/core/types';

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    summonerName: 'TestPlayer',
    championName: 'Ahri',
    team: 'ORDER',
    isDead: false,
    respawnTimer: 0,
    ...overrides,
  };
}

describe('isStreamerMode', () => {
  it('should return true when summoner name matches champion name', () => {
    const player = makePlayer({ summonerName: 'Ahri', championName: 'Ahri' });
    expect(isStreamerMode(player)).toBe(true);
  });

  it('should return false when names differ', () => {
    const player = makePlayer({ summonerName: 'TestPlayer', championName: 'Ahri' });
    expect(isStreamerMode(player)).toBe(false);
  });

  it('should be case-insensitive', () => {
    const player = makePlayer({ summonerName: 'AHRI', championName: 'ahri' });
    expect(isStreamerMode(player)).toBe(true);
  });

  it('should handle mixed case', () => {
    const player = makePlayer({ summonerName: 'AhRi', championName: 'aHrI' });
    expect(isStreamerMode(player)).toBe(true);
  });
});
