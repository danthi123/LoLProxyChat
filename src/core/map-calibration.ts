export interface MinimapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getMinimapBounds(screenWidth: number, screenHeight: number): MinimapBounds {
  // Capture a generous bottom-right region that contains the minimap
  // regardless of HUD scale. The minimap is always in the bottom-right
  // and can be up to ~30% of screen height at max HUD scale.
  const captureSize = Math.round(screenHeight * 0.35);
  return {
    x: screenWidth - captureSize,
    y: screenHeight - captureSize,
    width: captureSize,
    height: captureSize,
  };
}
