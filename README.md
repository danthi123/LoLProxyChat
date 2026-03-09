# LoLProxChat

Proximity voice chat for League of Legends. Hear nearby players with volume that scales by in-game distance, tied to minimap vision -- if you can't see them, you can't hear them.

## How It Works

1. **Position detection** -- Screen captures the minimap, uses HSV color filtering + blob detection to find champion icons, then an ONNX neural network classifier identifies which blob is your champion
2. **Signaling** -- Players in the same game join a shared Supabase Realtime room (room ID derived from sorted player names)
3. **Voice** -- WebRTC peer-to-peer audio streams between players; no audio touches any server
4. **Volume** -- A Supabase Edge Function computes encrypted proximity volumes so no client knows another's exact position; logarithmic falloff up to 1200 game units

## Architecture

```
Overwolf App
├── background window     -- orchestrator, GEP, signaling, tracking, audio
├── overlay window        -- draggable widget with nearby players, mute controls
└── supabase/
    └── compute-volumes/  -- Edge Function for server-side volume computation
```

**Key services:**
- `TrackingService` -- minimap CV pipeline (capture → HSV mask → blob detect → classifier scoring → position)
- `ChampionClassifier` -- ONNX Runtime Web (WASM) inference for champion icon identification
- `AudioService` -- WebRTC audio with VAD/PTT, per-peer volume control
- `SignalingService` -- Supabase Realtime presence + position broadcast
- `VolumeClient` -- calls Edge Function with encrypted position blobs
- `DataChannelService` -- WebRTC data channels for encrypted blob exchange

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Overwolf](https://www.overwolf.com/) with a developer account
- A [Supabase](https://supabase.com/) project (free tier works)

### Install & Build

```bash
npm install
cp .env.example .env
# Edit .env with your Supabase URL and anon key
npx webpack
```

### Run in Overwolf

1. Open Overwolf Settings → About → Development Options
2. Click **Load unpacked extension**
3. Select the `dist/` folder
4. Launch League of Legends -- the app starts automatically

### Train the Champion Classifier (optional)

The pre-trained ONNX model is included in `models/`. To retrain:

```bash
# Requires Python 3.10+, PyTorch, ONNX, Pillow
# Place champion circle icons in assets/champion-circles/<ChampionName>/*.png
python scripts/train_champion_classifier.py
```

### Deploy Edge Function

```bash
npx supabase functions deploy compute-volumes
```

## Project Structure

```
src/
├── background/          -- background window entry point
├── overlay/             -- overlay window (HTML/CSS/TS)
├── core/                -- pure logic modules (tested)
│   ├── types.ts
│   ├── proximity.ts
│   ├── map-calibration.ts
│   └── streamer-detect.ts
└── services/            -- runtime services
    ├── orchestrator.ts
    ├── tracking.ts
    ├── champion-classifier.ts
    ├── audio.ts
    ├── signaling.ts
    ├── peer-connection.ts
    ├── game-state.ts
    ├── gep.ts
    ├── volume-client.ts
    └── data-channel.ts
models/
├── champion_classifier.onnx   -- trained ONNX model (~1.7MB)
└── champion_labels.json       -- class index → champion name
scripts/
└── train_champion_classifier.py
supabase/functions/
└── compute-volumes/index.ts
```

## Acknowledgements

- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) and its [wiki](https://github.com/Maknee/LeagueMinimapDetectionCNN/wiki) -- reference code and champion circle assets used for the minimap detection and classifier training pipeline

## License

Private -- not yet licensed for redistribution.
