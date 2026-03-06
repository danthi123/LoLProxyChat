import { Position, MapType, MAP_DIMENSIONS } from './types';

export interface MinimapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getMinimapBounds(screenWidth: number, screenHeight: number): MinimapBounds {
  const minimapSize = Math.round(screenHeight * 0.237); // ~256px at 1080p
  return {
    x: screenWidth - minimapSize - Math.round(screenWidth * 0.005),
    y: screenHeight - minimapSize - Math.round(screenHeight * 0.005),
    width: minimapSize,
    height: minimapSize,
  };
}

export function pixelToGameUnits(
  pixelX: number,
  pixelY: number,
  mapType: MapType,
  minimapSize: { width: number; height: number },
): Position {
  const dims = MAP_DIMENSIONS[mapType];
  return {
    x: (pixelX / minimapSize.width) * dims.width,
    y: dims.height - (pixelY / minimapSize.height) * dims.height,
  };
}
