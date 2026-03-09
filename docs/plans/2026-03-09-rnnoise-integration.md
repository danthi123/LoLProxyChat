# RNNoise Integration - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace browser built-in noise suppression and energy-threshold VAD with RNNoise WASM for better voice quality and accurate voice activity detection.

**Architecture:** RNNoise runs as an AudioWorkletProcessor in its own thread. The worklet receives raw mic audio, denoises it in-place, and posts VAD scores back to the main thread via the worklet's port. The AudioService inserts the worklet node between the gain node and the output stream destination, and uses the VAD score (0-1) instead of the current frequency energy average.

**Tech Stack:** `@jitsi/rnnoise-wasm` (WASM module), AudioWorklet API, webpack CopyPlugin for WASM assets.

---

### Task 1: Install rnnoise-wasm dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run: `npm install @jitsi/rnnoise-wasm`

**Step 2: Verify installation**

Run: `ls node_modules/@jitsi/rnnoise-wasm/dist/`
Expected: `rnnoise.wasm` and JS files present

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @jitsi/rnnoise-wasm dependency"
```

---

### Task 2: Create the RNNoise AudioWorklet processor

**Files:**
- Create: `src/audio/rnnoise-worklet.ts`

This is a standalone AudioWorkletProcessor file that will be compiled separately and loaded via `audioContext.audioWorklet.addModule()`. It handles the 128→480 sample buffering, calls rnnoise for denoising, and posts VAD scores to the main thread.

**Step 1: Write the worklet processor**

```typescript
// src/audio/rnnoise-worklet.ts
//
// AudioWorkletProcessor that uses RNNoise WASM for noise suppression + VAD.
// Adapted from Jitsi's NoiseSuppressorWorklet.
//
// RNNoise expects 480-sample frames at 48kHz (10ms).
// AudioWorklet delivers 128-sample chunks.
// We use a circular buffer (LCM of 128 and 480 = 1920) to bridge the mismatch.

declare function createRNNWasmModuleSync(): any;

const RNNOISE_SAMPLE_LENGTH = 480;
const WORKLET_SAMPLE_LENGTH = 128;
const SHIFT_16_BIT = 32768; // 2^15, for float32 ↔ int16 conversion

function leastCommonMultiple(a: number, b: number): number {
  function gcd(x: number, y: number): number { return y === 0 ? x : gcd(y, x % y); }
  return (a * b) / gcd(a, b);
}

class RnnoiseProcessor {
  private wasmModule: any;
  private context: number;
  private pcmInput: number;
  private pcmInputF32Index: number;

  constructor(wasmModule: any) {
    this.wasmModule = wasmModule;
    this.context = wasmModule._rnnoise_create(null);
    // Allocate WASM memory for one frame of 16-bit float samples
    const byteSize = RNNOISE_SAMPLE_LENGTH * 4; // float32
    this.pcmInput = wasmModule._malloc(byteSize);
    this.pcmInputF32Index = this.pcmInput >> 2; // index into HEAPF32
  }

  processFrame(pcmFrame: Float32Array): number {
    // Copy float32 PCM → WASM heap (scaled to int16 range)
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      this.wasmModule.HEAPF32[this.pcmInputF32Index + i] = pcmFrame[i] * SHIFT_16_BIT;
    }

    // Denoise in-place, returns VAD score 0.0-1.0
    const vadScore = this.wasmModule._rnnoise_process_frame(
      this.context, this.pcmInput, this.pcmInput
    );

    // Copy denoised audio back (scaled from int16 range)
    for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
      pcmFrame[i] = this.wasmModule.HEAPF32[this.pcmInputF32Index + i] / SHIFT_16_BIT;
    }

    return vadScore;
  }

  destroy(): void {
    this.wasmModule._rnnoise_destroy(this.context);
    this.wasmModule._free(this.pcmInput);
  }
}

class NoiseSuppressorWorklet extends AudioWorkletProcessor {
  private processor: RnnoiseProcessor;
  private circularBuffer: Float32Array;
  private circularBufferLength: number;
  private inputBufferLength = 0;
  private denoisedBufferLength = 0;
  private denoisedBufferIndx = 0;
  private vadAccumulator = 0;
  private vadCount = 0;

  constructor() {
    super();
    this.processor = new RnnoiseProcessor(createRNNWasmModuleSync());
    this.circularBufferLength = leastCommonMultiple(WORKLET_SAMPLE_LENGTH, RNNOISE_SAMPLE_LENGTH);
    this.circularBuffer = new Float32Array(this.circularBufferLength);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const inData = inputs[0]?.[0];
    const outData = outputs[0]?.[0];
    if (!inData || !outData) return true;

    // Append raw PCM to circular buffer
    this.circularBuffer.set(inData, this.inputBufferLength);
    this.inputBufferLength += inData.length;

    // Denoise complete frames (480 samples each)
    for (; this.denoisedBufferLength + RNNOISE_SAMPLE_LENGTH <= this.inputBufferLength;
         this.denoisedBufferLength += RNNOISE_SAMPLE_LENGTH) {
      const frame = this.circularBuffer.subarray(
        this.denoisedBufferLength,
        this.denoisedBufferLength + RNNOISE_SAMPLE_LENGTH
      );
      const vadScore = this.processor.processFrame(frame);
      this.vadAccumulator += vadScore;
      this.vadCount++;
    }

    // Post average VAD score when we have accumulated results (~10Hz)
    if (this.vadCount > 0) {
      this.port.postMessage({ vadScore: this.vadAccumulator / this.vadCount });
      this.vadAccumulator = 0;
      this.vadCount = 0;
    }

    // Output denoised audio
    let unsentLength: number;
    if (this.denoisedBufferIndx > this.denoisedBufferLength) {
      unsentLength = this.circularBufferLength - this.denoisedBufferIndx;
    } else {
      unsentLength = this.denoisedBufferLength - this.denoisedBufferIndx;
    }

    if (unsentLength >= outData.length) {
      outData.set(
        this.circularBuffer.subarray(this.denoisedBufferIndx, this.denoisedBufferIndx + outData.length)
      );
      this.denoisedBufferIndx += outData.length;
    }

    // Handle circular buffer rollover
    if (this.denoisedBufferIndx === this.circularBufferLength) {
      this.denoisedBufferIndx = 0;
    }
    if (this.inputBufferLength === this.circularBufferLength) {
      this.inputBufferLength = 0;
      this.denoisedBufferLength = 0;
    }

    return true;
  }
}

registerProcessor('NoiseSuppressorWorklet', NoiseSuppressorWorklet);
```

**Step 2: Commit**

```bash
git add src/audio/rnnoise-worklet.ts
git commit -m "feat: add RNNoise AudioWorklet processor with VAD"
```

---

### Task 3: Configure webpack to build the worklet + copy WASM

**Files:**
- Modify: `webpack.config.js`

The worklet must be a separate JS file (not bundled with the main background entry). Add it as a separate entry point and copy the rnnoise WASM file.

**Step 1: Add worklet entry and WASM copy**

Add to `webpack.config.js`:

1. New entry: `'background/rnnoise-worklet': './src/audio/rnnoise-worklet.ts'`
2. CopyPlugin pattern for the rnnoise WASM: `{ from: 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', to: 'background/' }`

The worklet entry needs to output as a plain script (no module wrapper). Since webpack wraps entries in IIFE by default, we need to ensure the worklet's `registerProcessor` call is reachable. The simplest approach: set `output.library` to undefined for this entry, or use a raw-loader approach.

Actually, AudioWorklet scripts can't use ES modules or require() — they need to be self-contained. The cleanest approach for Overwolf:

1. Keep the worklet as a plain `.js` file (not a webpack entry)
2. Copy it via CopyPlugin along with the WASM
3. Import the rnnoise WASM module inline using `importScripts()` in the worklet

**Revised approach — use CopyPlugin for the worklet file too:**

Update `webpack.config.js` CopyPlugin patterns to add:
```javascript
// RNNoise WASM + worklet
{ from: 'node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm', to: 'background/' },
```

And compile the worklet separately by adding a second entry point:
```javascript
entry: {
  background: './src/background/background.ts',
  overlay: './src/overlay/overlay.ts',
  'rnnoise-worklet': './src/audio/rnnoise-worklet.ts',
},
```

With output filename pattern `[name]/[name].js` this will create `rnnoise-worklet/rnnoise-worklet.js`. But we want it in `background/`. So adjust the output:

```javascript
output: {
  filename: (pathData) => {
    if (pathData.chunk?.name === 'rnnoise-worklet') return 'background/rnnoise-worklet.js';
    return '[name]/[name].js';
  },
  path: path.resolve(__dirname, 'dist'),
  clean: true,
},
```

**Step 2: Verify build**

Run: `npx webpack`
Expected: No errors, `dist/background/rnnoise-worklet.js` and `dist/background/rnnoise.wasm` exist.

**Step 3: Commit**

```bash
git add webpack.config.js
git commit -m "chore: configure webpack for RNNoise worklet + WASM"
```

---

### Task 4: Integrate RNNoise into AudioService

**Files:**
- Modify: `src/services/audio.ts`

Replace the current audio pipeline:
- **Before:** mic → gain → analyser → destination (browser noiseSuppression, energy VAD)
- **After:** mic → gain → rnnoiseWorklet → destination (RNNoise denoising + VAD)

**Step 1: Update initMicrophone to load RNNoise worklet**

In `audio.ts`, modify `initMicrophone()`:

1. Remove `noiseSuppression: true` from getUserMedia constraints (RNNoise replaces it)
2. Keep `echoCancellation: true` and `autoGainControl: true`
3. Load the worklet module: `await audioContext.audioWorklet.addModule('rnnoise-worklet.js')`
4. Create the worklet node: `new AudioWorkletNode(audioContext, 'NoiseSuppressorWorklet')`
5. Wire: source → gain → rnnoiseNode → destination
6. Listen for VAD messages on the worklet port
7. Remove the AnalyserNode and vadBuffer (no longer needed)

**Step 2: Replace updateVAD with worklet port listener**

Remove:
- `analyser` field and setup
- `vadBuffer` field
- `updateVAD()` method entirely
- `vadLogCounter` field

Add: Port message listener in `initMicrophone()` that updates `vadActive`:
```typescript
this.rnnoiseNode.port.onmessage = (event) => {
  const { vadScore } = event.data;
  const wasActive = this.vadActive;
  this.vadActive = vadScore > 0.5; // RNNoise VAD threshold
  if (this.vadActive !== wasActive) {
    this.updateLocalTrackState();
  }
};
```

**Step 3: Remove updateVAD calls from orchestrator**

Search for any `updateVAD()` calls in the codebase and remove them — VAD is now event-driven from the worklet port, not polled.

**Step 4: Verify build**

Run: `npx webpack`
Expected: Compiles without errors.

**Step 5: Commit**

```bash
git add src/services/audio.ts src/services/orchestrator.ts
git commit -m "feat: integrate RNNoise worklet for noise suppression + VAD"
```

---

### Task 5: Clean up and verify

**Files:**
- Modify: `src/services/audio.ts` (remove dead code)

**Step 1: Remove unused imports/fields**

Remove any remaining references to AnalyserNode, vadBuffer, vadLogCounter, frequency data analysis.

**Step 2: Build and test**

Run: `npx webpack`
Expected: Clean compile.

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: clean up old VAD code after RNNoise migration"
```

---

## Notes

- **Overwolf AudioWorklet support:** Overwolf uses Chromium, which supports AudioWorklet. The worklet file must be served from the same origin (the `dist/background/` directory).
- **Sample rate:** RNNoise expects 48kHz. AudioContext in Chromium defaults to the system sample rate. If the system sample rate isn't 48kHz, we may need to add resampling. For v1, assume 48kHz (standard for most gaming setups).
- **Fallback:** If worklet loading fails (permissions, old Overwolf version), fall back to the browser's built-in noiseSuppression with the old energy VAD. Log a warning.
- **VAD threshold:** 0.5 is a reasonable starting point. Can be tuned later based on testing.
