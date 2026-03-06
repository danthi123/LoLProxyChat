# LoLProxChat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Overwolf app that enables proximity-based voice chat in League of Legends, with volume scaling by distance and vision-based audio cutoff.

**Architecture:** Overwolf app with a background window (logic/networking) and an in-game overlay (UI). Minimap CV extracts the local player's position. Supabase Realtime handles signaling and position sharing. WebRTC provides P2P voice. All proximity/volume logic runs client-side.

**Tech Stack:** TypeScript, Overwolf SDK, OpenCV.js, WebRTC, Supabase JS client, Webpack

---

### Task 1: Project Scaffolding

**Files:**
- Create: `manifest.json`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `webpack.config.js`
- Create: `src/background/background.html`
- Create: `src/background/background.ts`
- Create: `src/overlay/overlay.html`
- Create: `src/overlay/overlay.ts`
- Create: `src/overlay/overlay.css`
- Create: `icons/IconMouseOver.png` (placeholder)
- Create: `icons/IconMouseNormal.png` (placeholder)

**Step 1: Initialize npm project**

Run: `npm init -y`

**Step 2: Install dependencies**

Run: `npm install --save-dev typescript webpack webpack-cli ts-loader copy-webpack-plugin`
Run: `npm install @supabase/supabase-js`

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "sourceMap": true,
    "declaration": false,
    "lib": ["ES2020", "DOM"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create webpack.config.js**

```javascript
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  entry: {
    background: './src/background/background.ts',
    overlay: './src/overlay/overlay.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: '[name]/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'icons', to: 'icons' },
        { from: 'src/background/background.html', to: 'background/' },
        { from: 'src/overlay/overlay.html', to: 'overlay/' },
        { from: 'src/overlay/overlay.css', to: 'overlay/' },
      ],
    }),
  ],
};
```

**Step 5: Create manifest.json**

League of Legends game ID in Overwolf is `5426`. The manifest needs:
- Background window (logic, always running)
- Overlay window (in-game UI, transparent, clickthrough except for widget)
- Permissions: GameInfo, Streaming (for screen capture), Hotkeys
- GEP targeting for LoL

```json
{
  "manifest_version": 1,
  "type": "WebApp",
  "meta": {
    "name": "LoLProxChat",
    "author": "LoLProxChat",
    "version": "0.1.0",
    "minimum-overwolf-version": "0.230.0",
    "minimum-gep-version": "0.230.0",
    "description": "Proximity voice chat for League of Legends",
    "dock_button_title": "ProxChat",
    "icon": "icons/IconMouseOver.png",
    "icon_gray": "icons/IconMouseNormal.png"
  },
  "permissions": ["GameInfo", "Streaming", "Hotkeys", "Media"],
  "data": {
    "game_targeting": {
      "type": "dedicated",
      "game_ids": [5426]
    },
    "start_window": "background",
    "enable_top_isolation": true,
    "windows": {
      "background": {
        "file": "background/background.html",
        "is_background_page": true,
        "show_in_taskbar": false
      },
      "overlay": {
        "file": "overlay/overlay.html",
        "transparent": true,
        "resizable": false,
        "clickthrough": true,
        "in_game_only": true,
        "topmost": true,
        "size": {
          "width": 280,
          "height": 400
        },
        "start_position": {
          "left": 10,
          "bottom": 200
        },
        "style": "inputPassThrough"
      }
    },
    "hotkeys": {
      "push_to_talk": {
        "title": "Push to Talk",
        "action-type": "hold",
        "default": "V"
      },
      "toggle_mute": {
        "title": "Toggle Self Mute",
        "action-type": "toggle",
        "default": "M"
      }
    },
    "launch_events": [
      {
        "event": "GameLaunch",
        "event_data": {
          "game_ids": [5426]
        }
      }
    ]
  }
}
```

**Step 6: Create background HTML and stub TS**

`src/background/background.html`:
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>LoLProxChat Background</title></head>
<body><script src="background.js"></script></body></html>
```

`src/background/background.ts`:
```typescript
console.log('LoLProxChat background service started');
```

**Step 7: Create overlay HTML, CSS, and stub TS**

`src/overlay/overlay.html`:
```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>LoLProxChat</title>
<link rel="stylesheet" href="overlay.css"></head>
<body><div id="proxchat-root"></div><script src="overlay.js"></script></body></html>
```

`src/overlay/overlay.css`:
```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: transparent; overflow: hidden; font-family: 'Segoe UI', sans-serif; color: #fff; }
```

`src/overlay/overlay.ts`:
```typescript
console.log('LoLProxChat overlay loaded');
```

**Step 8: Create placeholder icons**

Create two 256x256 PNG placeholder icons (solid colored squares are fine for development).

**Step 9: Build and verify**

Run: `npx webpack`
Expected: `dist/` folder created with background/, overlay/, manifest.json, icons/

**Step 10: Commit**

```bash
git init
git add -A
git commit -m "feat: scaffold Overwolf app with background and overlay windows"
```

---

### Task 2: Core Utility Modules (Testable Pure Logic)

**Files:**
- Create: `src/core/room.ts`
- Create: `src/core/proximity.ts`
- Create: `src/core/streamer-detect.ts`
- Create: `src/core/types.ts`
- Create: `tests/core/room.test.ts`
- Create: `tests/core/proximity.test.ts`
- Create: `tests/core/streamer-detect.test.ts`
- Create: `jest.config.js`

**Step 1: Install test dependencies**

Run: `npm install --save-dev jest ts-jest @types/jest`

**Step 2: Create jest.config.js**

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
};
```

**Step 3: Create src/core/types.ts**

```typescript
export interface Player {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  isDead: boolean;
  respawnTimer: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface PeerState {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  position: Position;
  isMuted: boolean;
  isDead: boolean;
}

export interface AudioSettings {
  inputMode: 'ptt' | 'vad';
  inputVolume: number;       // 0.0 - 1.0
  pttKey: string;
  playerVolumes: Record<string, number>; // summonerName -> 0.0-1.0
}

export type MapType = 'summoners_rift' | 'howling_abyss' | 'unknown';

export const MAP_DIMENSIONS: Record<MapType, { width: number; height: number }> = {
  summoners_rift: { width: 14870, height: 14980 },
  howling_abyss: { width: 12988, height: 12988 },
  unknown: { width: 14870, height: 14980 },
};

export const MAX_HEARING_RANGE = 1200; // game units, ~vision range
```

**Step 4: Write failing tests for room ID generation**

`tests/core/room.test.ts`:
```typescript
import { generateRoomId } from '../../src/core/room';

describe('generateRoomId', () => {
  it('produces a deterministic hash from sorted player names', () => {
    const players = ['Alice', 'Bob', 'Charlie'];
    const id1 = generateRoomId(players);
    const id2 = generateRoomId(players);
    expect(id1).toBe(id2);
  });

  it('produces the same hash regardless of input order', () => {
    const id1 = generateRoomId(['Charlie', 'Alice', 'Bob']);
    const id2 = generateRoomId(['Bob', 'Charlie', 'Alice']);
    expect(id1).toBe(id2);
  });

  it('produces different hashes for different player sets', () => {
    const id1 = generateRoomId(['Alice', 'Bob']);
    const id2 = generateRoomId(['Alice', 'Charlie']);
    expect(id1).not.toBe(id2);
  });

  it('returns a non-empty string', () => {
    const id = generateRoomId(['Player1']);
    expect(id.length).toBeGreaterThan(0);
  });
});
```

**Step 5: Run test to verify it fails**

Run: `npx jest tests/core/room.test.ts`
Expected: FAIL - cannot find module

**Step 6: Implement room.ts**

`src/core/room.ts`:
```typescript
export function generateRoomId(playerNames: string[]): string {
  const sorted = [...playerNames].sort();
  const combined = sorted.join('|');
  // Simple djb2 hash - no crypto needed, just needs to be deterministic
  let hash = 5381;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
```

**Step 7: Run test to verify it passes**

Run: `npx jest tests/core/room.test.ts`
Expected: PASS

**Step 8: Write failing tests for proximity**

`tests/core/proximity.test.ts`:
```typescript
import { calculateDistance, calculateVolume, isInRange } from '../../src/core/proximity';
import { MAX_HEARING_RANGE } from '../../src/core/types';

describe('calculateDistance', () => {
  it('returns 0 for same position', () => {
    expect(calculateDistance({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(0);
  });

  it('calculates euclidean distance', () => {
    expect(calculateDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('calculateVolume', () => {
  it('returns 1.0 at distance 0', () => {
    expect(calculateVolume(0)).toBe(1.0);
  });

  it('returns 0.0 at max range', () => {
    expect(calculateVolume(MAX_HEARING_RANGE)).toBe(0.0);
  });

  it('returns 0.0 beyond max range', () => {
    expect(calculateVolume(MAX_HEARING_RANGE + 100)).toBe(0.0);
  });

  it('returns higher volume for closer distance (logarithmic)', () => {
    const closeVol = calculateVolume(200);
    const farVol = calculateVolume(800);
    expect(closeVol).toBeGreaterThan(farVol);
  });

  it('returns value between 0 and 1 for mid-range', () => {
    const vol = calculateVolume(600);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });
});

describe('isInRange', () => {
  it('returns true for distance within max range', () => {
    expect(isInRange(500)).toBe(true);
  });

  it('returns false for distance beyond max range', () => {
    expect(isInRange(MAX_HEARING_RANGE + 1)).toBe(false);
  });

  it('returns true at exactly max range', () => {
    expect(isInRange(MAX_HEARING_RANGE)).toBe(true);
  });
});
```

**Step 9: Run test to verify it fails**

Run: `npx jest tests/core/proximity.test.ts`
Expected: FAIL

**Step 10: Implement proximity.ts**

`src/core/proximity.ts`:
```typescript
import { Position, MAX_HEARING_RANGE } from './types';

export function calculateDistance(a: Position, b: Position): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  // Logarithmic falloff: loud up close, drops sharply at range
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - Math.log1p(normalized * (Math.E - 1)) / 1);
}

export function isInRange(distance: number): boolean {
  return distance <= MAX_HEARING_RANGE;
}
```

**Step 11: Run test to verify it passes**

Run: `npx jest tests/core/proximity.test.ts`
Expected: PASS

**Step 12: Write failing tests for streamer detection**

`tests/core/streamer-detect.test.ts`:
```typescript
import { isStreamerMode } from '../../src/core/streamer-detect';
import { Player } from '../../src/core/types';

describe('isStreamerMode', () => {
  it('returns true when summoner name matches champion name', () => {
    const player: Player = {
      summonerName: 'Ahri',
      championName: 'Ahri',
      team: 'ORDER',
      isDead: false,
      respawnTimer: 0,
    };
    expect(isStreamerMode(player)).toBe(true);
  });

  it('returns false when names differ', () => {
    const player: Player = {
      summonerName: 'ProGamer123',
      championName: 'Ahri',
      team: 'ORDER',
      isDead: false,
      respawnTimer: 0,
    };
    expect(isStreamerMode(player)).toBe(false);
  });

  it('is case-insensitive', () => {
    const player: Player = {
      summonerName: 'ahri',
      championName: 'Ahri',
      team: 'ORDER',
      isDead: false,
      respawnTimer: 0,
    };
    expect(isStreamerMode(player)).toBe(true);
  });
});
```

**Step 13: Run test to verify it fails**

Run: `npx jest tests/core/streamer-detect.test.ts`
Expected: FAIL

**Step 14: Implement streamer-detect.ts**

`src/core/streamer-detect.ts`:
```typescript
import { Player } from './types';

export function isStreamerMode(player: Player): boolean {
  return player.summonerName.toLowerCase() === player.championName.toLowerCase();
}
```

**Step 15: Run all tests**

Run: `npx jest`
Expected: All PASS

**Step 16: Commit**

```bash
git add -A
git commit -m "feat: add core modules - room ID, proximity math, streamer detection with tests"
```

---

### Task 3: GEP Integration (Game Detection & Player List)

**Files:**
- Create: `src/services/gep.ts`
- Create: `src/services/game-state.ts`
- Modify: `src/background/background.ts`

**Step 1: Create src/services/gep.ts**

This module wraps the Overwolf GEP API for League of Legends. It listens for game start/end events and extracts the player list from the Live Client Data API.

```typescript
const LOL_GAME_ID = 5426;
const GEP_FEATURES = [
  'live_client_data',
  'matchState',
  'match_info',
  'summoner_info',
  'teams',
  'death',
  'respawn',
  'gameMode',
];

type GameEventCallback = (event: string, data: any) => void;
type InfoUpdateCallback = (info: any) => void;

export class GEPService {
  private onGameEvent: GameEventCallback | null = null;
  private onInfoUpdate: InfoUpdateCallback | null = null;
  private retryCount = 0;
  private readonly maxRetries = 10;

  start(onGameEvent: GameEventCallback, onInfoUpdate: InfoUpdateCallback): void {
    this.onGameEvent = onGameEvent;
    this.onInfoUpdate = onInfoUpdate;

    overwolf.games.events.onNewEvents.addListener((e) => {
      if (this.onGameEvent) {
        for (const event of e.events) {
          this.onGameEvent(event.name, event.data);
        }
      }
    });

    overwolf.games.events.onInfoUpdates2.addListener((info) => {
      if (this.onInfoUpdate) {
        this.onInfoUpdate(info);
      }
    });

    this.registerFeatures();
  }

  private registerFeatures(): void {
    overwolf.games.events.setRequiredFeatures(GEP_FEATURES, (result) => {
      if (result.success) {
        console.log('GEP features registered:', result.supportedFeatures);
        this.retryCount = 0;
      } else {
        if (this.retryCount < this.maxRetries) {
          this.retryCount++;
          console.warn('GEP registration retry ' + this.retryCount + '/' + this.maxRetries);
          setTimeout(() => this.registerFeatures(), 2000);
        } else {
          console.error('GEP feature registration failed after retries');
        }
      }
    });
  }

  stop(): void {
    overwolf.games.events.onNewEvents.removeListener(() => {});
    overwolf.games.events.onInfoUpdates2.removeListener(() => {});
  }
}
```

**Step 2: Create src/services/game-state.ts**

Manages the current game state -- parses player list from Live Client Data, detects game mode and map type.

```typescript
import { Player, MapType } from '../core/types';
import { isStreamerMode } from '../core/streamer-detect';
import { generateRoomId } from '../core/room';

export interface GameSession {
  roomId: string;
  localPlayer: Player;
  allPlayers: Player[];
  eligiblePlayers: Player[]; // excludes streamers
  mapType: MapType;
  gameMode: string;
}

export class GameStateService {
  private session: GameSession | null = null;

  parsePlayerList(liveClientData: any): Player[] {
    if (!liveClientData?.players) return [];
    return liveClientData.players.map((p: any) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team === 'ORDER' ? 'ORDER' : 'CHAOS',
      isDead: p.isDead ?? false,
      respawnTimer: p.respawnTimer ?? 0,
    }));
  }

  createSession(
    allPlayers: Player[],
    localSummonerName: string,
    gameMode: string,
  ): GameSession | null {
    const localPlayer = allPlayers.find(
      (p) => p.summonerName === localSummonerName,
    );
    if (!localPlayer) return null;

    if (isStreamerMode(localPlayer)) {
      console.log('Local player has streamer mode on - not joining proximity chat');
      return null;
    }

    const eligiblePlayers = allPlayers.filter((p) => !isStreamerMode(p));
    const playerNames = allPlayers.map((p) => p.summonerName);
    const roomId = generateRoomId(playerNames);

    const mapType = this.detectMapType(gameMode);

    this.session = {
      roomId,
      localPlayer,
      allPlayers,
      eligiblePlayers,
      mapType,
      gameMode,
    };

    return this.session;
  }

  getSession(): GameSession | null {
    return this.session;
  }

  clearSession(): void {
    this.session = null;
  }

  private detectMapType(gameMode: string): MapType {
    const mode = gameMode.toLowerCase();
    if (mode.includes('aram') || mode.includes('howling')) return 'howling_abyss';
    if (mode.includes('classic') || mode.includes('ranked') || mode.includes('normal'))
      return 'summoners_rift';
    return 'unknown';
  }
}
```

**Step 3: Wire up background.ts**

```typescript
import { GEPService } from '../services/gep';
import { GameStateService } from '../services/game-state';

const gep = new GEPService();
const gameState = new GameStateService();

let localSummonerName = '';

function onGameEvent(name: string, data: any): void {
  console.log('Game event: ' + name, data);

  if (name === 'matchEnd' || name === 'match_end') {
    console.log('Match ended - cleaning up session');
    gameState.clearSession();
    // TODO: disconnect from Supabase room and close WebRTC connections
  }
}

function onInfoUpdate(info: any): void {
  // Capture live client data with full player list
  if (info.feature === 'live_client_data' && info.info?.live_client_data?.all_players) {
    try {
      const playersData = JSON.parse(info.info.live_client_data.all_players);
      const players = gameState.parsePlayerList({ players: playersData });

      if (players.length > 0 && !gameState.getSession()) {
        if (info.info.live_client_data.active_player) {
          const activePlayer = JSON.parse(info.info.live_client_data.active_player);
          localSummonerName = activePlayer.summonerName || '';
        }

        const gameMode = info.info.live_client_data.game_data
          ? JSON.parse(info.info.live_client_data.game_data).gameMode || 'CLASSIC'
          : 'CLASSIC';

        const session = gameState.createSession(players, localSummonerName, gameMode);
        if (session) {
          console.log('Session created: room=' + session.roomId + ', players=' + session.eligiblePlayers.length);
          // TODO: join Supabase room, start minimap CV, open overlay
        }
      }
    } catch (e) {
      console.error('Failed to parse player data:', e);
    }
  }
}

// Listen for game launch
overwolf.games.onGameInfoUpdated.addListener((event) => {
  if (event.gameInfo?.isRunning && event.gameInfo.classId === 5426) {
    console.log('League of Legends detected - starting GEP');
    gep.start(onGameEvent, onInfoUpdate);
  }
});

// Check if game is already running on app start
overwolf.games.getRunningGameInfo((result) => {
  if (result?.classId === 5426) {
    console.log('League of Legends already running - starting GEP');
    gep.start(onGameEvent, onInfoUpdate);
  }
});

console.log('LoLProxChat background service started');
```

**Step 4: Build and verify no compile errors**

Run: `npx webpack`
Expected: Build succeeds

**Step 5: Install Overwolf type declarations**

Run: `npm install --save-dev @overwolf/types`

Update `tsconfig.json` to include Overwolf types:
```json
{
  "compilerOptions": {
    "types": ["@overwolf/types"]
  }
}
```

**Step 6: Build again**

Run: `npx webpack`
Expected: Clean build

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add GEP integration and game state management"
```

---

### Task 4: Supabase Signaling & Position Sharing

**Files:**
- Create: `src/services/signaling.ts`
- Create: `src/core/config.ts`

**Step 1: Create src/core/config.ts**

```typescript
// Configure these values - see docs/SETUP.md
export const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';

// WebRTC STUN/TURN servers
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
```

**Step 2: Create src/services/signaling.ts**

This is the Supabase Realtime integration. It handles:
- Joining/leaving game rooms
- Broadcasting local player position
- Receiving other players' positions
- Exchanging WebRTC signaling (SDP offers/answers, ICE candidates)

```typescript
import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../core/config';
import { Position } from '../core/types';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  position: Position;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;

export class SignalingService {
  private supabase: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private localName: string = '';

  constructor() {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  joinRoom(
    roomId: string,
    localName: string,
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
  ): void {
    this.localName = localName;

    this.channel = this.supabase.channel('game:' + roomId, {
      config: { presence: { key: localName } },
    });

    // Position broadcasts
    this.channel.on('broadcast', { event: 'position' }, ({ payload }) => {
      if (payload.summonerName !== this.localName) {
        onPeerPosition(payload as PositionBroadcast);
      }
    });

    // WebRTC signaling
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const signal = payload as SignalMessage;
      if (signal.to === this.localName) {
        onSignal(signal);
      }
    });

    // Presence tracking for leave detection
    this.channel.on('presence', { event: 'leave' }, ({ key }) => {
      if (key) onPeerLeave(key);
    });

    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Joined room game:' + roomId);
        this.channel!.track({ summonerName: localName });
      }
    });
  }

  broadcastPosition(data: PositionBroadcast): void {
    this.channel?.send({
      type: 'broadcast',
      event: 'position',
      payload: data,
    });
  }

  sendSignal(signal: SignalMessage): void {
    this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: signal,
    });
  }

  leaveRoom(): void {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
  }
}
```

**Step 3: Build to verify**

Run: `npx webpack`
Expected: Clean build

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Supabase signaling service for room management and position sharing"
```

---

### Task 5: WebRTC Audio System

**Files:**
- Create: `src/services/audio.ts`
- Create: `src/services/peer-connection.ts`

**Step 1: Create src/services/peer-connection.ts**

Manages a single WebRTC peer connection with one other player.

```typescript
import { ICE_SERVERS } from '../core/config';

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  readonly remoteName: string;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;

  constructor(remoteName: string) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.pc.ontrack = (event) => {
      this.remoteStream.addTrack(event.track);
    };
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  setVolume(volume: number): void {
    this.audioElement.volume = Math.max(0, Math.min(1, volume));
  }

  mute(): void {
    this.audioElement.muted = true;
  }

  unmute(): void {
    this.audioElement.muted = false;
  }

  close(): void {
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }
}
```

**Step 2: Create src/services/audio.ts**

Manages the local microphone stream and all peer connections.

```typescript
import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { calculateDistance, calculateVolume, isInRange } from '../core/proximity';
import { Position, PeerState, AudioSettings } from '../core/types';

export class AudioService {
  private localStream: MediaStream | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private peerPositions: Map<string, PeerState> = new Map();
  private signaling: SignalingService;
  private localName: string;
  localPosition: Position = { x: 0, y: 0 };
  private selfMuted = false;
  private muteAll = false;
  private mutedPlayers: Set<string> = new Set();
  private settings: AudioSettings = {
    inputMode: 'vad',
    inputVolume: 1.0,
    pttKey: 'V',
    playerVolumes: {},
  };

  // VAD state
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private vadActive = false;

  // PTT state
  private pttHeld = false;

  constructor(signaling: SignalingService, localName: string) {
    this.signaling = signaling;
    this.localName = localName;
  }

  async initMicrophone(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Set up VAD
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
  }

  private isTransmitting(): boolean {
    if (this.selfMuted) return false;
    if (this.settings.inputMode === 'ptt') return this.pttHeld;
    return this.vadActive;
  }

  setPTTState(held: boolean): void {
    this.pttHeld = held;
    this.updateLocalTrackState();
  }

  private updateLocalTrackState(): void {
    if (!this.localStream) return;
    const enabled = !this.selfMuted && this.isTransmitting();
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  updateVAD(): void {
    if (this.settings.inputMode !== 'vad' || !this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, val) => sum + val, 0) / data.length;
    const threshold = 30;
    this.vadActive = average > threshold;
    this.updateLocalTrackState();
  }

  async connectToPeer(remoteName: string): Promise<void> {
    if (this.peers.has(remoteName)) return;

    const peer = new PeerConnection(remoteName);
    this.peers.set(remoteName, peer);

    if (this.localStream) {
      peer.addLocalStream(this.localStream);
    }

    peer.onIceCandidate = (candidate) => {
      this.signaling.sendSignal({
        type: 'ice-candidate',
        from: this.localName,
        to: remoteName,
        payload: candidate.toJSON(),
      });
    };

    // Initiator: alphabetically first name creates the offer
    if (this.localName < remoteName) {
      const offer = await peer.createOffer();
      this.signaling.sendSignal({
        type: 'offer',
        from: this.localName,
        to: remoteName,
        payload: offer,
      });
    }
  }

  async handleSignal(signal: SignalMessage): Promise<void> {
    let peer = this.peers.get(signal.from);

    if (signal.type === 'offer') {
      if (!peer) {
        peer = new PeerConnection(signal.from);
        this.peers.set(signal.from, peer);
        if (this.localStream) peer.addLocalStream(this.localStream);

        peer.onIceCandidate = (candidate) => {
          this.signaling.sendSignal({
            type: 'ice-candidate',
            from: this.localName,
            to: signal.from,
            payload: candidate.toJSON(),
          });
        };
      }
      const answer = await peer.handleOffer(signal.payload);
      this.signaling.sendSignal({
        type: 'answer',
        from: this.localName,
        to: signal.from,
        payload: answer,
      });
    } else if (signal.type === 'answer' && peer) {
      await peer.handleAnswer(signal.payload);
    } else if (signal.type === 'ice-candidate' && peer) {
      await peer.addIceCandidate(signal.payload);
    }
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
    this.peerPositions.delete(remoteName);
  }

  updateLocalPosition(position: Position): void {
    this.localPosition = position;
    this.updateAllVolumes();
  }

  updatePeerState(state: PeerState): void {
    this.peerPositions.set(state.summonerName, state);
    this.updatePeerVolume(state.summonerName);
  }

  private updateAllVolumes(): void {
    for (const [name] of this.peerPositions) {
      this.updatePeerVolume(name);
    }
  }

  private updatePeerVolume(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    const peerState = this.peerPositions.get(remoteName);
    if (!peer || !peerState) return;

    if (this.muteAll || this.mutedPlayers.has(remoteName)) {
      peer.mute();
      return;
    }

    const distance = calculateDistance(this.localPosition, peerState.position);
    const proximityVolume = calculateVolume(distance);
    const playerVolume = this.settings.playerVolumes[remoteName] ?? 1.0;
    peer.setVolume(proximityVolume * playerVolume);
    peer.unmute();
  }

  setEnemyVisible(remoteName: string, visible: boolean): void {
    const peer = this.peers.get(remoteName);
    if (!peer) return;
    if (!visible) {
      peer.mute();
    } else if (!this.muteAll && !this.mutedPlayers.has(remoteName)) {
      peer.unmute();
      this.updatePeerVolume(remoteName);
    }
  }

  toggleSelfMute(): boolean {
    this.selfMuted = !this.selfMuted;
    this.updateLocalTrackState();
    return this.selfMuted;
  }

  toggleMuteAll(): boolean {
    this.muteAll = !this.muteAll;
    this.updateAllVolumes();
    return this.muteAll;
  }

  toggleMutePlayer(name: string): boolean {
    if (this.mutedPlayers.has(name)) {
      this.mutedPlayers.delete(name);
    } else {
      this.mutedPlayers.add(name);
    }
    this.updatePeerVolume(name);
    return this.mutedPlayers.has(name);
  }

  isSelfMuted(): boolean { return this.selfMuted; }
  isMuteAll(): boolean { return this.muteAll; }
  isPlayerMuted(name: string): boolean { return this.mutedPlayers.has(name); }

  updateSettings(settings: Partial<AudioSettings>): void {
    Object.assign(this.settings, settings);
  }

  cleanup(): void {
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    this.peerPositions.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
```

**Step 3: Build to verify**

Run: `npx webpack`
Expected: Clean build

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add WebRTC peer connection and audio service with proximity volume control"
```

---

### Task 6: Minimap Computer Vision

**Files:**
- Create: `src/services/minimap-cv.ts`
- Create: `src/core/map-calibration.ts`
- Create: `tests/core/map-calibration.test.ts`

**Step 1: Write failing tests for map calibration (pixel-to-game-unit conversion)**

`tests/core/map-calibration.test.ts`:
```typescript
import { pixelToGameUnits, getMinimapBounds } from '../../src/core/map-calibration';

describe('pixelToGameUnits', () => {
  it('converts top-left pixel to near (0, maxY) game coords for SR', () => {
    const result = pixelToGameUnits(0, 0, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(0, -2);
    expect(result.y).toBeCloseTo(14980, -2);
  });

  it('converts bottom-right pixel to near (maxX, 0) game coords for SR', () => {
    const result = pixelToGameUnits(255, 255, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(14870, -2);
    expect(result.y).toBeCloseTo(0, -2);
  });

  it('converts center pixel to center game coords', () => {
    const result = pixelToGameUnits(128, 128, 'summoners_rift', { width: 256, height: 256 });
    expect(result.x).toBeCloseTo(14870 / 2, -2);
    expect(result.y).toBeCloseTo(14980 / 2, -2);
  });
});

describe('getMinimapBounds', () => {
  it('returns bounds in bottom-right of screen for 1920x1080', () => {
    const bounds = getMinimapBounds(1920, 1080);
    expect(bounds.x).toBeGreaterThan(1600);
    expect(bounds.y).toBeGreaterThan(800);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest tests/core/map-calibration.test.ts`
Expected: FAIL

**Step 3: Implement map-calibration.ts**

`src/core/map-calibration.ts`:
```typescript
import { Position, MapType, MAP_DIMENSIONS } from './types';

export interface MinimapBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The LoL minimap is in the bottom-right corner.
 * These ratios are approximate and may need calibration per resolution.
 */
export function getMinimapBounds(screenWidth: number, screenHeight: number): MinimapBounds {
  const minimapSize = Math.round(screenHeight * 0.237); // ~256px at 1080p
  return {
    x: screenWidth - minimapSize - Math.round(screenWidth * 0.005),
    y: screenHeight - minimapSize - Math.round(screenHeight * 0.005),
    width: minimapSize,
    height: minimapSize,
  };
}

/**
 * Converts a pixel position on the minimap to game-unit coordinates.
 * Minimap pixel (0,0) = top-left = game coords (0, maxY)
 * Minimap pixel (max,max) = bottom-right = game coords (maxX, 0)
 */
export function pixelToGameUnits(
  pixelX: number,
  pixelY: number,
  mapType: MapType,
  minimapSize: { width: number; height: number },
): Position {
  const dims = MAP_DIMENSIONS[mapType];
  return {
    x: (pixelX / minimapSize.width) * dims.width,
    y: dims.height - (pixelY / minimapSize.height) * dims.height,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx jest tests/core/map-calibration.test.ts`
Expected: PASS

**Step 5: Create src/services/minimap-cv.ts**

This service captures the minimap region and uses canvas pixel analysis to find the local player's champion icon.

```typescript
import { Position, MapType, MAP_DIMENSIONS } from '../core/types';
import { getMinimapBounds, pixelToGameUnits, MinimapBounds } from '../core/map-calibration';

export class MinimapCVService {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bounds: MinimapBounds;
  private mapType: MapType;
  private intervalId: number | null = null;
  private onPositionUpdate: ((pos: Position) => void) | null = null;
  private lastImageData: ImageData | null = null;

  // Local player icon on minimap has a distinct cyan/teal circle
  private readonly LOCAL_PLAYER_HUE_MIN = 150;
  private readonly LOCAL_PLAYER_HUE_MAX = 200;
  private readonly LOCAL_PLAYER_SAT_MIN = 0.4;
  private readonly LOCAL_PLAYER_VAL_MIN = 0.5;

  constructor(screenWidth: number, screenHeight: number, mapType: MapType) {
    this.bounds = getMinimapBounds(screenWidth, screenHeight);
    this.mapType = mapType;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bounds.width;
    this.canvas.height = this.bounds.height;
    this.ctx = this.canvas.getContext('2d')!;
  }

  start(onPositionUpdate: (pos: Position) => void, fps: number = 4): void {
    this.onPositionUpdate = onPositionUpdate;
    const intervalMs = Math.round(1000 / fps);

    this.intervalId = window.setInterval(() => {
      this.captureAndAnalyze();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private captureAndAnalyze(): void {
    overwolf.media.takeScreenshot((result: any) => {
      if (!result.success || !result.url) return;

      const img = new Image();
      img.onload = () => {
        this.ctx.drawImage(
          img,
          this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height,
          0, 0, this.bounds.width, this.bounds.height,
        );
        this.lastImageData = this.ctx.getImageData(0, 0, this.bounds.width, this.bounds.height);
        const position = this.findLocalPlayerIcon();
        if (position && this.onPositionUpdate) {
          this.onPositionUpdate(position);
        }
      };
      img.src = result.url;
    });
  }

  private findLocalPlayerIcon(): Position | null {
    if (!this.lastImageData) return null;
    const pixels = this.lastImageData.data;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let y = 0; y < this.bounds.height; y++) {
      for (let x = 0; x < this.bounds.width; x++) {
        const i = (y * this.bounds.width + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (this.isLocalPlayerColor(r, g, b)) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count < 5) return null;

    const centerX = sumX / count;
    const centerY = sumY / count;

    return pixelToGameUnits(centerX, centerY, this.mapType, {
      width: this.bounds.width,
      height: this.bounds.height,
    });
  }

  private isLocalPlayerColor(r: number, g: number, b: number): boolean {
    const rN = r / 255;
    const gN = g / 255;
    const bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === rN) hue = 60 * (((gN - bN) / delta) % 6);
      else if (max === gN) hue = 60 * ((bN - rN) / delta + 2);
      else hue = 60 * ((rN - gN) / delta + 4);
    }
    if (hue < 0) hue += 360;

    const saturation = max === 0 ? 0 : delta / max;
    const value = max;

    return (
      hue >= this.LOCAL_PLAYER_HUE_MIN &&
      hue <= this.LOCAL_PLAYER_HUE_MAX &&
      saturation >= this.LOCAL_PLAYER_SAT_MIN &&
      value >= this.LOCAL_PLAYER_VAL_MIN
    );
  }

  /**
   * Check if a specific enemy champion icon is visible on the minimap.
   * Enemy icons are red-tinted.
   */
  isEnemyVisibleOnMinimap(expectedPosition: Position): boolean {
    if (!this.lastImageData) return false;

    const dims = MAP_DIMENSIONS[this.mapType];
    const px = (expectedPosition.x / dims.width) * this.bounds.width;
    const py = this.bounds.height - (expectedPosition.y / dims.height) * this.bounds.height;

    const searchRadius = 12;
    const pixels = this.lastImageData.data;
    let redCount = 0;

    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const x = Math.round(px + dx);
        const y = Math.round(py + dy);
        if (x < 0 || x >= this.bounds.width || y < 0 || y >= this.bounds.height) continue;

        const i = (y * this.bounds.width + x) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];

        if (r > 180 && g < 100 && b < 100) {
          redCount++;
        }
      }
    }

    return redCount > 8;
  }
}
```

**Step 6: Run all tests**

Run: `npx jest`
Expected: All PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: add minimap CV service with screen capture, position extraction, and vision detection"
```

---

### Task 7: Main Orchestrator (Wire Everything Together)

**Files:**
- Modify: `src/background/background.ts`
- Create: `src/services/orchestrator.ts`

**Step 1: Create src/services/orchestrator.ts**

This is the main coordinator that ties all services together.

```typescript
import { GEPService } from './gep';
import { GameStateService, GameSession } from './game-state';
import { SignalingService, SignalMessage, PositionBroadcast } from './signaling';
import { AudioService } from './audio';
import { MinimapCVService } from './minimap-cv';
import { PeerState, Position } from '../core/types';
import { isInRange, calculateDistance } from '../core/proximity';
import { isStreamerMode } from '../core/streamer-detect';

export class Orchestrator {
  private gep: GEPService;
  private gameState: GameStateService;
  private signaling: SignalingService;
  private audio: AudioService | null = null;
  private minimapCV: MinimapCVService | null = null;
  private session: GameSession | null = null;

  private localSummonerName = '';
  private peerStates: Map<string, PeerState> = new Map();

  private onOverlayUpdate: ((data: any) => void) | null = null;

  constructor() {
    this.gep = new GEPService();
    this.gameState = new GameStateService();
    this.signaling = new SignalingService();
  }

  start(): void {
    // Listen for game launch
    overwolf.games.onGameInfoUpdated.addListener((event: any) => {
      if (event.gameInfo?.isRunning && event.gameInfo.classId === 5426) {
        this.gep.start(
          (name, data) => this.handleGameEvent(name, data),
          (info) => this.handleInfoUpdate(info),
        );
      }
    });

    // Check if already running
    overwolf.games.getRunningGameInfo((result: any) => {
      if (result?.classId === 5426) {
        this.gep.start(
          (name, data) => this.handleGameEvent(name, data),
          (info) => this.handleInfoUpdate(info),
        );
      }
    });
  }

  setOverlayCallback(callback: (data: any) => void): void {
    this.onOverlayUpdate = callback;
  }

  private handleGameEvent(name: string, _data: any): void {
    if (name === 'matchEnd' || name === 'match_end') {
      this.endSession();
    }
  }

  private handleInfoUpdate(info: any): void {
    if (info.feature === 'live_client_data') {
      const lcd = info.info?.live_client_data;

      if (lcd?.active_player && !this.localSummonerName) {
        try {
          const active = JSON.parse(lcd.active_player);
          this.localSummonerName = active.summonerName || '';
        } catch {}
      }

      if (lcd?.all_players && !this.session) {
        try {
          const playersData = JSON.parse(lcd.all_players);
          const players = this.gameState.parsePlayerList({ players: playersData });

          const gameMode = lcd.game_data
            ? JSON.parse(lcd.game_data).gameMode || 'CLASSIC'
            : 'CLASSIC';

          const session = this.gameState.createSession(
            players,
            this.localSummonerName,
            gameMode,
          );

          if (session) {
            this.session = session;
            this.startSession(session);
          }
        } catch (e) {
          console.error('Failed to parse live client data:', e);
        }
      }
    }
  }

  private async startSession(session: GameSession): Promise<void> {
    console.log('Starting session: room=' + session.roomId);

    this.audio = new AudioService(this.signaling, this.localSummonerName);
    await this.audio.initMicrophone();

    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    overwolf.utils.getMonitorsList((result: any) => {
      const primary = result.displays?.find((d: any) => d.is_primary) || result.displays?.[0];
      if (primary) {
        this.minimapCV = new MinimapCVService(
          primary.width,
          primary.height,
          session.mapType,
        );
        this.minimapCV.start((pos) => this.handleLocalPositionUpdate(pos), 4);
      }
    });

    // Open overlay window
    overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
      if (result.success) {
        overwolf.windows.restore(result.window.id, () => {});
      }
    });

    this.startVADLoop();
  }

  private startVADLoop(): void {
    setInterval(() => {
      this.audio?.updateVAD();
    }, 50);
  }

  private handleLocalPositionUpdate(position: Position): void {
    if (!this.session || !this.audio) return;

    this.audio.updateLocalPosition(position);

    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      position,
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead,
    });

    this.updateVisionState();
    this.broadcastOverlayState();
  }

  private async handlePeerPosition(peer: PositionBroadcast): Promise<void> {
    if (!this.session || !this.audio) return;

    const player = this.session.allPlayers.find(
      (p) => p.summonerName === peer.summonerName,
    );
    if (player && isStreamerMode(player)) return;

    const peerState: PeerState = {
      summonerName: peer.summonerName,
      championName: peer.championName,
      team: peer.team as 'ORDER' | 'CHAOS',
      position: peer.position,
      isMuted: peer.isMuted,
      isDead: peer.isDead,
    };

    this.peerStates.set(peer.summonerName, peerState);
    this.audio.updatePeerState(peerState);

    const distance = calculateDistance(this.audio.localPosition, peer.position);

    if (isInRange(distance)) {
      await this.audio.connectToPeer(peer.summonerName);
    } else {
      this.audio.disconnectPeer(peer.summonerName);
    }

    this.broadcastOverlayState();
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    await this.audio?.handleSignal(signal);
  }

  private handlePeerLeave(name: string): void {
    this.audio?.disconnectPeer(name);
    this.peerStates.delete(name);
    this.broadcastOverlayState();
  }

  private updateVisionState(): void {
    if (!this.audio || !this.minimapCV || !this.session) return;

    for (const [name, state] of this.peerStates) {
      if (state.team === this.session.localPlayer.team) continue;
      const visible = this.minimapCV.isEnemyVisibleOnMinimap(state.position);
      this.audio.setEnemyVisible(name, visible);
    }
  }

  private broadcastOverlayState(): void {
    if (!this.onOverlayUpdate || !this.audio) return;

    const nearbyPeers = Array.from(this.peerStates.values())
      .filter((p) => {
        const distance = calculateDistance(this.audio!.localPosition, p.position);
        return isInRange(distance);
      })
      .map((p) => ({
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team,
        distance: calculateDistance(this.audio!.localPosition, p.position),
        isMuted: p.isMuted,
        isMutedByLocal: this.audio!.isPlayerMuted(p.summonerName),
        isDead: p.isDead,
      }));

    this.onOverlayUpdate({
      selfMuted: this.audio.isSelfMuted(),
      muteAll: this.audio.isMuteAll(),
      nearbyPeers,
    });
  }

  toggleSelfMute(): boolean { return this.audio?.toggleSelfMute() ?? false; }
  toggleMuteAll(): boolean { return this.audio?.toggleMuteAll() ?? false; }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }

  private endSession(): void {
    this.minimapCV?.stop();
    this.audio?.cleanup();
    this.signaling.leaveRoom();
    this.gameState.clearSession();
    this.session = null;
    this.peerStates.clear();

    overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
      if (result.success) {
        overwolf.windows.close(result.window.id, () => {});
      }
    });
  }
}
```

**Step 2: Update background.ts to use orchestrator**

```typescript
import { Orchestrator } from '../services/orchestrator';

const orchestrator = new Orchestrator();
orchestrator.start();

// Listen for messages from overlay window
overwolf.windows.onMessageReceived.addListener((message: any) => {
  const { action, payload } = message;
  switch (action) {
    case 'toggleSelfMute':
      orchestrator.toggleSelfMute();
      break;
    case 'toggleMuteAll':
      orchestrator.toggleMuteAll();
      break;
    case 'toggleMutePlayer':
      orchestrator.toggleMutePlayer(payload.name);
      break;
    case 'setPTT':
      orchestrator.setPTTState(payload.held);
      break;
  }
});

console.log('LoLProxChat background service started');
```

**Step 3: Build to verify**

Run: `npx webpack`
Expected: Clean build

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add orchestrator to wire GEP, signaling, CV, and audio together"
```

---

### Task 8: Overlay UI

**Files:**
- Modify: `src/overlay/overlay.ts`
- Modify: `src/overlay/overlay.css`
- Modify: `src/overlay/overlay.html`

**Step 1: Update overlay.html**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>LoLProxChat</title>
  <link rel="stylesheet" href="overlay.css">
</head>
<body>
  <div id="proxchat-root" class="proxchat-widget">
    <div id="drag-handle" class="widget-header">
      <span class="widget-title">ProxChat</span>
      <div class="header-controls">
        <button id="btn-self-mute" class="icon-btn" title="Toggle Self Mute">MIC</button>
        <button id="btn-mute-all" class="icon-btn" title="Mute All">VOL</button>
        <button id="btn-settings" class="icon-btn" title="Settings">SET</button>
      </div>
    </div>
    <div id="player-list" class="player-list">
      <div class="empty-state">Waiting for nearby players...</div>
    </div>
    <div id="settings-panel" class="settings-panel hidden">
      <div class="setting-row">
        <label>Input Mode</label>
        <select id="input-mode">
          <option value="vad">Voice Activity</option>
          <option value="ptt">Push to Talk</option>
        </select>
      </div>
      <div class="setting-row">
        <label>Input Volume</label>
        <input id="input-volume" type="range" min="0" max="100" value="100">
      </div>
    </div>
  </div>
  <script src="overlay.js"></script>
</body>
</html>
```

**Step 2: Update overlay.css**

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: transparent;
  overflow: hidden;
  font-family: 'Segoe UI', sans-serif;
  color: #cdcdcd;
  font-size: 12px;
  user-select: none;
}

.proxchat-widget {
  background: rgba(10, 12, 18, 0.85);
  border: 1px solid rgba(100, 120, 160, 0.3);
  border-radius: 6px;
  width: 240px;
  backdrop-filter: blur(4px);
}

.widget-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: rgba(20, 25, 35, 0.9);
  border-bottom: 1px solid rgba(100, 120, 160, 0.2);
  border-radius: 6px 6px 0 0;
  cursor: grab;
}

.widget-title {
  font-size: 11px;
  font-weight: 600;
  color: #8892a8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.header-controls {
  display: flex;
  gap: 4px;
}

.icon-btn {
  background: none;
  border: 1px solid rgba(100, 120, 160, 0.2);
  border-radius: 4px;
  color: #8892a8;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 10px;
  transition: background 0.15s;
}
.icon-btn:hover { background: rgba(100, 120, 160, 0.15); }
.icon-btn.active { color: #e74c4c; border-color: #e74c4c; }

.player-list {
  max-height: 300px;
  overflow-y: auto;
  padding: 4px 0;
}

.empty-state {
  text-align: center;
  padding: 16px 10px;
  color: #555;
  font-style: italic;
  font-size: 11px;
}

.player-row {
  display: flex;
  align-items: center;
  padding: 5px 10px;
  gap: 8px;
  transition: background 0.1s;
}
.player-row:hover { background: rgba(100, 120, 160, 0.08); }

.player-row.enemy { border-left: 2px solid #c44; }
.player-row.ally { border-left: 2px solid #4a8; }

.player-name {
  flex: 1;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.player-volume-bar {
  width: 40px;
  height: 4px;
  background: rgba(100, 120, 160, 0.2);
  border-radius: 2px;
  overflow: hidden;
}
.player-volume-fill {
  height: 100%;
  background: #4a8;
  border-radius: 2px;
  transition: width 0.15s;
}

.player-mute-btn {
  background: none;
  border: none;
  color: #8892a8;
  cursor: pointer;
  font-size: 11px;
  padding: 2px;
}
.player-mute-btn.muted { color: #e74c4c; }

.player-muted-indicator {
  font-size: 10px;
  color: #e74c4c;
}

.settings-panel {
  padding: 8px 10px;
  border-top: 1px solid rgba(100, 120, 160, 0.2);
}
.settings-panel.hidden { display: none; }

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.setting-row label { font-size: 11px; color: #8892a8; }
.setting-row select, .setting-row input[type="range"] {
  background: rgba(20, 25, 35, 0.9);
  border: 1px solid rgba(100, 120, 160, 0.3);
  color: #cdcdcd;
  border-radius: 3px;
  padding: 2px 4px;
  font-size: 11px;
}

.player-list::-webkit-scrollbar { width: 4px; }
.player-list::-webkit-scrollbar-track { background: transparent; }
.player-list::-webkit-scrollbar-thumb { background: rgba(100, 120, 160, 0.3); border-radius: 2px; }
```

**Step 3: Update overlay.ts (using safe DOM manipulation, no innerHTML)**

```typescript
import { calculateVolume } from '../core/proximity';

interface NearbyPeer {
  summonerName: string;
  championName: string;
  team: 'ORDER' | 'CHAOS';
  distance: number;
  isMuted: boolean;
  isMutedByLocal: boolean;
}

interface OverlayState {
  selfMuted: boolean;
  muteAll: boolean;
  nearbyPeers: NearbyPeer[];
}

const playerList = document.getElementById('player-list')!;
const btnSelfMute = document.getElementById('btn-self-mute')!;
const btnMuteAll = document.getElementById('btn-mute-all')!;
const btnSettings = document.getElementById('btn-settings')!;
const settingsPanel = document.getElementById('settings-panel')!;
const dragHandle = document.getElementById('drag-handle')!;

// Dragging
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

dragHandle.addEventListener('mousedown', (e) => {
  isDragging = true;
  dragOffsetX = e.clientX;
  dragOffsetY = e.clientY;
  dragHandle.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.clientX - dragOffsetX;
  const dy = e.clientY - dragOffsetY;
  dragOffsetX = e.clientX;
  dragOffsetY = e.clientY;

  overwolf.windows.getCurrentWindow((result: any) => {
    if (result.success) {
      const win = result.window;
      overwolf.windows.changePosition(win.id, win.left + dx, win.top + dy, () => {});
    }
  });
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  dragHandle.style.cursor = 'grab';
});

// Controls
btnSelfMute.addEventListener('click', () => {
  sendToBackground('toggleSelfMute', {});
});

btnMuteAll.addEventListener('click', () => {
  sendToBackground('toggleMuteAll', {});
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

document.getElementById('input-mode')!.addEventListener('change', (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  sendToBackground('updateSettings', { inputMode: mode });
});

document.getElementById('input-volume')!.addEventListener('input', (e) => {
  const vol = parseInt((e.target as HTMLInputElement).value) / 100;
  sendToBackground('updateSettings', { inputVolume: vol });
});

function sendToBackground(action: string, payload: any): void {
  overwolf.windows.sendMessage('background', action, payload, () => {});
}

function createPlayerRow(peer: NearbyPeer): HTMLElement {
  const vol = calculateVolume(peer.distance);
  const volPct = Math.round(vol * 100);

  const row = document.createElement('div');
  row.className = 'player-row ' + (peer.team === 'ORDER' ? 'ally' : 'enemy');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = peer.championName;
  row.appendChild(nameSpan);

  if (peer.isMuted) {
    const mutedIndicator = document.createElement('span');
    mutedIndicator.className = 'player-muted-indicator';
    mutedIndicator.textContent = 'MUTED';
    row.appendChild(mutedIndicator);
  }

  const volumeBar = document.createElement('div');
  volumeBar.className = 'player-volume-bar';
  const volumeFill = document.createElement('div');
  volumeFill.className = 'player-volume-fill';
  volumeFill.style.width = volPct + '%';
  volumeBar.appendChild(volumeFill);
  row.appendChild(volumeBar);

  const muteBtn = document.createElement('button');
  muteBtn.className = 'player-mute-btn' + (peer.isMutedByLocal ? ' muted' : '');
  muteBtn.textContent = peer.isMutedByLocal ? 'MUTED' : 'MUTE';
  muteBtn.addEventListener('click', () => {
    sendToBackground('toggleMutePlayer', { name: peer.summonerName });
  });
  row.appendChild(muteBtn);

  return row;
}

function renderState(state: OverlayState): void {
  btnSelfMute.classList.toggle('active', state.selfMuted);
  btnSelfMute.textContent = state.selfMuted ? 'MIC OFF' : 'MIC';
  btnMuteAll.classList.toggle('active', state.muteAll);
  btnMuteAll.textContent = state.muteAll ? 'ALL OFF' : 'VOL';

  // Clear player list
  while (playerList.firstChild) {
    playerList.removeChild(playerList.firstChild);
  }

  if (state.nearbyPeers.length === 0) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.textContent = 'Waiting for nearby players...';
    playerList.appendChild(emptyDiv);
    return;
  }

  const sorted = [...state.nearbyPeers].sort((a, b) => a.distance - b.distance);
  for (const peer of sorted) {
    playerList.appendChild(createPlayerRow(peer));
  }
}

// Listen for state updates from background
overwolf.windows.onMessageReceived.addListener((message: any) => {
  if (message.id === 'overlayUpdate') {
    renderState(message.content);
  }
});

console.log('LoLProxChat overlay loaded');
```

**Step 4: Build to verify**

Run: `npx webpack`
Expected: Clean build

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add overlay UI with draggable widget, player list, mute controls, and settings"
```

---

### Task 9: Hotkey Integration (PTT & Mute)

**Files:**
- Modify: `src/background/background.ts`

**Step 1: Add hotkey listeners to background.ts**

Add the following after the orchestrator setup:

```typescript
// PTT hotkey (hold)
overwolf.settings.hotkeys.onHold.addListener((event: any) => {
  if (event.name === 'push_to_talk') {
    orchestrator.setPTTState(true);
  }
});

overwolf.settings.hotkeys.onReleased.addListener((event: any) => {
  if (event.name === 'push_to_talk') {
    orchestrator.setPTTState(false);
  }
});

// Toggle mute hotkey
overwolf.settings.hotkeys.onPressed.addListener((event: any) => {
  if (event.name === 'toggle_mute') {
    orchestrator.toggleSelfMute();
  }
});
```

**Step 2: Build to verify**

Run: `npx webpack`
Expected: Clean build

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add hotkey integration for push-to-talk and toggle mute"
```

---

### Task 10: Integration Testing & Polish

**Files:**
- Create: `tests/integration/session-flow.test.ts`
- Modify: `package.json` (add scripts)

**Step 1: Add npm scripts to package.json**

```json
{
  "scripts": {
    "build": "webpack",
    "build:prod": "webpack --mode production",
    "test": "jest",
    "test:watch": "jest --watch"
  }
}
```

**Step 2: Write integration test for session flow**

`tests/integration/session-flow.test.ts`:
```typescript
import { GameStateService } from '../../src/services/game-state';
import { generateRoomId } from '../../src/core/room';
import { calculateDistance, calculateVolume, isInRange } from '../../src/core/proximity';
import { Player } from '../../src/core/types';

describe('Session flow integration', () => {
  const mockPlayers: Player[] = [
    { summonerName: 'Player1', championName: 'Ahri', team: 'ORDER', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player2', championName: 'Zed', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Jinx', championName: 'Jinx', team: 'CHAOS', isDead: false, respawnTimer: 0 },
    { summonerName: 'Player4', championName: 'Lux', team: 'ORDER', isDead: false, respawnTimer: 0 },
  ];

  it('creates a session excluding streamer mode players', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Player1', 'CLASSIC');

    expect(session).not.toBeNull();
    expect(session!.eligiblePlayers).toHaveLength(3);
    expect(session!.eligiblePlayers.find(p => p.summonerName === 'Jinx')).toBeUndefined();
  });

  it('returns null session if local player is in streamer mode', () => {
    const gs = new GameStateService();
    const session = gs.createSession(mockPlayers, 'Jinx', 'CLASSIC');
    expect(session).toBeNull();
  });

  it('generates same room ID for all players in the same game', () => {
    const names = mockPlayers.map(p => p.summonerName);
    const id1 = generateRoomId(names);
    const id2 = generateRoomId([...names].reverse());
    expect(id1).toBe(id2);
  });

  it('proximity chain: distance -> volume -> range check', () => {
    const posA = { x: 5000, y: 5000 };
    const posB = { x: 5500, y: 5000 };

    const dist = calculateDistance(posA, posB);
    expect(dist).toBe(500);
    expect(isInRange(dist)).toBe(true);

    const vol = calculateVolume(dist);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });

  it('far away players are out of range', () => {
    const posA = { x: 1000, y: 1000 };
    const posB = { x: 5000, y: 5000 };

    const dist = calculateDistance(posA, posB);
    expect(isInRange(dist)).toBe(false);
    expect(calculateVolume(dist)).toBe(0);
  });
});
```

**Step 3: Run all tests**

Run: `npx jest`
Expected: All PASS

**Step 4: Production build**

Run: `npm run build:prod`
Expected: Minified build in dist/

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add integration tests, npm scripts, and production build config"
```

---

### Task 11: Supabase Project Setup & Configuration

**Files:**
- Modify: `src/core/config.ts`
- Create: `docs/SETUP.md`

**Step 1: Create docs/SETUP.md with setup instructions**

```markdown
# LoLProxChat Setup Guide

## 1. Supabase Project

1. Go to https://supabase.com and create a free account
2. Create a new project (any name, any region)
3. Go to Settings > API
4. Copy the "Project URL" and "anon/public" key
5. Paste them into src/core/config.ts

No database tables needed - we only use Supabase Realtime (channels/presence/broadcast).

## 2. Overwolf Developer Account

1. Register at https://dev.overwolf.com
2. Create a new app in the developer console
3. Load the dist/ folder as an unpacked extension for testing

## 3. Development

- npm install - install dependencies
- npm run build - development build
- npm run build:prod - production build
- npm test - run tests

## 4. Testing

1. Build the app: npm run build
2. In Overwolf, load dist/ as unpacked extension
3. Launch League of Legends and start a game
4. The overlay should appear near the minimap
5. Other players with the app will appear when in proximity
```

**Step 2: Commit**

```bash
git add -A
git commit -m "docs: add setup guide and config placeholders"
```

---

## Summary

| Task | Description | Key Files |
|------|-------------|-----------|
| 1 | Project scaffolding | manifest.json, webpack, HTML shells |
| 2 | Core utility modules (TDD) | room.ts, proximity.ts, streamer-detect.ts + tests |
| 3 | GEP integration | gep.ts, game-state.ts |
| 4 | Supabase signaling | signaling.ts, config.ts |
| 5 | WebRTC audio | peer-connection.ts, audio.ts |
| 6 | Minimap CV | minimap-cv.ts, map-calibration.ts + tests |
| 7 | Orchestrator | orchestrator.ts, updated background.ts |
| 8 | Overlay UI | overlay HTML/CSS/TS |
| 9 | Hotkey integration | background.ts hotkey listeners |
| 10 | Integration tests and build | integration tests, npm scripts |
| 11 | Setup docs and config | SETUP.md, config placeholders |
