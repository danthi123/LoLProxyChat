# LoLProxChat - Design Document

## Core Concept

An Overwolf app that enables proximity-based voice chat in League of Legends. Players running the app hear nearby players (friend or foe) with volume scaling by distance, tied to in-game vision - if you can't see them on the minimap, you can't hear them.

## Architecture

**Platform:** Overwolf (HTML/CSS/TypeScript)

**Data flow:**

1. App reads local minimap via screen capture -> computer vision extracts own champion position
2. Player's position is sent to other app users in the same game via Supabase Realtime
3. Each client computes distances to other players locally
4. WebRTC peer-to-peer audio streams are established between players within max vision range
5. Audio volume is adjusted per-stream using logarithmic falloff based on distance
6. If a player's icon disappears from your minimap (fog/invis/bush), their audio stream is muted client-side

**Signaling:** Supabase Realtime (free tier, self-hostable later)
**NAT traversal:** Google public STUN servers + free TURN fallback
**Audio:** WebRTC peer-to-peer, no audio touches any server

## Game Detection & Player Matching

- Overwolf GEP detects game start, provides player list (summoner names, champions, teams)
- App creates/joins a Supabase room keyed by a hash of the sorted player names in the game (deterministic - all players in the same game compute the same room ID)
- Streamer mode detection: if a player's displayed name matches their champion name, they are excluded from the network entirely

## Minimap Computer Vision

- Overwolf screen capture API grabs the minimap region
- CV identifies the local player's champion icon on the minimap
- Converts pixel position to game-unit coordinates using known map dimensions
- Polls at ~4-5 times/sec for smooth audio transitions
- Works across maps (Summoner's Rift, Howling Abyss, etc.) by detecting map type from GEP

## Vision-Based Audio Cutoff

- For enemies: continuously check if their champion icon is visible on your minimap
- Icon present -> audio stream active (volume by distance)
- Icon absent (fog, bush, invisibility) -> stream muted instantly
- For allies: always audible within range (allies are always visible on minimap)
- Dead champions with visible icons on minimap: still audible within range

## Audio System

- **Input:** push-to-talk OR voice activity detection (user setting)
- **Input volume:** adjustable
- **Output:** per-player volume control
- **Distance falloff:** logarithmic curve, max range = vision range (~1200 game units)
- **Muting:** self-mute, mute all, mute by player name - muted state is visible to other players

## Overlay UI

- Small, semi-transparent, draggable widget
- Default position: above the alive/dead player icons near the minimap
- Shows: list of connected nearby players (champion icon + name), their distance/volume indicator, individual mute buttons
- Global controls: self-mute toggle, mute-all toggle, push-to-talk indicator
- Settings accessible via gear icon: input mode (PTT/VAD), PTT keybind, input volume, per-player output volume
- Muted players show a mute icon visible to everyone

## Anti-Cheat Considerations

- Each client only reports its own position - no client ever receives a full map state
- Position data is ephemeral (not stored beyond the current session)
- No aggregated position data exists anywhere that could be exploited
- **Future work:** minimap validation to detect fake/overlay maps

## ToS Compliance

- No memory reading or packet sniffing
- Uses only Overwolf GEP (Riot-sanctioned) + screen capture of own display
- Overwolf platform is officially partnered with Riot Games
- Position data is self-reported, not extracted from game internals

## Tech Stack

- **Language:** TypeScript
- **Platform:** Overwolf SDK
- **CV:** OpenCV.js or TensorFlow.js (minimap reading)
- **Voice:** WebRTC (browser-native in Overwolf's Chromium)
- **Signaling:** Supabase Realtime
- **Build:** Overwolf CLI tooling
