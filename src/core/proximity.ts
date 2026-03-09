import { Position, MAX_HEARING_RANGE } from './types';

export function calculateDistance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - Math.log1p(normalized * (Math.E - 1)));
}

export function isInRange(distance: number): boolean {
  return distance <= MAX_HEARING_RANGE;
}
