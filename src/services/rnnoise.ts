/**
 * RNNoise wrapper: noise suppression + VAD via WASM.
 *
 * Loads the @jitsi/rnnoise-wasm Emscripten module on the main thread.
 * Audio is processed through a ScriptProcessorNode in 480-sample frames.
 * Each frame returns a VAD score (0.0-1.0) alongside denoised audio.
 */

// @ts-ignore — Emscripten module, no TS declarations
import createRNNWasmModule from '@jitsi/rnnoise-wasm/dist/rnnoise';

const RNNOISE_SAMPLE_LENGTH = 480;
const SHIFT_16_BIT = 32768; // float32 ↔ int16 range conversion

export interface RnnoiseNode {
  /** The ScriptProcessorNode to insert into the audio graph */
  scriptNode: ScriptProcessorNode;
  /** Current VAD score (0.0 = silence, 1.0 = voice). Updated per-frame. */
  getVadScore(): number;
  /** Clean up WASM resources */
  destroy(): void;
}

export async function createRnnoiseNode(audioContext: AudioContext): Promise<RnnoiseNode> {
  // Load the Emscripten module (fetches + compiles WASM)
  const wasmModule = await createRNNWasmModule();

  // Create rnnoise context
  const context = wasmModule._rnnoise_create(0);

  // Allocate WASM heap memory for one frame
  const byteSize = RNNOISE_SAMPLE_LENGTH * 4; // float32
  const pcmPtr = wasmModule._malloc(byteSize);
  const pcmF32Index = pcmPtr >> 2; // index into HEAPF32

  // Buffer to accumulate samples (ScriptProcessor delivers variable-size chunks)
  let inputBuffer = new Float32Array(0);
  let vadScore = 0;

  // Use 4096 buffer for ScriptProcessorNode (good balance of latency vs efficiency)
  const scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

  scriptNode.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    // Merge leftover buffer with new input
    const combined = new Float32Array(inputBuffer.length + input.length);
    combined.set(inputBuffer);
    combined.set(input, inputBuffer.length);

    let offset = 0;
    let outputOffset = 0;
    let frameVadSum = 0;
    let frameCount = 0;

    // Process complete 480-sample frames
    while (offset + RNNOISE_SAMPLE_LENGTH <= combined.length) {
      // Copy to WASM heap (scaled to int16 range)
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
        wasmModule.HEAPF32[pcmF32Index + i] = combined[offset + i] * SHIFT_16_BIT;
      }

      // Denoise in-place, get VAD score
      const score = wasmModule._rnnoise_process_frame(context, pcmPtr, pcmPtr);
      frameVadSum += score;
      frameCount++;

      // Copy denoised audio back
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i++) {
        combined[offset + i] = wasmModule.HEAPF32[pcmF32Index + i] / SHIFT_16_BIT;
      }

      offset += RNNOISE_SAMPLE_LENGTH;
    }

    // Update VAD score (average across frames in this buffer)
    if (frameCount > 0) {
      vadScore = frameVadSum / frameCount;
    }

    // Copy processed audio to output (up to output buffer size)
    const toCopy = Math.min(offset, output.length);
    output.set(combined.subarray(0, toCopy));

    // If output is longer than processed data, zero-fill the rest
    if (toCopy < output.length) {
      output.fill(0, toCopy);
    }

    // Save unprocessed remainder for next callback
    inputBuffer = combined.slice(offset);
  };

  return {
    scriptNode,
    getVadScore: () => vadScore,
    destroy: () => {
      wasmModule._rnnoise_destroy(context);
      wasmModule._free(pcmPtr);
    },
  };
}
