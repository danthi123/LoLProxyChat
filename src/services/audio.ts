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
  private gainNode: GainNode | null = null;
  private outputStream: MediaStream | null = null;
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

    // Set up VAD analyser with input gain
    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    const destination = this.audioContext.createMediaStreamDestination();
    this.gainNode.connect(destination);
    this.outputStream = destination.stream;
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

  // Called periodically (~20 times/sec) to check voice activity
  updateVAD(): void {
    if (this.settings.inputMode !== 'vad' || !this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, val) => sum + val, 0) / data.length;
    const threshold = 30;
    this.vadActive = average > threshold;
    this.updateLocalTrackState();
  }

  // Connect to a new peer
  async connectToPeer(remoteName: string): Promise<void> {
    if (this.peers.has(remoteName)) return;

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

    // Alphabetically first name creates the offer (deterministic initiator)
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

  // Handle incoming WebRTC signals
  async handleSignal(signal: SignalMessage): Promise<void> {
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
  }

  disconnectPeer(remoteName: string): void {
    const peer = this.peers.get(remoteName);
    if (peer) {
      peer.close();
      this.peers.delete(remoteName);
    }
    this.peerPositions.delete(remoteName);
  }

  // Position & volume updates
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

  // Vision-based cutoff for enemies
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

  // Mute controls
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
    this.applyInputVolume();
    this.updateLocalTrackState();
    this.updateAllVolumes();
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
    this.peerPositions.clear();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
