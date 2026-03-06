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
  private vadIntervalId: number | null = null;

  private onOverlayUpdate: ((data: any) => void) | null = null;

  constructor() {
    this.gep = new GEPService();
    this.gameState = new GameStateService();
    this.signaling = new SignalingService();
  }

  start(): void {
    // Listen for game launch
    overwolf.games.onGameInfoUpdated.addListener((event: any) => {
      if (event.gameInfo?.classId === 5426) {
        if (event.gameInfo.isRunning) {
          this.gep.start(
            (name, data) => this.handleGameEvent(name, data),
            (info) => this.handleInfoUpdate(info),
          );
        } else {
          this.endSession();
          this.gep.stop();
        }
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

    // Initialize audio (mic + WebRTC)
    this.audio = new AudioService(this.signaling, this.localSummonerName);
    await this.audio.initMicrophone();

    // Join signaling room
    this.signaling.joinRoom(
      session.roomId,
      this.localSummonerName,
      (peer) => this.handlePeerPosition(peer),
      (signal) => this.handleSignal(signal),
      (name) => this.handlePeerLeave(name),
    );

    // Start minimap CV
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

    // Start VAD update loop (20 times/sec)
    this.vadIntervalId = window.setInterval(() => {
      this.audio?.updateVAD();
    }, 50) as unknown as number;
  }

  private handleLocalPositionUpdate(position: Position): void {
    if (!this.session || !this.audio) return;

    this.audio.updateLocalPosition(position);

    // Broadcast position to peers
    this.signaling.broadcastPosition({
      summonerName: this.localSummonerName,
      championName: this.session.localPlayer.championName,
      team: this.session.localPlayer.team,
      position,
      isMuted: this.audio.isSelfMuted(),
      isDead: this.session.localPlayer.isDead,
    });

    // Check vision for enemies
    this.updateVisionState();

    // Update overlay
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
    this.audio.updatePeerState(peerState);

    // Connect or disconnect based on range
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
      // Allies are always visible on minimap
      if (state.team === this.session.localPlayer.team) continue;

      // Check if enemy is visible on minimap
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

  // Public controls (called from overlay via messaging)
  toggleSelfMute(): boolean { return this.audio?.toggleSelfMute() ?? false; }
  toggleMuteAll(): boolean { return this.audio?.toggleMuteAll() ?? false; }
  toggleMutePlayer(name: string): boolean { return this.audio?.toggleMutePlayer(name) ?? false; }
  setPTTState(held: boolean): void { this.audio?.setPTTState(held); }

  private endSession(): void {
    // Stop VAD loop
    if (this.vadIntervalId !== null) {
      clearInterval(this.vadIntervalId);
      this.vadIntervalId = null;
    }

    this.minimapCV?.stop();
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
