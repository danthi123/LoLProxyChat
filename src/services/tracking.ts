declare const overwolf: any;

import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, MinimapBounds } from '../core/map-calibration';
import { ChampionClassifier } from './champion-classifier';

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

  // Known peer positions in region-relative pixel coordinates (from signaling broadcasts)
  // Used as soft penalty: blobs near a known peer are less likely to be "self"
  private peerPixelPositions: { x: number; y: number }[] = [];

  // Frame counter during SCANNING (warmup before lock-on)
  private scanFrameCount = 0;

  // Filtered image for overlay debug display
  private filteredImageUrl: string | null = null;
  private filteredImageTick = 0;

  // Champion classifier (ONNX model)
  private classifier: ChampionClassifier | null = null;
  // Cached classifier scores per blob (refreshed periodically, not every frame)
  private classifierScores: Map<string, number> = new Map();
  // EMA-smoothed classifier scores to dampen single-frame misclassifications
  private smoothedClassifierScores: Map<string, number> = new Map();
  private classifierTick = 0;

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
    this.scanFrameCount = 0;
  }

  loadChampionTemplate(_championName: string): void {
    console.log('[Tracking] Using color filter + blob detection');
  }

  setClassifier(classifier: ChampionClassifier): void {
    this.classifier = classifier;
    console.log('[Tracking] Champion classifier set');
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

  /**
   * Run the champion classifier on teal blobs and cache the "local champion confidence" per blob.
   * Called every few frames (not every frame) to amortize ONNX inference cost.
   * Scores are cached by blob center (cx,cy) for fuzzy lookup.
   */
  private async updateClassifierScores(
    tealBlobs: Blob[],
    imageData: ImageData,
    region: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    if (!this.classifier || !this.classifier.isLoaded()) return;

    const crops = tealBlobs.map(b => ({
      cropX: region.x + b.minX - 1,
      cropY: region.y + b.minY - 1,
      cropW: b.maxX - b.minX + 3,
      cropH: b.maxY - b.minY + 3,
    }));

    try {
      const rawScores = await this.classifier.scoreBlobsForLocalChampion(imageData, crops);

      // Normalize scores across blobs: the model may have low absolute confidence
      // but still correctly RANK blobs. Normalizing makes relative differences useful.
      // E.g., raw [0.067, 0.000] → normalized [1.0, 0.0]
      // Minimum raw threshold: if no blob exceeds this, the model is saying none of them
      // match the local champion — don't inflate via normalization (prevents single wrong
      // blob from getting cls=1.0 just because it's the only one detected).
      const MIN_RAW_THRESHOLD = 0.005;
      const maxRaw = Math.max(...rawScores);
      const normalizedScores = maxRaw >= MIN_RAW_THRESHOLD
        ? rawScores.map(s => s / maxRaw)
        : rawScores.map(() => 0);

      // Apply EMA smoothing to prevent single-frame misclassifications from flipping scores.
      // Alpha=0.4 means ~60% prior + 40% new observation — dampens noise while still adapting.
      const EMA_ALPHA = 0.4;
      const tolerance = Math.max(5, this.expectedIconDiam * 0.6);
      const toleranceSq = tolerance * tolerance;

      this.classifierScores.clear();
      for (let i = 0; i < tealBlobs.length; i++) {
        const key = tealBlobs[i].cx + ',' + tealBlobs[i].cy;
        const norm = normalizedScores[i];

        // Find closest prior smoothed score (blobs shift slightly between frames)
        let priorSmoothed = -1;
        let bestDistSq = Infinity;
        for (const [sKey, sVal] of this.smoothedClassifierScores) {
          const [sx, sy] = sKey.split(',').map(Number);
          const dx = tealBlobs[i].cx - sx;
          const dy = tealBlobs[i].cy - sy;
          const dSq = dx * dx + dy * dy;
          if (dSq < toleranceSq && dSq < bestDistSq) {
            bestDistSq = dSq;
            priorSmoothed = sVal;
          }
        }

        const smoothed = priorSmoothed >= 0
          ? priorSmoothed * (1 - EMA_ALPHA) + norm * EMA_ALPHA
          : norm; // first observation: use raw normalized
        this.classifierScores.set(key, smoothed);
      }

      // Update smoothed scores map for next frame
      this.smoothedClassifierScores.clear();
      for (const [key, val] of this.classifierScores) {
        this.smoothedClassifierScores.set(key, val);
      }

      // Diagnostic logging only every ~30s (240 frames at ~8fps)
      if (this.classifierTick % 240 === 0) {
        const details = tealBlobs.map((b, i) =>
          '(' + b.cx + ',' + b.cy + ')raw=' + rawScores[i].toFixed(3) +
          '/ema=' + (this.classifierScores.get(b.cx + ',' + b.cy) ?? 0).toFixed(2)
        ).join(' | ');
        console.log('[Tracking] Classifier scores: ' + details);
      }
    } catch (e) {
      console.error('[Tracking] Classifier inference failed:', e);
    }
  }

  /**
   * Get cached classifier score for a blob.
   * Uses fuzzy matching: finds the closest cached blob center within icon diameter.
   */
  private getClassifierScore(blob: Blob): number {
    // Exact match first
    const exact = this.classifierScores.get(blob.cx + ',' + blob.cy);
    if (exact !== undefined) return exact;

    // Fuzzy match: find closest cached center within icon diameter tolerance
    const tolerance = Math.max(5, this.expectedIconDiam * 0.6);
    const toleranceSq = tolerance * tolerance;
    let bestScore = 0;
    let bestDistSq = Infinity;
    for (const [key, score] of this.classifierScores) {
      const [kx, ky] = key.split(',').map(Number);
      const dx = blob.cx - kx;
      const dy = blob.cy - ky;
      const distSq = dx * dx + dy * dy;
      if (distSq < toleranceSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        bestScore = score;
      }
    }
    return bestScore;
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
   * Score movement path line evidence for a blob (0 = none, 1 = strong).
   * Normalizes the raw white pixel count to [0, 1]: 8+ white pixels = full score.
   */
  private whitePixelScore(
    blob: Blob,
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    regionWidth: number,
  ): number {
    const count = this.countWhiteNearBlob(blob, whiteMask, viewportMask, regionWidth);
    return Math.min(1, count / 8);
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

    // Draw filtered pixels (teal, red, and movement path white)
    for (let i = 0; i < w * h; i++) {
      const pi = i * 4;
      if (mask[i] === 1) {
        img.data[pi] = 0; img.data[pi + 1] = 220; img.data[pi + 2] = 180; img.data[pi + 3] = 200;
      } else if (mask[i] === 2) {
        img.data[pi] = 255; img.data[pi + 1] = 50; img.data[pi + 2] = 50; img.data[pi + 3] = 200;
      } else if (imageData && region) {
        // Show non-viewport white pixels as yellow (movement path line)
        const srcIdx = ((region.y + Math.floor(i / w)) * imageData.width + (region.x + (i % w))) * 4;
        const r = imageData.data[srcIdx];
        const g = imageData.data[srcIdx + 1];
        const b = imageData.data[srcIdx + 2];
        if (r > 200 && g > 200 && b > 200 && this.viewportMask && this.viewportMask[i] === 0) {
          img.data[pi] = 255; img.data[pi + 1] = 255; img.data[pi + 2] = 0; img.data[pi + 3] = 220;
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

        this.diagCounter++;

        // Build white pixel masks (separating movement path from viewport rectangle)
        const { whiteMask, viewportMask } = this.buildWhiteMasks(imageData, region);

        // Run classifier every 4th frame to amortize cost
        this.classifierTick++;
        const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
        if (this.classifier && this.classifierTick % 4 === 0 && tealBlobs.length > 0) {
          this.updateClassifierScores(tealBlobs, imageData, region);
        }

        if (this.state === TrackingState.SCANNING) {
          this.handleScanning(iconBlobs, whiteMask, viewportMask, region);
        } else if (this.state === TrackingState.LOCKED) {
          this.handleLocked(iconBlobs, whiteMask, viewportMask, region);
        }
      };
      img.src = result.url;
    });
  }

  /**
   * Scan: initial identification of the local player's teal blob.
   * Uses a unified composite score (classifier, peer avoidance, movement path, ring quality).
   * Only used once at game start (or after respawn). Once locked, we never return to SCANNING —
   * instead we hold position and re-acquire via classifier.
   */
  private handleScanning(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.minimapRegion) return;

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    if (tealBlobs.length === 0) return;

    this.scanFrameCount++;

    // Wait ~1 second (8 frames at 8fps) for classifier EMA to stabilize.
    // Without classifier, wait 4 frames for basic signal gathering.
    const hasClassifier = !!(this.classifier && this.classifier.isLoaded());
    const warmupFrames = hasClassifier ? 8 : 4;
    if (this.scanFrameCount < warmupFrames) {
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    let bestBlob = tealBlobs[0];
    let bestScore = -Infinity;

    for (const b of tealBlobs) {
      const peerScore = this.peerAvoidanceScore(b);
      const whiteScore = this.whitePixelScore(b, whiteMask, viewportMask, region.width);
      const clsScore = this.getClassifierScore(b);
      const ringScore = Math.min(1, b.pixels * (1 - b.fillRatio) / 200);

      const score = hasClassifier
        ? clsScore * 0.45 + whiteScore * 0.25 + peerScore * 0.20 + ringScore * 0.10
        : peerScore * 0.40 + whiteScore * 0.35 + ringScore * 0.25;

      if (score > bestScore) {
        bestScore = score;
        bestBlob = b;
      }
    }

    this.lockOnBlob(bestBlob, 'composite(score=' + bestScore.toFixed(2) + ')');
  }

  /** Lock onto a teal blob as the local player */
  private lockOnBlob(blob: Blob, reason: string): void {
    if (!this.minimapRegion) return;

    const cx = this.minimapRegion.x + blob.cx;
    const cy = this.minimapRegion.y + blob.cy;

    this.lastPixelPos = { x: cx, y: cy };
    this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.state = TrackingState.LOCKED;
    this.lockedTickCount = 0;
    this.scanFrameCount = 0;
    this.velocityX = 0;
    this.velocityY = 0;

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
   * Locked: follow the tracked blob using a unified composite score.
   * Never drops back to SCANNING — instead holds last known position when blobs vanish
   * (death, camera pan, overlapping icons, teleport) and re-acquires via classifier
   * when a confident match reappears anywhere on the minimap.
   */
  private handleLocked(
    iconBlobs: Blob[],
    whiteMask: Uint8Array,
    viewportMask: Uint8Array,
    region: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.lastPixelPos || !this.minimapRegion) return;

    const tealBlobs = iconBlobs.filter(b => b.color === 'teal');
    const hasClassifier = !!(this.classifier && this.classifier.isLoaded());

    // No teal blobs at all — hold position
    if (tealBlobs.length === 0) {
      if (this.lockedTickCount === 0) {
        console.log('[Tracking] Holding position (no teal blobs)');
      }
      this.lockedTickCount++;
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

    // Max jump distance: allow up to 2x icon diameter per frame for normal movement.
    // When holding position (lockedTickCount > 0), progressively expand the search
    // radius so we can re-acquire a separating blob that moved during the hold.
    // Grows by ~1 icon diameter per second (every 8 frames at 8fps).
    const BASE_JUMP_PX = Math.max(20, Math.round(this.expectedIconDiam * 2.0));
    const holdExpansion = this.lockedTickCount > 0
      ? Math.round(this.expectedIconDiam * (this.lockedTickCount / 8))
      : 0;
    const MAX_JUMP_PX = BASE_JUMP_PX + holdExpansion;
    const maxJumpSq = MAX_JUMP_PX * MAX_JUMP_PX;

    // Minimum classifier confidence to follow a blob. If the classifier is loaded
    // and the best nearby blob scores below this, hold position instead of following
    // a blob the classifier says is NOT our champion.
    const CLS_FOLLOW_THRESHOLD = 0.2;

    // --- Phase 1: Try normal frame-to-frame tracking (blobs within jump range) ---
    let bestBlob: Blob | null = null;
    let bestScore = -Infinity;

    for (const b of tealBlobs) {
      const dxLast = b.cx - lastRegX;
      const dyLast = b.cy - lastRegY;
      if (dxLast * dxLast + dyLast * dyLast > maxJumpSq) continue;

      const dxPred = b.cx - predX;
      const dyPred = b.cy - predY;
      const posScore = 1 - (dxPred * dxPred + dyPred * dyPred) / maxJumpSq;

      const peerScore = this.peerAvoidanceScore(b);
      const whiteScore = this.whitePixelScore(b, whiteMask, viewportMask, region.width);
      const clsScore = this.getClassifierScore(b);

      // If classifier is loaded, reject blobs it confidently says aren't our champion
      if (hasClassifier && clsScore < CLS_FOLLOW_THRESHOLD) continue;

      const score = hasClassifier
        ? posScore * 0.35 + clsScore * 0.30 + whiteScore * 0.20 + peerScore * 0.15
        : posScore * 0.45 + peerScore * 0.30 + whiteScore * 0.25;

      if (score > bestScore) {
        bestScore = score;
        bestBlob = b;
      }
    }

    // --- Phase 2: No blob in jump range — try classifier re-acquisition ---
    // Handles teleport, respawn, camera pan, blob overlap recovery.
    // Jump to any teal blob with high classifier confidence regardless of distance.
    // After holding for a while (>1s), lower the threshold to recover faster.
    if (!bestBlob && hasClassifier) {
      const CLS_REACQUIRE_THRESHOLD = this.lockedTickCount > 8 ? 0.35 : 0.5;
      let bestClsBlob: Blob | null = null;
      let bestClsScore = 0;

      for (const b of tealBlobs) {
        const clsScore = this.getClassifierScore(b);
        if (clsScore >= CLS_REACQUIRE_THRESHOLD && clsScore > bestClsScore) {
          bestClsScore = clsScore;
          bestClsBlob = b;
        }
      }

      if (bestClsBlob) {
        const cx = this.minimapRegion.x + bestClsBlob.cx;
        const cy = this.minimapRegion.y + bestClsBlob.cy;
        this.lastPixelPos = { x: cx, y: cy };
        this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
        this.velocityX = 0;
        this.velocityY = 0;
        this.lockedTickCount++;
        console.log('[Tracking] Re-acquired via classifier (cls=' + bestClsScore.toFixed(2) +
          '): pixel(' + cx + ',' + cy + ')' +
          ' game(' + Math.round(this.lastPosition.x) + ',' + Math.round(this.lastPosition.y) + ')');
        if (this.onPositionUpdate && this.lastPosition) {
          this.onPositionUpdate(this.lastPosition);
        }
        return;
      }
    }

    // --- Phase 3: No blob matched at all — hold position ---
    if (!bestBlob) {
      if (this.lockedTickCount === 0) {
        console.log('[Tracking] Holding position (no match in range)');
      }
      this.lockedTickCount++;
      if (this.onPositionUpdate && this.lastPosition) {
        this.onPositionUpdate(this.lastPosition);
      }
      return;
    }

    // Log when resuming tracking after a hold
    if (this.lockedTickCount > 0) {
      console.log('[Tracking] Resumed tracking after hold (' + this.lockedTickCount + ' frames)');
    }

    const cx = this.minimapRegion.x + bestBlob.cx;
    const cy = this.minimapRegion.y + bestBlob.cy;

    // Update velocity (exponential moving average)
    this.velocityX = this.velocityX * 0.5 + (bestBlob.cx - lastRegX) * 0.5;
    this.velocityY = this.velocityY * 0.5 + (bestBlob.cy - lastRegY) * 0.5;

    this.lastPixelPos = { x: cx, y: cy };
    this.lastPosition = this.pixelToGamePosition(cx, cy, this.minimapRegion);
    this.lockedTickCount = 0;

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
