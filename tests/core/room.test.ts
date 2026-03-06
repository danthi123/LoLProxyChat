import { generateRoomId } from '../../src/core/room';

describe('generateRoomId', () => {
  it('should return a non-empty string', () => {
    const result = generateRoomId(['Alice', 'Bob']);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should be deterministic (same input produces same output)', () => {
    const names = ['Alice', 'Bob', 'Charlie'];
    const result1 = generateRoomId(names);
    const result2 = generateRoomId(names);
    expect(result1).toBe(result2);
  });

  it('should be order-independent', () => {
    const result1 = generateRoomId(['A', 'B']);
    const result2 = generateRoomId(['B', 'A']);
    expect(result1).toBe(result2);
  });

  it('should produce different hashes for different inputs', () => {
    const result1 = generateRoomId(['Alice', 'Bob']);
    const result2 = generateRoomId(['Charlie', 'Dave']);
    expect(result1).not.toBe(result2);
  });

  it('should handle a single player name', () => {
    const result = generateRoomId(['Solo']);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('should handle many player names', () => {
    const names = Array.from({ length: 10 }, (_, i) => `Player${i}`);
    const result = generateRoomId(names);
    expect(result).toBeTruthy();
  });

  it('should not mutate the input array', () => {
    const names = ['Charlie', 'Alice', 'Bob'];
    const copy = [...names];
    generateRoomId(names);
    expect(names).toEqual(copy);
  });
});
