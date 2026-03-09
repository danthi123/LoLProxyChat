import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { AudioSettings } from '../core/types';
import { createRnnoiseNode, RnnoiseNode } from './rnnoise';

export class AudioService {
  private localStream: MediaStream | null = null;
  private peers: Map<string, PeerConnection> = new Map();
  private signaling: SignalingService;
  private localName: string;
  private selfMuted = false;
  private muteAll = false;
  private mutedPlayers: Set<string> = new Set();
  private settings: AudioSettings = {
    inputMode: 'vad',
    inputVolume: 1.0,
    vadSensitivity: 0.25,
    pttKey: 'V',
    playerVolumes: {},
  };

  // Audio processing state
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private outputStream: MediaStream | null = null;
  private rnnoiseNode: RnnoiseNode | null = null;
  private vadActive = false;

  // PTT state
  private pttHeld = false;

  // VAD polling (reads RNNoise VAD score periodically)
  private vadPollId: number | null = null;

  constructor(signaling: SignalingService, localName: string) {
    this.signaling = signaling;
    this.localName = localName;
  }

  async initMicrophone(): Promise<void> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false, // RNNoise replaces browser noise suppression
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;
    const destination = this.audioContext.createMediaStreamDestination();

    // Try to load RNNoise for noise suppression + VAD
    try {
      this.rnnoiseNode = await createRnnoiseNode(this.audioContext);
      // Chain: mic → gain → rnnoise → destination
      source.connect(this.gainNode);
      this.gainNode.connect(this.rnnoiseNode.scriptNode);
      this.rnnoiseNode.scriptNode.connect(destination);
      console.log('[Audio] RNNoise loaded — noise suppression + VAD active');

      // Poll RNNoise VAD score at ~20Hz with hangover timer.
      // Hangover keeps the mic open for a short period after voice drops,
      // preventing word endings from being clipped.
      let vadHangoverRemaining = 0;
      const VAD_HANGOVER_MS = 400;     // keep mic open 400ms after voice drops
      const VAD_POLL_MS = 50;

      this.vadPollId = window.setInterval(() => {
        if (!this.rnnoiseNode || this.settings.inputMode !== 'vad') return;
        const score = this.rnnoiseNode.getVadScore();
        const wasActive = this.vadActive;

        if (score > this.settings.vadSensitivity) {
          // Voice detected — activate and reset hangover
          this.vadActive = true;
          vadHangoverRemaining = VAD_HANGOVER_MS;
        } else if (vadHangoverRemaining > 0) {
          // Below threshold but hangover still active — stay open
          vadHangoverRemaining -= VAD_POLL_MS;
        } else {
          // Hangover expired — deactivate
          this.vadActive = false;
        }

        if (this.vadActive !== wasActive) {
          this.updateLocalTrackState();
        }
      }, VAD_POLL_MS) as unknown as number;
    } catch (e) {
      // Fallback: no RNNoise, use browser built-in noiseSuppression
      console.warn('[Audio] RNNoise failed to load, falling back to browser noise suppression:', e);
      source.connect(this.gainNode);
      this.gainNode.connect(destination);
    }

    this.outputStream = destination.stream;
    for (const track of this.outputStream.getAudioTracks()) {
      track.enabled = true;
    }
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
    if (!this.outputStream) return;
    const enabled = !this.selfMuted && this.isTransmitting();
    // Disable/enable on outputStream tracks (what peers actually receive)
    for (const track of this.outputStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  // VAD is now handled by RNNoise polling in initMicrophone (no external call needed)

  // Connect to a new peer
  async connectToPeer(remoteName: string, isInitiator?: boolean): Promise<void> {
    if (this.peers.has(remoteName)) return;

    console.log('[Audio] Connecting to peer:', remoteName);
    const peer = new PeerConnection(remoteName);
    this.peers.set(remoteName, peer);

    if (this.outputStream) {
      peer.addLocalStream(this.outputStream);
    }

    peer.onIceCandidate = (candidate) => {
      this.signaling.sendSignal({
        type: 'ice-candidate',
        from: this.localName,
        to: remoteName,
        payload: candidate.toJSON(),
      });
    };

    // Initiator creates data channel + offer
    const shouldInitiate = isInitiator ?? (this.localName < remoteName);
    if (shouldInitiate) {
      // Create data channel BEFORE offer so it's included in the SDP
      peer.createDataChannel();
      console.log('[Audio] Creating offer (initiator) to:', remoteName);
      try {
        const offer = await peer.createOffer();
        this.signaling.sendSignal({
          type: 'offer',
          from: this.localName,
          to: remoteName,
          payload: offer,
        });
      } catch (e) {
        console.error('[Audio] Failed to create offer for:', remoteName, e);
        this.peers.delete(remoteName);
        peer.close();
      }
    }
  }

  // Handle incoming WebRTC signals
  async handleSignal(signal: SignalMessage): Promise<void> {
    console.log('[Audio] Received signal:', signal.type, 'from:', signal.from);
    try {
      let peer = this.peers.get(signal.from);

      if (signal.type === 'offer') {
        if (!peer) {
          peer = new PeerConnection(signal.from);
          this.peers.set(signal.from, peer);
          if (this.outputStream) peer.addLocalStream(this.outputStream);

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
    } catch (e) {
      console.error('[Audio] Signal handling failed:', signal.type, 'from:', signal.from, e);
    }
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
  }

  applyPeerVolumes(volumes: Record<string, number>): void {
    for (const [name, volume] of Object.entries(volumes)) {
      const peer = this.peers.get(name);
      if (!peer) continue;
      const playerVolume = this.settings.playerVolumes[name] ?? 1.0;
      const finalVol = volume * playerVolume;
      // Always update volume so it's correct when unmuted
      peer.setVolume(finalVol);
      if (this.muteAll || this.mutedPlayers.has(name) || finalVol === 0) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
  }

  // Mute controls
  toggleSelfMute(): boolean {
    this.selfMuted = !this.selfMuted;
    this.updateLocalTrackState();
    return this.selfMuted;
  }

  toggleMuteAll(): boolean {
    this.muteAll = !this.muteAll;
    for (const [name, peer] of this.peers) {
      if (this.muteAll || this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
    return this.muteAll;
  }

  toggleMutePlayer(name: string): boolean {
    if (this.mutedPlayers.has(name)) {
      this.mutedPlayers.delete(name);
    } else {
      this.mutedPlayers.add(name);
    }
    const peer = this.peers.get(name);
    if (peer) {
      if (this.mutedPlayers.has(name)) {
        peer.mute();
      } else {
        peer.unmute();
      }
    }
    return this.mutedPlayers.has(name);
  }

  setPlayerVolume(name: string, volume: number): void {
    this.settings.playerVolumes[name] = Math.max(0, Math.min(1, volume));
    // Apply immediately if peer exists
    const peer = this.peers.get(name);
    if (peer) {
      const proximityVol = 1.0; // will be updated next volume tick
      peer.setVolume(this.settings.playerVolumes[name] * proximityVol);
    }
  }

  isSelfMuted(): boolean { return this.selfMuted; }
  isMuteAll(): boolean { return this.muteAll; }
  isPlayerMuted(name: string): boolean { return this.mutedPlayers.has(name); }

  getPeer(name: string): PeerConnection | undefined {
    return this.peers.get(name);
  }

  hasPeer(name: string): boolean {
    return this.peers.has(name);
  }

  updateSettings(settings: Partial<AudioSettings>): void {
    Object.assign(this.settings, settings);
    this.applyInputVolume();
    this.updateLocalTrackState();
  }

  private applyInputVolume(): void {
    if (this.gainNode) {
      this.gainNode.gain.value = this.settings.inputVolume;
    }
  }

  cleanup(): void {
    for (const [, peer] of this.peers) {
      peer.close();
    }
    this.peers.clear();
    if (this.vadPollId !== null) {
      clearInterval(this.vadPollId);
      this.vadPollId = null;
    }
    this.rnnoiseNode?.destroy();
    this.rnnoiseNode = null;
    this.outputStream?.getTracks().forEach((t) => t.stop());
    this.outputStream = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
