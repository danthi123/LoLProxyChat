import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, pixelToGameUnits, MinimapBounds } from '../core/map-calibration';

export class MinimapCVService {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bounds: MinimapBounds;
  private mapType: MapType;
  private intervalId: number | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;
  private lastImageData: ImageData | null = null;

  // Local player icon on minimap has a distinct cyan/teal circle
  private readonly LOCAL_PLAYER_HUE_MIN = 150;
  private readonly LOCAL_PLAYER_HUE_MAX = 200;
  private readonly LOCAL_PLAYER_SAT_MIN = 0.4;
  private readonly LOCAL_PLAYER_VAL_MIN = 0.5;

  constructor(screenWidth: number, screenHeight: number, mapType: MapType) {
    this.bounds = getMinimapBounds(screenWidth, screenHeight);
    this.mapType = mapType;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bounds.width;
    this.canvas.height = this.bounds.height;
    this.ctx = this.canvas.getContext('2d')!;
  }

  start(onPositionUpdate: (pos: Position) => void, fps: number = 4): void {
    this.onPositionUpdate = onPositionUpdate;
    const intervalMs = Math.round(1000 / fps);

    this.intervalId = window.setInterval(() => {
      this.captureAndAnalyze();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private captureAndAnalyze(): void {
    overwolf.media.takeScreenshot((result: any) => {
      if (!result.success || !result.url) return;

      const img = new Image();
      img.onload = () => {
        this.ctx.drawImage(
          img,
          this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height,
          0, 0, this.bounds.width, this.bounds.height,
        );
        this.lastImageData = this.ctx.getImageData(0, 0, this.bounds.width, this.bounds.height);
        const position = this.findLocalPlayerIcon();
        if (position && this.onPositionUpdate) {
          this.onPositionUpdate(position);
        }
      };
      img.src = result.url;
    });
  }

  private findLocalPlayerIcon(): Position | null {
    if (!this.lastImageData) return null;
    const pixels = this.lastImageData.data;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let y = 0; y < this.bounds.height; y++) {
      for (let x = 0; x < this.bounds.width; x++) {
        const i = (y * this.bounds.width + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (this.isLocalPlayerColor(r, g, b)) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count < 5) return null;

    const centerX = sumX / count;
    const centerY = sumY / count;

    return pixelToGameUnits(centerX, centerY, this.mapType, {
      width: this.bounds.width,
      height: this.bounds.height,
    });
  }

  private isLocalPlayerColor(r: number, g: number, b: number): boolean {
    const rN = r / 255;
    const gN = g / 255;
    const bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === rN) hue = 60 * (((gN - bN) / delta) % 6);
      else if (max === gN) hue = 60 * ((bN - rN) / delta + 2);
      else hue = 60 * ((rN - gN) / delta + 4);
    }
    if (hue < 0) hue += 360;

    const saturation = max === 0 ? 0 : delta / max;
    const value = max;

    return (
      hue >= this.LOCAL_PLAYER_HUE_MIN &&
      hue <= this.LOCAL_PLAYER_HUE_MAX &&
      saturation >= this.LOCAL_PLAYER_SAT_MIN &&
      value >= this.LOCAL_PLAYER_VAL_MIN
    );
  }

  /**
   * Check if a specific enemy champion icon is visible on the minimap.
   * Enemy icons are red-tinted.
   */
  isEnemyVisibleOnMinimap(expectedPosition: Position): boolean {
    if (!this.lastImageData) return false;

    const dims = MAP_DIMENSIONS[this.mapType];
    const px = (expectedPosition.x / dims.width) * this.bounds.width;
    const py = this.bounds.height - (expectedPosition.y / dims.height) * this.bounds.height;

    const searchRadius = 12;
    const pixels = this.lastImageData.data;
    let redCount = 0;

    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const x = Math.round(px + dx);
        const y = Math.round(py + dy);
        if (x < 0 || x >= this.bounds.width || y < 0 || y >= this.bounds.height) continue;

        const i = (y * this.bounds.width + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (r > 180 && g < 100 && b < 100) {
          redCount++;
        }
      }
    }

    return redCount > 8;
  }
}
