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
  private gepStarted = false;


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
    if (this.session) return; // Already have a session

    this.gep.getInfo((result: any) => {
      console.log('[ProxChat] pollForGameInfo result:', JSON.stringify(result).substring(0, 500));
      if (result.success && result.res?.live_client_data) {
        const lcd = result.res.live_client_data;
        this.processLiveClientData(lcd);
      }

      // Retry every 3 seconds if no session yet
      if (!this.session) {
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
      console.error('[ProxChat] Mic init failed:', e);
    }

    // Join signaling room
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    // Start tracking service
    overwolf.games.getRunningGameInfo(async (gameResult: any) => {
      try {
        const w = gameResult?.logicalWidth || gameResult?.width || 1920;
        const h = gameResult?.logicalHeight || gameResult?.height || 1080;
        console.log('[ProxChat] Using game resolution:', w, 'x', h);

        this.tracking = new TrackingService(w, h, session.mapType);
        this.tracking.loadChampionTemplate(session.localPlayer.championName);
        this.tracking.start((pos) => {
          // Position callback — no longer directly updates audio
          console.log('[ProxChat] Position update:', Math.round(pos.x), Math.round(pos.y));
        });

        // Initialize data channel service and volume client
        this.dataChannels = new DataChannelService();
        this.volumeClient = new VolumeClient();

        // Start volume computation tick (~8Hz)
        this.volumeTickId = window.setInterval(() => this.positionTick(), 125) as unknown as number;

      } catch (e) {
        console.error('[ProxChat] Tracking initialization failed:', e);
      }
    });

    // Open overlay window
    overwolf.windows.obtainDeclaredWindow('overlay', (result: any) => {
      if (result.success) {
        overwolf.windows.restore(result.window.id, () => {});
      }
    });

    // Start VAD update loop (20 times/sec)
    this.vadIntervalId = window.setInterval(() => {
      this.audio?.updateVAD();
    }, 50) as unknown as number;
  }

  private async positionTick(): Promise<void> {
    if (!this.audio || !this.session || !this.tracking || !this.volumeClient || !this.dataChannels) return;

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
    if (!position || (position.x === 0 && position.y === 0)) return;

    try {
      // Collect encrypted blobs received from peers
      const peerBlobs = this.dataChannels.getPeerBlobs();

      // Call Edge Function: encrypt our position + compute volumes
      const result = await this.volumeClient.computeVolumes(position, peerBlobs);

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
    if (!this.audio.hasPeer(peer.summonerName)) {
      await this.audio.connectToPeer(peer.summonerName);
      // Register data channel after connection
      const peerConn = this.audio.getPeer(peer.summonerName);
      if (peerConn && this.dataChannels) {
        // Initiator creates the data channel
        if (this.localSummonerName < peer.summonerName) {
          peerConn.createDataChannel();
        }
        this.dataChannels.registerPeer(peer.summonerName, peerConn);
      }
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
    };

    overwolf.windows.sendMessage('overlay', 'overlayUpdate', data, () => {});
  }

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean { return this.audio?.toggleSelfMute() ?? false; }
  toggleMuteAll(): boolean { return this.audio?.toggleMuteAll() ?? false; }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
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

  private endSession(): void {
    if (this.vadIntervalId !== null) {
      clearInterval(this.vadIntervalId);
      this.vadIntervalId = null;
    }
    if (this.volumeTickId !== null) {
      clearInterval(this.volumeTickId);
      this.volumeTickId = null;
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
