/* eslint-disable @typescript-eslint/no-var-requires */
declare const require: (module: string) => any;

import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, MinimapBounds } from '../core/map-calibration';

export enum TrackingState {
  SCANNING = 'scanning',
  LOCKED = 'locked',
  DEAD = 'dead',
}

interface TemplateData {
  size: number;
  skins: number[][]; // each skin is a flat RGB array with -1 for masked pixels
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
    // Capture minimap screenshot — implemented in Task 3
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
