# LoLProxChat v2 - Design Document

## Problem

The v1 CV pipeline (ring correlation + histogram matching) is unreliable. It locks onto map structures instead of the player's champion, produces stuck/wrong positions, and the enemy detection generates excessive false positives. Position data is also broadcast in plaintext over Supabase, creating potential anti-cheat concerns.

## Core Changes

1. Replace the CV pipeline with a scan-lock-track state machine for precise, fast local position tracking
2. Move position data to WebRTC data channels (P2P, off Supabase)
3. Encrypt position data so no client ever sees another player's coordinates
4. Compute volumes server-side via a stateless Supabase Edge Function
5. Remove all client-side enemy detection, distance calculation, and vision gating

## CV Pipeline: Scan -> Lock -> Track

### Three States

**SCANNING** (cold start, respawn, teleport detection, correlation loss)

1. Divide minimap into a grid of sectors sized to the expected icon diameter (~41px).
2. Pre-filter each sector for teal border ring presence (fast HSV check on pixels around the sector perimeter). Skip sectors without teal.
3. For sectors that pass: extract the inner portrait circle, compare against pre-built downscaled templates of the local champion (all skin variants). Use normalized cross-correlation (NCC).
4. Pick the sector with the best match score above a confidence threshold.
5. On match: capture the actual minimap pixel region as the tracking template. Transition to LOCKED.

**LOCKED** (steady-state tracking)

1. Each frame: slide the tracking template within a small window (~1.5 icon diameters, roughly 60x60 pixels) around the last known position. Find the peak NCC score.
2. Output the center of the best match as the player's pixel position. Convert to game coordinates.
3. If NCC score drops below a quality threshold: transition to SCANNING.
4. GEP death event: transition to DEAD.

**DEAD** (player died)

1. Freeze position at death location. Continue sending this position to the Edge Function (dead players are still hearable by nearby players).
2. GEP respawn event: transition to SCANNING (icon reappears at fountain).

### Template References

- **Cold start templates:** Pre-built at build time by the existing icon scraper. Downscale all champion/skin icons to minimap icon size (~20x20 circular portrait crop). Bundled in the app.
- **Tracking template:** Captured from the actual minimap pixels once the champion is found during SCANNING. Matches the exact rendering at the current minimap scale, skin, and game resolution. Used for frame-to-frame tracking in LOCKED state.

### Re-scan Triggers

- NCC correlation drops below quality threshold (icon obscured by ability effect, overlay, etc.)
- GEP respawn event
- GEP teleport-related events (as available)
- Fallback: if tracking template hasn't moved for an abnormally long time and the player isn't dead

## Secure Position Sharing

### Threat Model

A modified client could extract enemy position data and display it as a map hack. The system must ensure no client ever receives another player's raw coordinates.

### Architecture

Supabase stays for WebRTC signaling (offer/answer/ICE exchange). Position data moves to WebRTC data channels (P2P) in encrypted form that only the server can read.

### Flow

1. The Supabase Edge Function holds a secret AES-256-GCM key as an environment variable. This key never leaves the server.
2. Each client calls the Edge Function at ~8Hz with:
   ```json
   {
     "myPosition": { "x": 1234, "y": 5678 },
     "peers": {
       "summonerName1": "<encrypted blob>",
       "summonerName2": "<encrypted blob>"
     }
   }
   ```
3. The Edge Function:
   - Encrypts `myPosition` into an opaque blob (AES-256-GCM + timestamp to prevent replay).
   - Decrypts each peer blob to recover their positions.
   - Computes distance from `myPosition` to each peer position.
   - Maps distances to volume levels using logarithmic falloff (same curve as v1).
   - Returns:
   ```json
   {
     "myBlob": "<encrypted position>",
     "peerVolumes": {
       "summonerName1": 0.73,
       "summonerName2": 0.0
     }
   }
   ```
4. The client broadcasts `myBlob` to all peers over WebRTC data channels.
5. The client applies `peerVolumes` directly to audio streams.

### Security Properties

- Clients never receive another player's raw coordinates.
- The encrypted blob is opaque to all clients (AES-256-GCM with server-only key).
- Timestamps in blobs prevent replay attacks (stale blobs are rejected).
- The Edge Function is stateless — positions exist only for the duration of the computation.
- Even a fully compromised client only learns volume levels (0.0-1.0), which reveal at most "someone is roughly this close to me."

## Audio Volume Logic

### Server-Side Computation

All distance-to-volume mapping happens in the Edge Function. The client receives a volume number per peer and applies it directly. No client-side distance calculation, vision gating, or overlap detection.

Volume curve (same as v1):
- `MAX_HEARING_RANGE = 1200` game units
- Logarithmic falloff: `volume = max(0, 1 - log(1 + normalized * (e - 1)))`
- Beyond max range: volume = 0.0

### Client-Side Audio

The AudioService simplifies to:
- Receive `peerVolumes` from Edge Function response
- For each peer: `setVolume(vol)`, `unmute()` if vol > 0, `mute()` if vol = 0
- Mute controls (self-mute, mute-all, mute-player) remain client-side as local UI preferences

### Game Start Behavior

Before CV locks on (first few seconds at fountain): pass through all ally audio at full volume. Once the first Edge Function response with real volumes arrives, switch to server-computed values.

### Dead Players

Dead players freeze their position at death location. The Edge Function computes volumes normally — dead players are hearable by nearby players and can hear nearby players. On respawn, CV re-scans and position updates resume.

## Component Changes

### Stays the Same
- Supabase for WebRTC signaling (offer/answer/ICE)
- WebRTC peer-to-peer audio streams
- PeerConnection class
- Overlay UI
- GEP for game detection, player list, death/respawn events
- Minimap screen capture via Overwolf API
- Champion fingerprint database / icon scraper (extended with downscaled templates)
- Mute controls (client-side)

### Major Rewrites
- **MinimapCVService** -> **TrackingService**: Sector scan + template match + lock-on tracking state machine. Replaces ring correlation, histogram matching, blob clustering, camera rectangle detection.
- **SignalingService**: Stop broadcasting positions over Supabase. Positions move to data channels.
- **AudioService**: Remove all volume/distance/vision logic. Volume comes from Edge Function. Simplify to setVolume/mute/unmute.
- **Orchestrator**: New flow: CV produces position -> Edge Function encrypts + computes volumes -> broadcast blob over data channels -> apply volumes.

### New Components
- **Supabase Edge Function** (`compute-volumes`): Stateless function that encrypts positions, computes distances, returns volume levels.
- **DataChannelService**: Manages WebRTC data channels for encrypted position blob exchange alongside audio.

### Deleted
- Ring correlation, enemy red pixel scanning, `getClosestEnemyProximity`, `isEnemyVisibleOnMinimap`
- Overlap-managed volume system (`overlapManagedPlayers`, `setEnemyOverlapVolume`, `clearOverlapManaged`)
- Vision-muted player tracking (`visionMutedPlayers`, `setEnemyVisible`)
- Client-side `calculateDistance` / `calculateVolume` for peer audio
- Portrait density filtering, `hasTealHalo`, blob clustering fallbacks

## Data Flow

```
Game Start:
  GEP -> player list, champion, team
  -> Join Supabase room (signaling only)
  -> WebRTC connections established (audio + data channels)
  -> All ally audio at full volume (fountain)
  -> CV starts SCANNING for local champion icon

Steady State (per tick, ~8Hz):
  CV (LOCKED) -> local pixel position -> game coordinates
  |
  POST to Edge Function: { myPosition, peerBlobs }
  |
  Edge Function:
    - Encrypts myPosition -> myBlob
    - Decrypts each peerBlob -> peer positions
    - Computes distance to each peer -> volume levels
    - Returns { myBlob, peerVolumes }
  |
  Broadcast myBlob to all peers over data channels
  Apply peerVolumes to audio streams

CV State Machine:
  SCANNING -> (template match found) -> LOCKED
  LOCKED -> (correlation drop OR GEP teleport) -> SCANNING
  LOCKED -> (GEP death) -> DEAD
  DEAD -> (GEP respawn) -> SCANNING
```

## Latency Budget

- CV frame processing (template slide in 60x60 window): ~5-10ms
- Edge Function round trip: ~30-50ms
- Data channel broadcast: ~10ms
- Total: ~50-70ms per tick
- At 8Hz (125ms ticks): fits comfortably with margin

## Tech Stack Additions

- Supabase Edge Functions (Deno runtime)
- WebRTC RTCDataChannel API
- AES-256-GCM (Web Crypto API on server, opaque blobs on client)
- Normalized cross-correlation for template matching
