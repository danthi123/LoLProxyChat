import { PeerConnection } from './peer-connection';
import { SignalingService, SignalMessage } from './signaling';
import { AudioSettings } from '../core/types';

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
    // Ensure output tracks start enabled
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

  // Called periodically (~20 times/sec) to check voice activity
  private vadLogCounter = 0;
  updateVAD(): void {
    if (this.settings.inputMode !== 'vad' || !this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, val) => sum + val, 0) / data.length;
    const threshold = 15; // Lower threshold for easier voice detection
    const wasActive = this.vadActive;
    this.vadActive = average > threshold;
    this.vadLogCounter++;
    // Log VAD state every ~5 seconds (100 calls at 20/sec)
    if (this.vadLogCounter % 100 === 0) {
      console.log('[Audio] VAD: avg=' + average.toFixed(1) + ' active=' + this.vadActive +
        ' transmitting=' + this.isTransmitting() + ' selfMuted=' + this.selfMuted +
        ' mode=' + this.settings.inputMode +
        ' outputTracks=' + (this.outputStream?.getAudioTracks().length ?? 0) +
        ' tracksEnabled=' + (this.outputStream?.getAudioTracks().map(t => t.enabled).join(',') ?? 'none'));
    }
    // Only update track state when VAD state changes to reduce toggling
    if (this.vadActive !== wasActive) {
      this.updateLocalTrackState();
    }
  }

  // Connect to a new peer
  async connectToPeer(remoteName: string): Promise<void> {
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

    // Alphabetically first name creates the offer (deterministic initiator)
    if (this.localName < remoteName) {
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
      if (this.muteAll || this.mutedPlayers.has(name)) {
        peer.mute();
        continue;
      }
      const playerVolume = this.settings.playerVolumes[name] ?? 1.0;
      const finalVol = volume * playerVolume;
      peer.setVolume(finalVol);
      if (finalVol > 0) {
        peer.unmute();
      } else {
        peer.mute();
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
    for (const [, peer] of this.peers) {
      if (this.muteAll) {
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
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.audioContext?.close();
    this.audioContext = null;
  }
}
