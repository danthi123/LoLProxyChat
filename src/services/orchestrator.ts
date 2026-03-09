import { GEPService } from './gep';
import { GameStateService, GameSession } from './game-state';
import { SignalingService, SignalMessage, PositionBroadcast } from './signaling';
import { AudioService } from './audio';
import { TrackingService, TrackingState } from './tracking';
import { DataChannelService } from './data-channel';
import { VolumeClient } from './volume-client';
import { PeerState } from '../core/types';
import { isStreamerMode } from '../core/streamer-detect';

export class Orchestrator {
  private gep: GEPService;
  private gameState: GameStateService;
  private signaling: SignalingService;
  private audio: AudioService | null = null;
  private tracking: TrackingService | null = null;
  private dataChannels: DataChannelService | null = null;
  private volumeClient: VolumeClient | null = null;
  private session: GameSession | null = null;

  private localSummonerName = '';
  private peerStates: Map<string, PeerState> = new Map();
  private vadIntervalId: number | null = null;
  private volumeTickId: number | null = null;
  private configPollId: number | null = null;
  private gepStarted = false;
  private positionTickRunning = false;
  private sessionActive = false;
  private overlayWindowId: string | null = null;
  private lastOverlayRepositionTime = 0;
  private lastOverlayPositionKey = '';
  private leagueConfigPath: string | null = null;
  private lastMinimapScale: number | null = null;
  private dpiScale = 1;


  constructor() {
    this.gep = new GEPService();
    this.gameState = new GameStateService();
    this.signaling = new SignalingService();
  }

  start(): void {
    console.log('[ProxChat] Orchestrator.start() called');

    // Listen for game launch
    overwolf.games.onGameInfoUpdated.addListener((event: any) => {
      console.log('[ProxChat] onGameInfoUpdated:', JSON.stringify(event?.gameInfo?.classId), 'running:', event?.gameInfo?.isRunning);
      if (event.gameInfo?.classId === 5426) {
        if (event.gameInfo.isRunning) {
          this.startGEP();
        } else {
          console.log('[ProxChat] LoL closed, ending session');
          this.gepStarted = false;
          this.endSession();
          this.gep.stop();
        }
      }
    });

    // Check if already running
    overwolf.games.getRunningGameInfo((result: any) => {
      console.log('[ProxChat] getRunningGameInfo result:', JSON.stringify(result?.classId), 'running:', result?.isRunning);
      if (result?.classId === 5426) {
        this.startGEP();
      }
    });
  }

  private startGEP(): void {
    if (this.gepStarted) {
      console.log('[ProxChat] GEP already started, skipping');
      return;
    }
    this.gepStarted = true;
    console.log('[ProxChat] Starting GEP (first time)');
    this.gep.start(
      (name, data) => this.handleGameEvent(name, data),
      (info) => this.handleInfoUpdate(info),
    );

    // Poll getInfo since onInfoUpdates2 may not fire for existing data
    this.pollForGameInfo();
  }

  private pollForGameInfo(): void {
    if (this.session || !this.gepStarted) return;

    this.gep.getInfo((result: any) => {
      if (!this.gepStarted) return; // Stop polling if GEP was stopped
      console.log('[ProxChat] pollForGameInfo result:', JSON.stringify(result).substring(0, 500));
      if (result.success && result.res?.live_client_data) {
        const lcd = result.res.live_client_data;
        this.processLiveClientData(lcd);
      }

      // Retry every 3 seconds if no session yet and still active
      if (!this.session && this.gepStarted) {
        setTimeout(() => this.pollForGameInfo(), 3000);
      }
    });
  }

  private processLiveClientData(lcd: any): void {
    if (this.session) return;

    try {
      if (lcd.active_player && !this.localSummonerName) {
        const active = typeof lcd.active_player === 'string'
          ? JSON.parse(lcd.active_player)
          : lcd.active_player;
        this.localSummonerName = active.summonerName || '';
        console.log('[ProxChat] Local summoner:', this.localSummonerName);
      }

      if (lcd.all_players && this.localSummonerName) {
        const playersData = typeof lcd.all_players === 'string'
          ? JSON.parse(lcd.all_players)
          : lcd.all_players;
        const players = this.gameState.parsePlayerList({ players: playersData });
        console.log('[ProxChat] Parsed players:', players.length);

        const gameMode = lcd.game_data
          ? (typeof lcd.game_data === 'string' ? JSON.parse(lcd.game_data) : lcd.game_data).gameMode || 'CLASSIC'
          : 'CLASSIC';

        const session = this.gameState.createSession(
          players,
          this.localSummonerName,
          gameMode,
        );

        if (session) {
          this.session = session;
          console.log('[ProxChat] Session created! Room:', session.roomId);
          this.startSession(session);
        }
      }
    } catch (e) {
      console.error('[ProxChat] Failed to process live client data:', e);
    }
  }

  private handleGameEvent(name: string, _data: any): void {
    console.log('[ProxChat] GameEvent:', name, JSON.stringify(_data).substring(0, 200));
    if (name === 'matchEnd' || name === 'match_end') {
      this.endSession();
    }
    if (name === 'death' && this.session) {
      this.session.localPlayer.isDead = true;
      this.tracking?.onDeath();
    }
    if (name === 'respawn' && this.session) {
      this.session.localPlayer.isDead = false;
      this.tracking?.onRespawn();
    }
  }

  private handleInfoUpdate(info: any): void {
    console.log('[ProxChat] InfoUpdate feature:', info.feature);
    if (info.feature === 'live_client_data') {
      const lcd = info.info?.live_client_data;
      if (lcd) this.processLiveClientData(lcd);
    }
  }

  private async startSession(session: GameSession): Promise<void> {
    console.log('[ProxChat] Starting session: room=' + session.roomId);

    // Initialize audio (mic + WebRTC)
    this.audio = new AudioService(this.signaling, this.localSummonerName);
    try {
      await this.audio.initMicrophone();
      console.log('[ProxChat] Microphone initialized');
    } catch (e) {
      console.error('[ProxChat] Mic init failed — aborting session:', e);
      this.audio = null;
      return;
    }

    // Join signaling room
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    this.sessionActive = true;

    // Start tracking service
    overwolf.games.getRunningGameInfo(async (gameResult: any) => {
      if (!this.sessionActive) return; // Session ended before callback fired
      try {
        // Overwolf naming is inverted:
        //   width/height = DPI-scaled logical coords (1536x864 at 125%)
        //   logicalWidth/logicalHeight = actual game render resolution (1920x1080)
        const gameW = gameResult?.logicalWidth || gameResult?.width || 1920;
        const gameH = gameResult?.logicalHeight || gameResult?.height || 1080;
        const owW = gameResult?.width || gameW;
        const owH = gameResult?.height || gameH;
        // DPI scale: game pixels → Overwolf window coords
        this.dpiScale = gameW / owW;
        console.log('[ProxChat] Resolution: game=' + gameW + 'x' + gameH +
          ' overwolf=' + owW + 'x' + owH + ' dpiScale=' + this.dpiScale);
        const w = gameW;
        const h = gameH;

        // Auto-detect League config path from running game
        this.leagueConfigPath = this.resolveLeagueConfigPath(gameResult);
        console.log('[ProxChat] League config path:', this.leagueConfigPath);

        this.tracking = new TrackingService(w, h, session.mapType);
        this.tracking.loadChampionTemplate(session.localPlayer.championName);

        // Read minimap scale from League config and apply before starting tracking
        this.readMinimapScale((scale) => {
          if (scale !== null && this.tracking) {
            this.lastMinimapScale = scale;
            this.tracking.setMinimapScaleFromConfig(scale);
          }
        });

        this.tracking.start((pos) => {
          // Position callback — no longer directly updates audio
          console.log('[ProxChat] Position update:', Math.round(pos.x), Math.round(pos.y));
        }, 15);

        // Initialize data channel service and volume client
        this.dataChannels = new DataChannelService();
        this.volumeClient = new VolumeClient();

        // Start volume computation tick (~8Hz)
        this.volumeTickId = window.setInterval(() => this.positionTick(), 125) as unknown as number;

        // Poll game.cfg every 5 seconds for minimap scale changes
        this.configPollId = window.setInterval(() => this.pollMinimapScale(), 5000) as unknown as number;

      } catch (e) {
        console.error('[ProxChat] Tracking initialization failed:', e);
      }
    });

    // Open overlay window and cache its ID for direct repositioning
    overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
      if (result.success) {
        this.overlayWindowId = result.window.id;
        overwolf.windows.restore(result.window.id, () => {});
      }
    });

    // Start VAD update loop (20 times/sec)
    this.vadIntervalId = window.setInterval(() => {
      this.audio?.updateVAD();
    }, 50) as unknown as number;
  }

  private async positionTick(): Promise<void> {
    if (this.positionTickRunning) return;
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient || !this.dataChannels) return;
    this.positionTickRunning = true;
    try {
      await this.positionTickInner();
    } finally {
      this.positionTickRunning = false;
    }
  }

  private async positionTickInner(): Promise<void> {
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient || !this.dataChannels) return;

    // Broadcast presence over signaling so peers can discover us
    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      position: this.tracking.getLastPosition() ?? { x: 0, y: 0 },
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead ?? false,
    });

    // Feed known ally peer positions to tracking for self-identification disambiguation
    const allyPeerPositions = Array.from(this.peerStates.values())
      .filter(p => p.team === this.session!.localPlayer.team && p.position.x > 0 && p.position.y > 0)
      .map(p => p.position);
    this.tracking.setPeerGamePositions(allyPeerPositions);

    // Before CV locks on (SCANNING), pass through all ally audio at full volume (fountain)
    if (this.tracking.getState() === TrackingState.SCANNING) {
      const allyVolumes: Record<string, number> = {};
      for (const [name, state] of this.peerStates) {
        if (state.team === this.session.localPlayer.team) {
          allyVolumes[name] = 1.0;
        }
      }
      this.audio.applyPeerVolumes(allyVolumes);
      this.broadcastOverlayState();
      return;
    }

    const position = this.tracking.getLastPosition();
    if (!position || (position.x === 0 && position.y === 0)) {
      this.broadcastOverlayState();
      return;
    }

    try {
      // Collect encrypted blobs received from peers
      const peerBlobs = this.dataChannels.getPeerBlobs();

      // Call Edge Function: encrypt our position + compute volumes
      const result = await this.volumeClient.computeVolumes(position, peerBlobs);

      console.log('[ProxChat] Volume tick: pos=(' + Math.round(position.x) + ',' + Math.round(position.y) +
        ') peers=' + Object.keys(peerBlobs).length +
        ' volumes=' + JSON.stringify(result.peerVolumes) +
        ' hasBlob=' + !!result.myBlob);

      // Broadcast our encrypted blob to all peers
      this.dataChannels.broadcastBlob(result.myBlob);

      // Apply volume levels to audio streams
      this.audio.applyPeerVolumes(result.peerVolumes);
    } catch (e) {
      console.error('[ProxChat] Volume computation failed:', e);
    }

    this.broadcastOverlayState();
  }

  private async handlePeerPosition(peer: PositionBroadcast): Promise<void> {
    if (!this.session || !this.audio) return;

    // Skip streamer mode players
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

    // Connect to peer (audio + data channel)
    try {
      if (!this.audio.hasPeer(peer.summonerName)) {
        const isInitiator = this.localSummonerName < peer.summonerName;
        await this.audio.connectToPeer(peer.summonerName, isInitiator);
      }
      // Always register with DataChannelService (peer may have been created by handleSignal)
      const peerConn = this.audio.getPeer(peer.summonerName);
      if (peerConn && this.dataChannels && !this.dataChannels.hasPeer(peer.summonerName)) {
        this.dataChannels.registerPeer(peer.summonerName, peerConn);
      }
    } catch (e) {
      console.error('[ProxChat] Failed to connect to peer:', peer.summonerName, e);
      this.peerStates.delete(peer.summonerName);
    }
  }

  private async handleSignal(signal: SignalMessage): Promise<void> {
    await this.audio?.handleSignal(signal);
  }

  private handlePeerLeave(name: string): void {
    this.audio?.disconnectPeer(name);
    this.dataChannels?.unregisterPeer(name);
    this.peerStates.delete(name);
    this.broadcastOverlayState();
  }

  private broadcastOverlayState(): void {
    if (!this.audio) return;

    const nearbyPeers = Array.from(this.peerStates.values())
      .map((p) => ({
        summonerName: p.summonerName,
        championName: p.championName,
        team: p.team,
        isMuted: p.isMuted,
        isMutedByLocal: this.audio!.isPlayerMuted(p.summonerName),
        isDead: p.isDead,
      }));

    const data = {
      selfMuted: this.audio.isSelfMuted(),
      muteAll: this.audio.isMuteAll(),
      nearbyPeers,
      trackingState: this.tracking?.getState() ?? 'none',
      lastPosition: this.tracking?.getLastPosition() ?? null,
      filteredImageUrl: this.tracking?.getFilteredImageUrl() ?? null,
      detectedMinimapBounds: this.tracking?.getDetectedMinimapScreenBounds() ?? null,
    };

    overwolf.windows.sendMessage('overlay', 'overlayUpdate', data, () => {});

    // Directly reposition overlay window to fit around detected minimap
    this.repositionOverlay();
  }

  private repositionOverlay(): void {
    if (!this.overlayWindowId || !this.tracking) return;

    const bounds = this.tracking.getDetectedMinimapScreenBounds();
    if (!bounds) return;

    // changeSize uses CSS/logical pixels; changePosition uses physical/game pixels
    const PANEL_WIDTH = 240;
    const scale = this.dpiScale || 1;
    // Pad the minimap border outward by a few pixels (top/left expansion)
    const PAD = 8;
    // Size in CSS/logical pixels (divide minimap size by DPI scale, add padding)
    const mmWidthCSS = Math.round(bounds.screenWidth / scale) + PAD;
    const mmHeightCSS = Math.round(bounds.screenHeight / scale) + PAD;
    const targetWidth = PANEL_WIDTH + mmWidthCSS;
    const targetHeight = mmHeightCSS;
    // Position in physical/game pixels — anchor right/bottom edges to minimap
    const mmRight = bounds.screenX + bounds.screenWidth;
    const mmBottom = bounds.screenY + bounds.screenHeight;
    const targetLeft = Math.round(mmRight - targetWidth * scale);
    const targetTop = Math.round(mmBottom - targetHeight * scale);

    // Only reposition if bounds actually changed (prevents visual shifting)
    const key = targetLeft + ',' + targetTop + ',' + targetWidth + ',' + targetHeight;
    if (key === this.lastOverlayPositionKey) return;

    // Throttle: at most every 3 seconds (allows re-snap after manual drag)
    const now = Date.now();
    if (now - this.lastOverlayRepositionTime < 3000) return;
    this.lastOverlayRepositionTime = now;
    this.lastOverlayPositionKey = key;

    console.log('[ProxChat] Repositioning overlay:' +
      ' minimapBounds=' + JSON.stringify(bounds) +
      ' dpiScale=' + scale +
      ' target=(' + targetLeft + ',' + targetTop + ' ' + targetWidth + 'x' + targetHeight + ')');

    const winId = this.overlayWindowId;
    overwolf.windows.changeSize({ window_id: winId, width: targetWidth, height: targetHeight }, () => {});
    overwolf.windows.changePosition(winId, targetLeft, targetTop, () => {});
  }

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean { return this.audio?.toggleSelfMute() ?? false; }
  toggleMuteAll(): boolean { return this.audio?.toggleMuteAll() ?? false; }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPlayerVolume(name: string, volume: number): void { this.audio?.setPlayerVolume(name, volume); }
  setScanRate(fps: number): void {
    if (!this.tracking) return;
    const clamped = Math.max(1, Math.min(30, Math.round(fps)));
    console.log('[ProxChat] Scan rate changed to ' + clamped + ' FPS');
    this.tracking.stop();
    this.tracking.start((pos) => {
      console.log('[ProxChat] Position update:', Math.round(pos.x), Math.round(pos.y));
    }, clamped);
  }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }
  updateSettings(settings: any): void { this.audio?.updateSettings(settings); }

  getSessionPlayers(): { summonerName: string; championName: string; team: string }[] {
    if (!this.session) return [];
    return this.session.allPlayers.map((p) => ({
      summonerName: p.summonerName,
      championName: p.championName,
      team: p.team,
    }));
  }

  private calibrationIndex = 0;

  captureCalibrationData(data: any): void {
    this.calibrationIndex++;
    const idx = String(this.calibrationIndex).padStart(3, '0');
    const writeText = (overwolf as any).extensions.io.writeTextFile.bind((overwolf as any).extensions.io);
    const storageSpace = (overwolf as any).extensions.io.enums.StorageSpace.appData;

    // 1. Save the user-annotated positions as JSON
    const posJson = JSON.stringify(data, null, 2);
    writeText(storageSpace, `calibration/positions-${idx}.json`, posJson, (result: any) => {
      console.log('[ProxChat] Saved calibration positions:', idx, result?.success ?? result?.status);
    });

    // 2. Save full game screenshot (Overwolf saves JPEG to its screenshots folder)
    (overwolf.media as any).takeScreenshot((fullResult: any) => {
      console.log('[ProxChat] Full screenshot result:', JSON.stringify(fullResult).substring(0, 200));
      if (fullResult.url) {
        writeText(storageSpace, `calibration/full-${idx}.txt`, fullResult.url, () => {});
      }
    });

    // 3. Save cropped minimap screenshot as base64 data URL
    const bounds = this.tracking?.captureBounds;
    const cropParams = {
      roundAwayFromZero: 'true',
      crop: bounds ? {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      } : undefined,
    };

    (overwolf.media as any).getScreenshotUrl(cropParams, (cropResult: any) => {
      if (!(cropResult.success || cropResult.status === 'success') || !cropResult.url) return;

      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const dataUrl = c.toDataURL('image/png');
        writeText(storageSpace, `calibration/minimap-${idx}.txt`, dataUrl, (result: any) => {
          console.log('[ProxChat] Saved minimap:', idx, img.width, 'x', img.height, 'size:', dataUrl.length, result?.success ?? result?.status);
        });
      };
      img.src = cropResult.url;
    });

    console.log('[ProxChat] Calibration capture #' + idx);
  }

  /**
   * Receive minimap screen bounds from calibration overlay and convert to
   * capture-relative coordinates for the tracking service.
   */
  setMinimapCalibration(bounds: { screenX: number; screenY: number; screenWidth: number; screenHeight: number }): void {
    if (!this.tracking) {
      console.warn('[ProxChat] setMinimapCalibration called but no tracking service');
      return;
    }
    const capture = this.tracking.captureBounds;
    // Convert screen coordinates to capture-relative coordinates
    const region = {
      x: bounds.screenX - capture.x,
      y: bounds.screenY - capture.y,
      width: bounds.screenWidth,
      height: bounds.screenHeight,
    };
    console.log('[ProxChat] Calibration bounds (screen):', JSON.stringify(bounds));
    console.log('[ProxChat] Calibration region (capture-relative):', JSON.stringify(region));
    this.tracking.setMinimapRegion(region);
  }

  /**
   * Derive the League config directory from the running game's executable path.
   * Overwolf gives us something like "C:\Riot Games\League of Legends\Game\League of Legends.exe"
   * and the config lives at "C:\Riot Games\League of Legends\Config\game.cfg".
   * Falls back to the default install path.
   */
  private resolveLeagueConfigPath(gameResult: any): string {
    // Try to get the exe path from various Overwolf properties
    const exePath: string = gameResult?.path || gameResult?.executionPath || gameResult?.ProcessPath || '';
    console.log('[ProxChat] Game exe path:', exePath);

    if (exePath) {
      // Normalize slashes and go up from Game/LeagueOfLegends.exe to the League root
      const normalized = exePath.replace(/\\/g, '/');
      const gameDir = normalized.substring(0, normalized.lastIndexOf('/'));  // remove exe filename
      const leagueRoot = gameDir.substring(0, gameDir.lastIndexOf('/'));    // remove "Game" dir
      if (leagueRoot) {
        return leagueRoot + '/Config/game.cfg';
      }
    }

    // Fallback to default install path
    return 'C:/Riot Games/League of Legends/Config/game.cfg';
  }

  /**
   * Read MinimapScale from League's game.cfg. The file is an INI-style config
   * with [Section] headers. MinimapScale is under [HUD] and ranges from 0.0 to 1.0.
   */
  private readMinimapScale(callback: (scale: number | null) => void): void {
    if (!this.leagueConfigPath) {
      console.warn('[ProxChat] readMinimapScale: no config path');
      callback(null);
      return;
    }

    // Use overwolf-fs:// protocol (allowed by Overwolf's CORS policy)
    const fileUrl = 'overwolf-fs:///' + this.leagueConfigPath.replace(/\\/g, '/');
    console.log('[ProxChat] Reading game.cfg via:', fileUrl);

    fetch(fileUrl)
      .then(r => r.text())
      .then(text => this.parseMinimapScale(text, callback))
      .catch(err => {
        console.warn('[ProxChat] Failed to read game.cfg:', err);
        callback(null);
      });
  }

  private parseMinimapScale(text: string, callback: (scale: number | null) => void): void {
    const lines = text.split('\n');
    let inHudSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        inHudSection = trimmed.toLowerCase() === '[hud]';
        continue;
      }
      if (inHudSection && trimmed.toLowerCase().startsWith('minimapscale=')) {
        const rawVal = trimmed.split('=')[1].trim();
        const val = parseFloat(rawVal);
        if (!isNaN(val)) {
          console.log('[ProxChat] MinimapScale raw="' + rawVal + '" parsed=' + val);
          callback(val);
          return;
        }
      }
    }
    console.warn('[ProxChat] MinimapScale not found in game.cfg, text length=' + text.length);
    callback(null);
  }

  /**
   * Poll game.cfg for MinimapScale changes and update tracking bounds.
   */
  private pollMinimapScale(): void {
    this.readMinimapScale((scale) => {
      if (scale === null || !this.tracking) return;
      if (scale !== this.lastMinimapScale) {
        console.log('[ProxChat] MinimapScale changed:', this.lastMinimapScale, '->', scale);
        this.lastMinimapScale = scale;
        this.tracking.setMinimapScaleFromConfig(scale);
      }
    });
  }

  private endSession(): void {
    this.positionTickRunning = false;
    this.sessionActive = false;

    if (this.vadIntervalId !== null) {
      clearInterval(this.vadIntervalId);
      this.vadIntervalId = null;
    }
    if (this.volumeTickId !== null) {
      clearInterval(this.volumeTickId);
      this.volumeTickId = null;
    }
    if (this.configPollId !== null) {
      clearInterval(this.configPollId);
      this.configPollId = null;
    }

    this.tracking?.stop();
    this.tracking = null;
    this.dataChannels = null;
    this.volumeClient = null;
    this.audio?.cleanup();
    this.signaling.leaveRoom();
    this.gameState.clearSession();
    this.session = null;
    this.peerStates.clear();
    this.localSummonerName = '';

    // Close overlay
    overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
      if (result.success) {
        overwolf.windows.close(result.window.id, () => {});
      }
    });
  }
}
