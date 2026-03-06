/* eslint-disable @typescript-eslint/no-var-requires */
declare const require: (module: string) => any;
declare const overwolf: any;

import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, MinimapBounds } from '../core/map-calibration';
import { normalizedCrossCorrelation, buildMask } from '../core/template-match';

export enum TrackingState {
  SCANNING = 'scanning',
  LOCKED = 'locked',
  DEAD = 'dead',
}

interface TemplateData {
  size: number;
  skins: number[][]; // each skin is a flat RGB array with -1 for masked pixels
}

interface PreparedTemplate {
  data: Int16Array;
  mask: boolean[];
}


export class TrackingService {
  private state: TrackingState = TrackingState.SCANNING;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly captureBounds: MinimapBounds;
  private mapType: MapType;
  private intervalId: number | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;

  // Template matching
  private coldStartTemplate: TemplateData | null = null;
  private preparedTemplates: PreparedTemplate[] = [];
  private trackingTemplate: Uint8ClampedArray | null = null;
  private trackingTemplateSize = 0;

  // Minimap region (detected from capture)
  private minimapRegion: { x: number; y: number; width: number; height: number } | null = null;

  // Tracking state
  private lastPixelPos: { x: number; y: number } | null = null;
  private lastPosition: Position | null = null;
  private deathPosition: Position | null = null;
  private expectedIconDiam = 0;

  // Diagnostics
  private captureCount = 0;

  constructor(screenWidth: number, screenHeight: number, mapType: MapType) {
    this.captureBounds = getMinimapBounds(screenWidth, screenHeight);
    this.mapType = mapType;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.captureBounds.width;
    this.canvas.height = this.captureBounds.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  getState(): TrackingState {
    return this.state;
  }

  getLastPosition(): Position | null {
    return this.lastPosition;
  }

  /**
   * Load the cold-start template for a champion from the bundled database.
   */
  loadChampionTemplate(championName: string): void {
    const data = require('../data/champion-fingerprints.json');
    const templateEntry = data.templates?.[championName];
    if (templateEntry) {
      this.coldStartTemplate = templateEntry;
      const numPixels = templateEntry.size * templateEntry.size;
      this.preparedTemplates = templateEntry.skins.map((skin: number[]) => ({
        data: new Int16Array(skin),
        mask: buildMask(skin, numPixels),
      }));
      console.log('[Tracking] Loaded template:', championName,
        'skins:', templateEntry.skins.length, 'size:', templateEntry.size);
    } else {
      console.warn('[Tracking] No template found for:', championName);
    }
  }

  start(onPositionUpdate: (pos: Position) => void, fps: number = 8): void {
    this.onPositionUpdate = onPositionUpdate;
    const intervalMs = Math.round(1000 / fps);
    this.intervalId = window.setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onDeath(): void {
    if (this.state === TrackingState.DEAD) return;
    this.deathPosition = this.lastPosition;
    this.state = TrackingState.DEAD;
    console.log('[Tracking] DEAD at', this.deathPosition);
  }

  onRespawn(): void {
    if (this.state !== TrackingState.DEAD) return;
    this.state = TrackingState.SCANNING;
    this.trackingTemplate = null;
    this.lastPixelPos = null;
    this.deathPosition = null;
    console.log('[Tracking] RESPAWN -> SCANNING');
  }

  private tick(): void {
    if (this.state === TrackingState.DEAD) {
      // Report frozen death position
      if (this.deathPosition && this.onPositionUpdate) {
        this.onPositionUpdate(this.deathPosition);
      }
      return;
    }

    const params = {
      roundAwayFromZero: 'true',
      crop: {
        x: this.captureBounds.x,
        y: this.captureBounds.y,
        width: this.captureBounds.width,
        height: this.captureBounds.height,
      },
    };

    (overwolf.media as any).getScreenshotUrl(params, (result: any) => {
      this.captureCount++;
      if (!result?.url) return;

      const img = new Image();
      img.onload = () => {
        this.ctx.drawImage(img, 0, 0);
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        if (!this.minimapRegion) {
          this.minimapRegion = this.detectMinimapRegion(imageData);
          if (this.minimapRegion) {
            this.expectedIconDiam = Math.round(this.minimapRegion.width * 0.087);
            console.log('[Tracking] Minimap detected:', JSON.stringify(this.minimapRegion), 'iconDiam:', this.expectedIconDiam);
          }
        }

        if (!this.minimapRegion) return;

        if (this.state === TrackingState.SCANNING) {
          this.handleScanning(imageData);
        } else if (this.state === TrackingState.LOCKED) {
          this.handleLocked(imageData);
        }
      };
      img.src = result.url;
    });
  }

  private detectMinimapRegion(imageData: ImageData): { x: number; y: number; width: number; height: number } | null {
    const { data, width, height } = imageData;
    // Find bounding box of non-black content (minimap area)
    let minX = width, maxX = 0, minY = height, maxY = 0;
    const threshold = 30; // brightness threshold to distinguish minimap from black border

    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const brightness = data[i] + data[i + 1] + data[i + 2];
        if (brightness > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX <= minX || maxY <= minY) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private handleScanning(imageData: ImageData): void {
    if (!this.coldStartTemplate || !this.minimapRegion) return;

    const region = this.minimapRegion;
    const sectorSize = this.expectedIconDiam || Math.round(region.width * 0.087);
    if (sectorSize < 5) return;

    let bestScore = -Infinity;
    let bestX = 0, bestY = 0;

    // Divide minimap into sectors and check each
    for (let sy = region.y; sy + sectorSize <= region.y + region.height; sy += Math.floor(sectorSize / 2)) {
      for (let sx = region.x; sx + sectorSize <= region.x + region.width; sx += Math.floor(sectorSize / 2)) {
        // Pre-filter: check for teal border ring
        if (!this.hasTealBorder(imageData, sx, sy, sectorSize)) continue;

        // Extract sector portrait and NCC match against cold-start templates
        const portrait = this.extractSectorPortrait(imageData, sx, sy, sectorSize);
        if (!portrait) continue;

        const templateSize = this.coldStartTemplate.size;
        const numPixels = templateSize * templateSize;
        for (const prepared of this.preparedTemplates) {
          const score = normalizedCrossCorrelation(portrait, prepared.data, prepared.mask, numPixels);

          if (score > bestScore) {
            bestScore = score;
            bestX = sx + Math.floor(sectorSize / 2);
            bestY = sy + Math.floor(sectorSize / 2);
          }
        }
      }
    }

    const SCAN_THRESHOLD = 0.5;
    if (bestScore >= SCAN_THRESHOLD) {
      // Capture tracking template from actual minimap pixels
      this.captureTrackingTemplate(imageData, bestX, bestY);
      this.lastPixelPos = { x: bestX, y: bestY };
      this.lastPosition = this.pixelToGamePosition(bestX, bestY, this.minimapRegion);
      this.state = TrackingState.LOCKED;
      console.log('[Tracking] SCANNING -> LOCKED at pixel', bestX, bestY, 'score:', bestScore.toFixed(3));

      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
    }
  }

  private hasTealBorder(imageData: ImageData, sx: number, sy: number, sectorSize: number): boolean {
    const { data, width } = imageData;
    let tealCount = 0;
    const needed = 4; // minimum teal pixels on perimeter

    // Check perimeter pixels (every 2nd pixel for speed)
    for (let i = 0; i < sectorSize; i += 2) {
      // Top and bottom edges
      for (const y of [sy, sy + sectorSize - 1]) {
        const x = sx + i;
        if (x >= width || y >= imageData.height) continue;
        const idx = (y * width + x) * 4;
        if (this.isTealPixel(data[idx], data[idx + 1], data[idx + 2])) tealCount++;
      }
      // Left and right edges
      for (const x of [sx, sx + sectorSize - 1]) {
        const y = sy + i;
        if (x >= width || y >= imageData.height) continue;
        const idx = (y * width + x) * 4;
        if (this.isTealPixel(data[idx], data[idx + 1], data[idx + 2])) tealCount++;
      }
      if (tealCount >= needed) return true;
    }
    return false;
  }

  private isTealPixel(r: number, g: number, b: number): boolean {
    // Teal: high green+blue, low red. Approximate HSV H~170-200 deg
    return r < 100 && g > 120 && b > 120 && (g + b) > 280;
  }

  private extractSectorPortrait(
    imageData: ImageData, sx: number, sy: number, sectorSize: number,
  ): Uint8Array | null {
    if (!this.coldStartTemplate) return null;
    const templateSize = this.coldStartTemplate.size;
    const portrait = new Uint8Array(templateSize * templateSize * 3);
    const { data, width } = imageData;
    const scale = sectorSize / templateSize;

    for (let ty = 0; ty < templateSize; ty++) {
      for (let tx = 0; tx < templateSize; tx++) {
        const srcX = Math.min(Math.floor(sx + tx * scale), width - 1);
        const srcY = Math.min(Math.floor(sy + ty * scale), imageData.height - 1);
        const srcIdx = (srcY * width + srcX) * 4;
        const dstIdx = (ty * templateSize + tx) * 3;
        portrait[dstIdx] = data[srcIdx];
        portrait[dstIdx + 1] = data[srcIdx + 1];
        portrait[dstIdx + 2] = data[srcIdx + 2];
      }
    }
    return portrait;
  }

  private captureTrackingTemplate(imageData: ImageData, cx: number, cy: number): void {
    const size = this.expectedIconDiam || 20;
    const half = Math.floor(size / 2);
    const startX = Math.max(0, cx - half);
    const startY = Math.max(0, cy - half);
    const { data, width, height } = imageData;

    this.trackingTemplateSize = size;
    this.trackingTemplate = new Uint8ClampedArray(size * size * 3);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const srcX = Math.min(startX + x, width - 1);
        const srcY = Math.min(startY + y, height - 1);
        const srcIdx = (srcY * width + srcX) * 4;
        const dstIdx = (y * size + x) * 3;
        this.trackingTemplate[dstIdx] = data[srcIdx];
        this.trackingTemplate[dstIdx + 1] = data[srcIdx + 1];
        this.trackingTemplate[dstIdx + 2] = data[srcIdx + 2];
      }
    }
    console.log('[Tracking] Captured tracking template:', size, 'x', size, 'at', cx, cy);
  }

  private handleLocked(imageData: ImageData): void {
    // Implemented in Task 4
  }

  /**
   * Convert pixel position to game coordinates.
   */
  pixelToGamePosition(
    pixelX: number, pixelY: number,
    region: { x: number; y: number; width: number; height: number },
  ): Position {
    const relX = Math.max(0, Math.min(1, (pixelX - region.x) / region.width));
    const relY = Math.max(0, Math.min(1, (pixelY - region.y) / region.height));
    const dims = MAP_DIMENSIONS[this.mapType];
    return {
      x: relX * dims.width,
      y: dims.height - relY * dims.height,
    };
  }
}
