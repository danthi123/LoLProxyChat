# LoLProxChat

Proximity voice chat for League of Legends. Hear nearby players with volume that scales by in-game distance, tied to minimap vision -- if you can't see them, you can't hear them.

## How It Works

1. **Position detection** -- Screen captures the minimap, uses HSV color filtering + blob detection to find champion icons, then an ONNX neural network classifier identifies which blob is your champion
2. **Signaling** -- Players in the same game join a shared Supabase Realtime room (room ID derived from sorted player names)
3. **Voice** -- WebRTC peer-to-peer audio streams between players; no audio touches any server
4. **Proximity volume** -- A Supabase Edge Function computes encrypted proximity volumes so no client knows another's exact position; logarithmic falloff up to 1200 game units
5. **Audio processing** -- RNNoise WASM for noise suppression + voice activity detection, Opus codec at 128kbps with DTX for bandwidth efficiency

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
- `AudioService` -- WebRTC audio with RNNoise VAD/PTT, per-peer volume control
- `RNNoise` -- WASM noise suppression + VAD via ScriptProcessorNode
- `SignalingService` -- Supabase Realtime presence + position broadcast
- `PeerConnection` -- WebRTC with Opus 128kbps + DTX, TURN credential generation
- `VolumeClient` -- calls Edge Function with encrypted position blobs
- `DataChannelService` -- WebRTC data channels for encrypted blob exchange

## Setup

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Overwolf](https://www.overwolf.com/) with a developer account
- A [Supabase](https://supabase.com/) instance (cloud free tier or self-hosted)
- A [coturn](https://github.com/coturn/coturn) TURN server (optional, for NAT traversal)

### Install & Build

```bash
npm install
cp .env.example .env
# Edit .env with your Supabase URL, anon key, and optionally TURN server/secret
npx webpack
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous/public API key |
| `TURN_SERVER` | TURN server hostname (optional) |
| `TURN_SECRET` | coturn shared secret for HMAC credentials (optional) |

### Run in Overwolf

1. Open Overwolf Settings → About → Development Options
2. Click **Load unpacked extension**
3. Select the `dist/` folder
4. Launch League of Legends -- the app starts automatically

### Self-Hosted Supabase (optional)

You can self-host Supabase using their [Docker setup](https://supabase.com/docs/guides/self-hosting/docker). The app only uses:
- **Realtime** -- for signaling (presence + broadcast channels)
- **Edge Functions** -- for server-side volume computation
- No database tables or auth required

Deploy the edge function to your instance:

```bash
npx supabase functions deploy compute-volumes
```

### Train the Champion Classifier (optional)

The pre-trained ONNX model is included in `models/`. To retrain:

```bash
# Requires Python 3.10+, PyTorch, ONNX, Pillow
# Place champion circle icons in assets/champion-circles/<ChampionName>/*.png
python scripts/train_champion_classifier.py
```

## Project Structure

```
src/
├── background/          -- background window entry point
├── overlay/             -- overlay window (HTML/CSS/TS)
├── core/                -- pure logic modules (tested)
│   ├── config.ts
│   ├── types.ts
│   ├── room.ts
│   ├── proximity.ts
│   ├── map-calibration.ts
│   ├── template-match.ts
│   └── streamer-detect.ts
└── services/            -- runtime services
    ├── orchestrator.ts
    ├── tracking.ts
    ├── champion-classifier.ts
    ├── audio.ts
    ├── rnnoise.ts
    ├── signaling.ts
    ├── peer-connection.ts
    ├── game-state.ts
    ├── gep.ts
    ├── volume-client.ts
    └── data-channel.ts
models/
├── champion_classifier.onnx   -- trained ONNX model
└── champion_labels.json       -- class index → champion name
scripts/
└── train_champion_classifier.py
supabase/functions/
└── compute-volumes/index.ts
```

## Acknowledgements

- [LeagueMinimapDetectionCNN](https://github.com/Maknee/LeagueMinimapDetectionCNN) -- reference code for minimap detection
- [League of Legends Wiki](https://wiki.leagueoflegends.com) -- champion circle icon assets used for classifier training
- [RNNoise](https://jmvalin.ca/demo/rnnoise/) -- noise suppression via [@jitsi/rnnoise-wasm](https://github.com/nicknisi/rnnoise-wasm)

## License

[PolyForm Noncommercial 1.0.0](LICENSE) -- source available for personal and noncommercial use only.

Champion icon assets from the [League of Legends Wiki](https://wiki.leagueoflegends.com) (CC BY-SA 3.0) were used for model training only and are not distributed with this software.
