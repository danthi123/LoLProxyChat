declare const overwolf: any;

import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, MinimapBounds } from '../core/map-calibration';

export enum TrackingState {
  SCANNING = 'scanning',
  LOCKED = 'locked',
  DEAD = 'dead',
}

interface Blob {
  color: 'teal' | 'red';
  pixels: number;
  cx: number;
  cy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  fillRatio: number; // pixels / bbox_area — low for rings, high for filled shapes
}

export class TrackingService {
  private state: TrackingState = TrackingState.SCANNING;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly captureBounds: MinimapBounds;
  private screenWidth: number;
  private screenHeight: number;
  private mapType: MapType;
  private intervalId: number | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;

  // Minimap region (detected or set by calibration/config)
  private minimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  private userMinimapRegion: { x: number; y: number; width: number; height: number } | null = null;
  private configMinimapScale: number | null = null;

  // Tracking state
  private lastPixelPos: { x: number; y: number } | null = null;
  private lastPosition: Position | null = null;
  private deathPosition: Position | null = null;
  private expectedIconDiam = 0;

  // Velocity prediction (smoothed over recent frames)
  private velocityX = 0;
  private velocityY = 0;

  // Interior color fingerprint of the tracked blob (average RGB inside the ring)
  private fingerprint: { r: number; g: number; b: number } | null = null;

  // Known peer positions in region-relative pixel coordinates (from signaling broadcasts)
  // Used as soft penalty: blobs near a known peer are less likely to be "self"
  private peerPixelPositions: { x: number; y: number }[] = [];

  // Self-identification via movement path line (white pixels near teal blobs)
  // Maps approximate blob position key ("x,y") to accumulated white pixel evidence
  private selfScores: Map<string, number> = new Map();
  private scanFrameCount = 0;

  // Filtered image for overlay debug display
  private filteredImageUrl: string | null = null;
  private filteredImageTick = 0;

  // Diagnostics
  private lockedTickCount = 0;
  private diagCounter = 0;

  constructor(screenWidth: number, screenHeight: number, mapType: MapType) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.captureBounds = getMinimapBounds(screenWidth, screenHeight);
    this.mapType = mapType;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.captureBounds.width;
    this.canvas.height = this.captureBounds.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  getState(): TrackingState { return this.state; }
  getLastPosition(): Position | null { return this.lastPosition; }
  getFilteredImageUrl(): string | null { return this.filteredImageUrl; }

  /** Get the minimap bounds in screen coordinates */
  getDetectedMinimapScreenBounds(): { screenX: number; screenY: number; screenWidth: number; screenHeight: number } | null {
    if (!this.minimapRegion) return null;
    return {
      screenX: this.captureBounds.x + this.minimapRegion.x,
      screenY: this.captureBounds.y + this.minimapRegion.y,
      screenWidth: this.minimapRegion.width,
      screenHeight: this.minimapRegion.height,
    };
  }

  /**
   * Set the minimap region from League's MinimapScale config value (0.0 - 3.0).
   * Calibrated from real measurements:
   *   1080p: scale 0 → 200px, scale 3 → 420px
   *   1440p: scale 0 → 280px, scale 3 → 560px
   * Formula: minimapSize = (h*2/9 - 40) + scale * (h/18 + 40/3)
   */
  setMinimapScaleFromConfig(scale: number): void {
    this.configMinimapScale = scale;

    const h = this.screenHeight;
    const base = h * 2 / 9 - 40;          // size at scale 0
    const rate = h / 18 + 40 / 3;         // additional size per scale unit
    const minimapSize = Math.round(base + scale * rate);

    // The minimap is anchored to the bottom-right of the screen.
    const screenMinimapX = this.screenWidth - minimapSize;
    const screenMinimapY = this.screenHeight - minimapSize;
    const region = {
      x: screenMinimapX - this.captureBounds.x,
      y: screenMinimapY - this.captureBounds.y,
      width: minimapSize,
      height: minimapSize,
    };

    this.minimapRegion = region;
    this.expectedIconDiam = Math.round(minimapSize * 0.087);
    console.log('[Tracking] Minimap from config: scale=' + scale +
      ' size=' + minimapSize + 'px' +
      ' screenPos=(' + screenMinimapX + ',' + screenMinimapY + ')' +
      ' region=' + JSON.stringify(region) +
      ' iconDiam=' + this.expectedIconDiam);

    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.selfScores.clear();
    this.scanFrameCount = 0;
  }

  setMinimapRegion(region: { x: number; y: number; width: number; height: number } | null): void {
    this.userMinimapRegion = region;
    if (region) {
      this.minimapRegion = region;
      this.expectedIconDiam = Math.round(region.width * 0.087);
      console.log('[Tracking] Minimap set by calibration:', JSON.stringify(region), 'iconDiam:', this.expectedIconDiam);
    } else {
      this.minimapRegion = null;
    }
    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.lockedTickCount = 0;
    this.selfScores.clear();
    this.scanFrameCount = 0;
  }

  loadChampionTemplate(_championName: string): void {
    console.log('[Tracking] Using color filter + blob detection');
  }

  /**
   * Update known peer positions (from signaling broadcasts).
   * Converts game-unit positions to region-relative minimap pixel coordinates.
   * These are used as a soft penalty: blobs near a known peer are less likely to be "self".
   */
  setPeerGamePositions(positions: Position[]): void {
    if (!this.minimapRegion) {
      this.peerPixelPositions = [];
      return;
    }
    const dims = MAP_DIMENSIONS[this.mapType];
    const region = this.minimapRegion;
    this.peerPixelPositions = positions
      .filter(p => p.x > 0 && p.y > 0)
      .map(p => ({
        x: (p.x / dims.width) * region.width,
        y: ((dims.height - p.y) / dims.height) * region.height,
      }));
  }

  /**
   * Score how close a blob is to any known peer position.
   * Returns 0.0 if right on top of a peer, 1.0 if far from all peers.
   * Used as a soft factor in blob scoring — NOT a hard exclusion.
   */
  private peerAvoidanceScore(blob: Blob): number {
    if (this.peerPixelPositions.length === 0) return 1.0;
    const threshold = this.expectedIconDiam * 1.5; // within 1.5 icon diameters
    const thresholdSq = threshold * threshold;
    let minDistSq = Infinity;
    for (const pp of this.peerPixelPositions) {
      const dx = blob.cx - pp.x;
      const dy = blob.cy - pp.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistSq) minDistSq = distSq;
    }
    if (minDistSq >= thresholdSq) return 1.0;
    // Linear falloff: 0 at distance 0, 1 at threshold
    return Math.sqrt(minDistSq) / threshold;
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
  }

  onRespawn(): void {
    if (this.state !== TrackingState.DEAD) return;
    this.state = TrackingState.SCANNING;
    this.lastPixelPos = null;
    this.deathPosition = null;
    this.lockedTickCount = 0;
    this.selfScores.clear();
    this.scanFrameCount = 0;
  }

  // --- Color classification ---

  /** Classify a pixel as teal (ally border), red (enemy border), or null */
  private classifyPixel(r: number, g: number, b: number): 0 | 1 | 2 {
    // Teal/cyan ally border: low red, high green+blue
    if (r < 100 && g > 120 && b > 120 && (g + b) > 280) return 1;
    // Red enemy border: high red, low green+blue
    if (r > 140 && g < 100 && b < 100) return 2;
    return 0;
  }

  // --- Binary mask creation from minimap region ---

  private createMask(imageData: ImageData, region: { x: number; y: number; width: number; height: number }): Uint8Array {
    const { data, width } = imageData;
    const w = region.width;
    const h = region.height;
    const mask = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = ((region.y + y) * width + (region.x + x)) * 4;
        mask[y * w + x] = this.classifyPixel(data[srcIdx], data[srcIdx + 1], data[srcIdx + 2]);
      }
    }

    return mask;
  }

  /** Dilate the mask to connect 1-pixel gaps in icon borders */
  private dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
    const result = new Uint8Array(mask);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        if (result[idx]) continue;
        // Spread from 4-connected neighbors (same color only)
        const up = mask[(y - 1) * w + x];
        const dn = mask[(y + 1) * w + x];
        const lt = mask[y * w + x - 1];
        const rt = mask[y * w + x + 1];
        // Pick the first nonzero neighbor color
        result[idx] = up || dn || lt || rt;
      }
    }
    return result;
  }

  // --- Connected component (flood-fill) blob detection ---

  private findBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
    const visited = new Uint8Array(w * h);
    const blobs: Blob[] = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (visited[idx] || mask[idx] === 0) continue;

        const targetVal = mask[idx];
        const color: 'teal' | 'red' = targetVal === 1 ? 'teal' : 'red';
        const stack: number[] = [x, y];
        let sumX = 0, sumY = 0, count = 0;
        let minX = x, maxX = x, minY = y, maxY = y;

        while (stack.length > 0) {
          const cy = stack.pop()!;
          const cx = stack.pop()!;
          if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
          const ci = cy * w + cx;
          if (visited[ci] || mask[ci] !== targetVal) continue;

          visited[ci] = 1;
          sumX += cx;
          sumY += cy;
          count++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          stack.push(cx - 1, cy, cx + 1, cy, cx, cy - 1, cx, cy + 1);
        }

        if (count >= 10) {
          const bboxArea = (maxX - minX + 1) * (maxY - minY + 1);
          blobs.push({
            color,
            pixels: count,
            cx: Math.round(sumX / count),
            cy: Math.round(sumY / count),
            minX, maxX, minY, maxY,
            fillRatio: bboxArea > 0 ? count / bboxArea : 1,
          });
        }
      }
    }

    return blobs;
  }

  /** Filter blobs to those matching champion icon rings (not towers or minion clusters) */
  private filterIconBlobs(blobs: Blob[]): Blob[] {
    const diam = this.expectedIconDiam;
    if (diam < 5) return blobs;

    const minSize = diam * 0.6;
    const maxSize = diam * 1.6;

    return blobs.filter(b => {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      // Bounding box should be close to icon-sized (tighter range)
      if (bw < minSize || bw > maxSize || bh < minSize || bh > maxSize) return false;
      // Aspect ratio close to square (champion icons are circles)
      const aspect = bw / bh;
      if (aspect < 0.6 || aspect > 1.7) return false;
      // Minimum pixel count (at least a partial arc)
      if (b.pixels < 15) return false;
      // Champion icon borders are RINGS (hollow center) → low fill ratio
      // Towers and minion clusters are FILLED shapes → high fill ratio
      // Ring of diameter D, border ~3px: fillRatio ≈ 0.25-0.35
      // Minion groups: fillRatio > 0.40 (many pixels clumped together)
      if (b.fillRatio > 0.40) return false;
      // Too sparse means noise, not a real border
      if (b.fillRatio < 0.08) return false;
      return true;
    });
  }

  // --- Movement path line detection (white pixels near teal blobs) ---

  // Cached viewport mask (white pixels that are part of long straight runs)
  private viewportMask: Uint8Array | null = null;

  /**
   * Build a mask of white pixels, marking those that belong to the camera viewport
   * rectangle (long horizontal/vertical runs) so they can be excluded from path detection.
   * Viewport edges are long straight lines (15+ pixels); the movement path line is short/diagonal.
   */
  private buildWhiteMasks(
    imageData: ImageData,
    region: { x: number; y: number; width: number; height: number },
  ): { whiteMask: Uint8Array; viewportMask: Uint8Array } {
    const { data, width: imgW } = imageData;
    const w = region.width;
    const h = region.height;
    const whiteMask = new Uint8Array(w * h);
    const viewportMask = new Uint8Array(w * h);
    const RUN_THRESHOLD = 12; // pixels in a row = viewport edge

    // Pass 1: identify all white pixels
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcIdx = ((region.y + y) * imgW + (region.x + x)) * 4;
        const r = data[srcIdx];
        const g = data[srcIdx + 1];
        const b = data[srcIdx + 2];
        if (r > 200 && g > 200 && b > 200) {
          whiteMask[y * w + x] = 1;
        }
      }
    }

    // Pass 2: mark white pixels in long horizontal runs as viewport
    for (let y = 0; y < h; y++) {
      let runStart = -1;
      for (let x = 0; x <= w; x++) {
        const isWhite = x < w && whiteMask[y * w + x] === 1;
        if (isWhite && runStart < 0) {
          runStart = x;
        } else if (!isWhite && runStart >= 0) {
          if (x - runStart >= RUN_THRESHOLD) {
            for (let rx = runStart; rx < x; rx++) {
              viewportMask[y * w + rx] = 1;
            }
          }
          runStart = -1;
        }
      }
    }

    // Pass 3: mark white pixels in long vertical runs as viewport
    for (let x = 0; x < w; x++) {
      let runStart = -1;
      for (let y = 0; y <= h; y++) {
        const isWhite = y < h && whiteMask[y * w + x] === 1;
        if (isWhite && runStart < 0) {
          runStart = y;
        } else if (!isWhite && runStart >= 0) {
          if (y - runStart >= RUN_THRESHOLD) {
            for (let ry = runStart; ry < y; ry++) {
              viewportMask[ry * w + x] = 1;
            }
          }
          runStart = -1;
        }
      }
    }

    this.viewportMask = viewportMask;
    return { whiteMask, viewportMask };
  }

  /**
   * Count non-viewport white pixels in an annular region around a teal blob.
   * Excludes white pixels that are part of the camera viewport rectangle.
   */
  private countWhiteNearBlob(
    blob: Blob,
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    regionWidth: number,
  ): number {
    const pad = Math.max(4, Math.round(this.expectedIconDiam * 0.3));
    const x0 = Math.max(0, blob.minX - pad);
    const y0 = Math.max(0, blob.minY - pad);
    const x1 = Math.min(regionWidth - 1, blob.maxX + pad);
    const y1 = Math.min(regionWidth - 1, blob.maxY + pad);
    // Inner bbox (the blob's own area — skip these pixels)
    const ix0 = blob.minX;
    const iy0 = blob.minY;
    const ix1 = blob.maxX;
    const iy1 = blob.maxY;

    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) continue;
        const idx = y * regionWidth + x;
        // White pixel that is NOT part of the viewport rectangle
        if (whiteMask[idx] === 1 && viewportMask[idx] === 0) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Sample the average interior color of a blob (the champion portrait inside the ring).
   * Excludes pixels classified as teal/red border in the mask.
   */
  private sampleInteriorColor(
    blob: Blob,
    imageData: ImageData,
    mask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): { r: number; g: number; b: number } | null {
    const { data, width: imgW } = imageData;
    const cx = blob.cx;
    const cy = blob.cy;
    // Sample a small square in the inner portion of the icon (exclude border ring)
    const innerR = Math.max(3, Math.round(this.expectedIconDiam * 0.25));
    let sumR = 0, sumG = 0, sumB = 0, count = 0;

    for (let dy = -innerR; dy <= innerR; dy++) {
      for (let dx = -innerR; dx <= innerR; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= region.width || py < 0 || py >= region.height) continue;
        const mIdx = py * region.width + px;
        // Skip border pixels (teal=1, red=2)
        if (mask[mIdx] !== 0) continue;
        const srcIdx = ((region.y + py) * imgW + (region.x + px)) * 4;
        sumR += data[srcIdx];
        sumG += data[srcIdx + 1];
        sumB += data[srcIdx + 2];
        count++;
      }
    }
    if (count < 5) return null;
    return { r: sumR / count, g: sumG / count, b: sumB / count };
  }

  /**
   * Compute the center of the camera viewport rectangle from the viewport mask.
   * Returns null if insufficient viewport pixels detected.
   */
  private computeViewportCenter(viewportMask: Uint8Array, regionWidth: number, regionHeight: number): { x: number; y: number } | null {
    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < regionHeight; y++) {
      for (let x = 0; x < regionWidth; x++) {
        if (viewportMask[y * regionWidth + x] === 1) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }
    if (count < 20) return null; // too few viewport pixels
    return { x: sumX / count, y: sumY / count };
  }

  /**
   * Score how close a blob is to the viewport center (0 = far, 1 = at center).
   * Players with locked camera or frequent spacebar centering will have the viewport
   * centered on their champion. This is a strong positional hint.
   */
  private viewportProximityScore(blob: Blob, viewportCenter: { x: number; y: number } | null): number {
    if (!viewportCenter) return 0.5; // neutral when no viewport detected
    const dx = blob.cx - viewportCenter.x;
    const dy = blob.cy - viewportCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Full score within ~2 icon diameters of viewport center, drops to 0 at ~6 diameters
    const maxDist = this.expectedIconDiam * 6;
    return Math.max(0, 1 - dist / maxDist);
  }

  /** Color distance between two RGB values (squared Euclidean) */
  private colorDistSq(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return dr * dr + dg * dg + db * db;
  }

  /**
   * Create a position key for blob matching across frames.
   * Quantize to grid cells sized to half the icon diameter.
   */
  private blobPosKey(blob: Blob): string {
    const grid = Math.max(5, Math.round(this.expectedIconDiam / 2));
    const gx = Math.round(blob.cx / grid);
    const gy = Math.round(blob.cy / grid);
    return gx + ',' + gy;
  }

  // --- Filtered image generation for overlay debug ---

  private generateFilteredImage(
    mask: Uint8Array, w: number, h: number, blobs: Blob[],
    imageData?: ImageData, region?: { x: number; y: number; width: number; height: number },
  ): string {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);

    // Draw filtered pixels (teal, red, and white)
    for (let i = 0; i < w * h; i++) {
      const pi = i * 4;
      if (mask[i] === 1) {
        img.data[pi] = 0; img.data[pi + 1] = 220; img.data[pi + 2] = 180; img.data[pi + 3] = 200;
      } else if (mask[i] === 2) {
        img.data[pi] = 255; img.data[pi + 1] = 50; img.data[pi + 2] = 50; img.data[pi + 3] = 200;
      } else if (this.viewportMask) {
        // Show white pixels: yellow = path line, dim gray = viewport (filtered out)
        const wm = this.viewportMask;
        // Check raw pixels for white
        if (imageData && region) {
          const srcIdx = ((region.y + Math.floor(i / w)) * imageData.width + (region.x + (i % w))) * 4;
          const r = imageData.data[srcIdx];
          const g = imageData.data[srcIdx + 1];
          const b = imageData.data[srcIdx + 2];
          if (r > 200 && g > 200 && b > 200) {
            if (wm[i] === 1) {
              // Viewport pixel — dim gray
              img.data[pi] = 80; img.data[pi + 1] = 80; img.data[pi + 2] = 80; img.data[pi + 3] = 120;
            } else {
              // Path line pixel — bright yellow
              img.data[pi] = 255; img.data[pi + 1] = 255; img.data[pi + 2] = 0; img.data[pi + 3] = 220;
            }
          }
        }
      }
    }

    ctx.putImageData(img, 0, 0);

    // Draw circles around detected icon blobs
    ctx.lineWidth = 2;
    for (const b of blobs) {
      const bw = b.maxX - b.minX + 1;
      const bh = b.maxY - b.minY + 1;
      const r = Math.max(bw, bh) / 2;
      ctx.strokeStyle = b.color === 'teal' ? '#00ffcc' : '#ff4444';
      ctx.beginPath();
      ctx.arc(b.cx, b.cy, r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Draw tracked position
    if (this.lastPixelPos && this.minimapRegion) {
      const lx = this.lastPixelPos.x - this.minimapRegion.x;
      const ly = this.lastPixelPos.y - this.minimapRegion.y;
      ctx.fillStyle = '#ff0000';
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    return c.toDataURL('image/png');
  }

  // --- Main tick ---

  private tick(): void {
    if (this.state === TrackingState.DEAD) {
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
      if (!result?.url) return;

      const img = new Image();
      img.onload = () => {
        this.ctx.drawImage(img, 0, 0);
        if (result.url.startsWith('blob:')) {
          try { URL.revokeObjectURL(result.url); } catch (_) { /* ignore */ }
        }
        const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        // Minimap region is set from game.cfg config (or manual calibration).
        // No CV-based auto-detection needed.
        if (!this.minimapRegion && this.userMinimapRegion) {
          this.minimapRegion = this.userMinimapRegion;
          this.expectedIconDiam = Math.round(this.minimapRegion.width * 0.087);
        }

        if (!this.minimapRegion) return;

        // Create filtered mask and find blobs
        const region = this.minimapRegion;
        let mask = this.createMask(imageData, region);
        mask = this.dilate(mask, region.width, region.height);
        const allBlobs = this.findBlobs(mask, region.width, region.height);
        const iconBlobs = this.filterIconBlobs(allBlobs);

        // Generate filtered debug image ~every 1 second (every 8 frames)
        this.filteredImageTick++;
        if (this.filteredImageTick % 8 === 0) {
          this.filteredImageUrl = this.generateFilteredImage(mask, region.width, region.height, iconBlobs, imageData, region);
        }

        // Diagnostics every ~5 seconds
        if (this.diagCounter++ % 40 === 0) {
          const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
          const redBlobs = iconBlobs.filter(b => b.color === 'red');
          console.log('[Tracking] Blobs: total=' + allBlobs.length +
            ' iconSized=' + iconBlobs.length +
            ' teal=' + tealBlobs.length + ' red=' + redBlobs.length +
            ' state=' + this.state);
          for (const b of iconBlobs) {
            const bw = b.maxX - b.minX + 1;
            const bh = b.maxY - b.minY + 1;
            console.log('[Tracking]   ' + b.color + ' blob: center=(' + b.cx + ',' + b.cy +
              ') size=' + bw + 'x' + bh + ' pixels=' + b.pixels +
              ' fill=' + b.fillRatio.toFixed(2));
          }
        }

        // Build white pixel masks (separating movement path from viewport rectangle)
        const { whiteMask, viewportMask } = this.buildWhiteMasks(imageData, region);

        if (this.state === TrackingState.SCANNING) {
          this.handleScanning(iconBlobs, whiteMask, viewportMask, region, imageData, mask);
        } else if (this.state === TrackingState.LOCKED) {
          this.handleLocked(iconBlobs, whiteMask, viewportMask, region, imageData, mask);
        }
      };
      img.src = result.url;
    });
  }

  /**
   * Scan: identify the local player's teal blob using movement path line detection.
   * The local player's champion has a thin white line on the minimap when moving.
   * We count white pixels in an annular region around each teal blob and accumulate
   * evidence across frames. The blob with the most white pixel evidence is "self".
   * Falls back to best ring score if no movement path is detected after several frames.
   */
  private handleScanning(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
    imageData?: ImageData,
    mask?: Uint8Array,
  ): void {
    if (!this.minimapRegion) return;

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    if (tealBlobs.length === 0) return;

    this.scanFrameCount++;

    // Count non-viewport white pixels near each teal blob and accumulate scores
    let bestWhite = 0;
    let bestWhiteBlob: Blob | null = null;
    for (const b of tealBlobs) {
      const white = this.countWhiteNearBlob(b, whiteMask, viewportMask, region.width);
      const key = this.blobPosKey(b);
      const prev = this.selfScores.get(key) || 0;
      const score = prev * 0.7 + white;
      this.selfScores.set(key, score);

      if (white > bestWhite) {
        bestWhite = white;
        bestWhiteBlob = b;
      }
    }

    // Log white pixel scores periodically
    if (this.scanFrameCount % 8 === 0) {
      const scores: string[] = [];
      for (const b of tealBlobs) {
        const key = this.blobPosKey(b);
        const accumulated = this.selfScores.get(key) || 0;
        const instant = this.countWhiteNearBlob(b, whiteMask, viewportMask, region.width);
        scores.push('(' + b.cx + ',' + b.cy + ')white=' + instant + '/acc=' + accumulated.toFixed(1));
      }
      console.log('[Tracking] Self-ID scores: ' + scores.join(' | '));
    }

    // If a blob has clear white pixel evidence this frame (movement path line visible),
    // lock onto it — but if multiple blobs have white evidence, prefer the one farther from peers.
    if (bestWhiteBlob && bestWhite >= 3) {
      // Check if another blob also has white evidence — pick the one with better peer avoidance
      let chosenBlob = bestWhiteBlob;
      if (tealBlobs.length > 1) {
        let chosenScore = bestWhite * (0.5 + 0.5 * this.peerAvoidanceScore(bestWhiteBlob));
        for (const b of tealBlobs) {
          if (b === bestWhiteBlob) continue;
          const white = this.countWhiteNearBlob(b, whiteMask, viewportMask, region.width);
          if (white >= 3) {
            const score = white * (0.5 + 0.5 * this.peerAvoidanceScore(b));
            if (score > chosenScore) {
              chosenScore = score;
              chosenBlob = b;
            }
          }
        }
      }
      this.lockOnBlob(chosenBlob, 'path-line(white=' + bestWhite + ')', imageData, mask, region);
      return;
    }

    // Check accumulated scores: if one blob has significantly more evidence than others
    let bestAccKey = '';
    let bestAccScore = 0;
    let secondBestAcc = 0;
    for (const [key, score] of this.selfScores) {
      if (score > bestAccScore) {
        secondBestAcc = bestAccScore;
        bestAccScore = score;
        bestAccKey = key;
      } else if (score > secondBestAcc) {
        secondBestAcc = score;
      }
    }

    // If accumulated evidence is strong and clearly better than runner-up, lock on
    if (bestAccScore >= 5 && bestAccScore > secondBestAcc * 2) {
      // Find the current teal blob closest to the accumulated winner position
      const grid = Math.max(5, Math.round(this.expectedIconDiam / 2));
      for (const b of tealBlobs) {
        if (this.blobPosKey(b) === bestAccKey) {
          this.lockOnBlob(b, 'accumulated(score=' + bestAccScore.toFixed(1) + ')', imageData, mask, region);
          return;
        }
      }
    }

    // Fallback: after ~3 seconds of scanning with no white pixel evidence,
    // use viewport proximity + peer avoidance to pick best candidate
    if (this.scanFrameCount > 24) {
      const vpCenter = this.computeViewportCenter(viewportMask, region.width, region.height);
      let best = tealBlobs[0];
      let bestFallbackScore = -Infinity;
      for (const b of tealBlobs) {
        const vpScore = this.viewportProximityScore(b, vpCenter);
        const peerScore = this.peerAvoidanceScore(b);
        const ringScore = b.pixels * (1 - b.fillRatio) / 200; // normalize to ~0-1
        const score = vpScore * 0.4 + peerScore * 0.4 + ringScore * 0.2;
        if (score > bestFallbackScore) {
          bestFallbackScore = score;
          best = b;
        }
      }
      this.lockOnBlob(best, 'fallback(vp+peer, score=' + bestFallbackScore.toFixed(2) + ')', imageData, mask, region);
      return;
    }

    // Still scanning — report last known position if we have one
    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /** Lock onto a teal blob as the local player */
  private lockOnBlob(blob: Blob, reason: string, imageData?: ImageData, mask?: Uint8Array, region?: { x: number; y: number; width: number; height: number }): void {
    if (!this.minimapRegion) return;

    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;

    this.lastPixelPos = { x: cx, y: cy };
    this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.state = TrackingState.LOCKED;
    this.lockedTickCount = 0;
    this.selfScores.clear();
    this.scanFrameCount = 0;
    this.velocityX = 0;
    this.velocityY = 0;

    // Capture interior color fingerprint
    if (imageData && mask && region) {
      this.fingerprint = this.sampleInteriorColor(blob, imageData, mask, region);
    }

    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    console.log('[Tracking] SCANNING -> LOCKED via ' + reason +
      ': center=(' + cx + ',' + cy + ')' +
      ' size=' + bw + 'x' + bh + ' pixels=' + blob.pixels +
      ' fill=' + blob.fillRatio.toFixed(2));

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

  /**
   * Locked: follow the tracked blob using velocity prediction + color fingerprint + white-pixel correction.
   * When multiple blobs are nearby, scores each candidate by:
   *   1. Distance to PREDICTED position (using velocity from recent frames)
   *   2. Color similarity to stored interior fingerprint
   *   3. White pixel evidence (movement path line = unambiguous override)
   */
  private handleLocked(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
    imageData?: ImageData,
    mask?: Uint8Array,
  ): void {
    if (!this.lastPixelPos || !this.minimapRegion) {
      this.state = TrackingState.SCANNING;
      return;
    }

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    if (tealBlobs.length === 0) {
      this.lockedTickCount++;
      if (this.lockedTickCount > 16) {
        console.log('[Tracking] LOCKED -> SCANNING (no teal blobs for 2s)');
        this.state = TrackingState.SCANNING;
        this.lastPixelPos = null;
        this.lockedTickCount = 0;
      }
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    // Check white pixels for self-correction (unambiguous)
    let bestWhite = 0;
    let bestWhiteBlob: Blob | null = null;
    for (const b of tealBlobs) {
      const white = this.countWhiteNearBlob(b, whiteMask, viewportMask, region.width);
      if (white > bestWhite) {
        bestWhite = white;
        bestWhiteBlob = b;
      }
    }

    // White-pixel override: bypasses all other logic
    if (bestWhiteBlob && bestWhite >= 3) {
      const chosen = bestWhiteBlob;
      const cx = this.minimapRegion.x + chosen.cx;
      const cy = this.minimapRegion.y + chosen.cy;
      const prevX = this.lastPixelPos.x - this.minimapRegion.x;
      const prevY = this.lastPixelPos.y - this.minimapRegion.y;
      // Update velocity
      this.velocityX = this.velocityX * 0.5 + (chosen.cx - prevX) * 0.5;
      this.velocityY = this.velocityY * 0.5 + (chosen.cy - prevY) * 0.5;
      this.lastPixelPos = { x: cx, y: cy };
      this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
      this.lockedTickCount++;
      // Update fingerprint periodically
      if (imageData && mask && this.lockedTickCount % 4 === 0) {
        const fp = this.sampleInteriorColor(chosen, imageData, mask, region);
        if (fp) this.fingerprint = fp;
      }
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    // Predicted position using velocity
    const lastRegX = this.lastPixelPos.x - this.minimapRegion.x;
    const lastRegY = this.lastPixelPos.y - this.minimapRegion.y;
    const predX = lastRegX + this.velocityX;
    const predY = lastRegY + this.velocityY;

    // Max jump distance
    const MAX_JUMP_PX = Math.max(15, Math.round(this.expectedIconDiam * 0.8));
    const maxJumpSq = MAX_JUMP_PX * MAX_JUMP_PX;

    // Compute viewport center for proximity scoring
    const viewportCenter = this.computeViewportCenter(viewportMask, region.width, region.height);

    // Score each blob: position prediction + color + peer avoidance + viewport proximity
    let bestBlob: Blob | null = null;
    let bestScore = -Infinity;
    const scoringDetails: string[] = [];
    for (const b of tealBlobs) {
      // Distance to last position (must be within jump range)
      const dxLast = b.cx - lastRegX;
      const dyLast = b.cy - lastRegY;
      const distLastSq = dxLast * dxLast + dyLast * dyLast;
      if (distLastSq > maxJumpSq) continue;

      // Distance to predicted position (lower = better)
      const dxPred = b.cx - predX;
      const dyPred = b.cy - predY;
      const distPredSq = dxPred * dxPred + dyPred * dyPred;
      // Normalize: 0 at predicted pos, -1 at max jump distance
      const posScore = 1 - distPredSq / maxJumpSq;

      // Color fingerprint similarity (0 to 1, higher = more similar)
      let colorScore = 0;
      if (this.fingerprint && imageData && mask) {
        const blobColor = this.sampleInteriorColor(b, imageData, mask, region);
        if (blobColor) {
          const distSq = this.colorDistSq(this.fingerprint, blobColor);
          colorScore = 1 - Math.min(1, distSq / 30000);
        }
      }

      // Peer avoidance: penalize blobs near known peer positions
      const peerScore = this.peerAvoidanceScore(b);

      // Viewport proximity: prefer blob closer to camera viewport center
      const vpScore = this.viewportProximityScore(b, viewportCenter);

      // Combined score: balanced across all signals
      const score = posScore * 0.35 + colorScore * 0.1 + peerScore * 0.25 + vpScore * 0.3;

      // Collect scoring details for diagnostics
      if (this.lockedTickCount % 40 === 0) {
        scoringDetails.push('(' + b.cx + ',' + b.cy + ')' +
          ' pos=' + posScore.toFixed(2) +
          ' color=' + colorScore.toFixed(2) +
          ' peer=' + peerScore.toFixed(2) +
          ' vp=' + vpScore.toFixed(2) +
          ' total=' + score.toFixed(2));
      }

      if (score > bestScore) {
        bestScore = score;
        bestBlob = b;
      }
    }

    // Log scoring details periodically
    if (this.lockedTickCount % 40 === 0 && scoringDetails.length > 0) {
      console.log('[Tracking] Blob scores: ' + scoringDetails.join(' | '));
      console.log('[Tracking] Peers: ' + this.peerPixelPositions.length +
        ' positions=' + this.peerPixelPositions.map(p => '(' + Math.round(p.x) + ',' + Math.round(p.y) + ')').join(',') +
        ' vpCenter=' + (viewportCenter ? '(' + Math.round(viewportCenter.x) + ',' + Math.round(viewportCenter.y) + ')' : 'none'));
    }

    if (!bestBlob) {
      this.lockedTickCount++;
      if (this.lockedTickCount > 16) {
        console.log('[Tracking] LOCKED -> SCANNING (no nearby blob for 2s, maxJump=' + MAX_JUMP_PX + ')');
        this.state = TrackingState.SCANNING;
        this.lastPixelPos = null;
        this.lockedTickCount = 0;
      }
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    const cx = this.minimapRegion.x + bestBlob.cx;
    const cy = this.minimapRegion.y + bestBlob.cy;

    // Update velocity (exponential moving average)
    this.velocityX = this.velocityX * 0.5 + (bestBlob.cx - lastRegX) * 0.5;
    this.velocityY = this.velocityY * 0.5 + (bestBlob.cy - lastRegY) * 0.5;

    this.lastPixelPos = { x: cx, y: cy };
    this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.lockedTickCount++;

    // Update fingerprint periodically (every ~0.5s)
    if (imageData && mask && this.lockedTickCount % 4 === 0) {
      const fp = this.sampleInteriorColor(bestBlob, imageData, mask, region);
      if (fp) this.fingerprint = fp;
    }

    // Log every ~5 seconds
    if (this.lockedTickCount % 40 === 0) {
      console.log('[Tracking] Locked: pixel(' + cx + ',' + cy + ')' +
        ' game(' + Math.round(this.lastPosition.x) + ',' + Math.round(this.lastPosition.y) + ')' +
        ' vel=(' + this.velocityX.toFixed(1) + ',' + this.velocityY.toFixed(1) + ')' +
        ' fp=' + (this.fingerprint ? Math.round(this.fingerprint.r) + ',' + Math.round(this.fingerprint.g) + ',' + Math.round(this.fingerprint.b) : 'none') +
        ' tealBlobs=' + tealBlobs.length);
    }

    if (this.onPositionUpdate && this.lastPosition) {
      this.onPositionUpdate(this.lastPosition);
    }
  }

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
