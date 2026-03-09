import { getIceServers, ICE_SERVERS } from '../core/config';

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  readonly remoteName: string;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  onDataMessage: ((data: string) => void) | null = null;

  private constructor(remoteName: string, iceServers: RTCIceServer[]) {
    this.remoteName = remoteName;
    this.pc = new RTCPeerConnection({ iceServers });

    this.audioElement = new Audio();
    this.audioElement.autoplay = true;
    this.audioElement.srcObject = this.remoteStream;

    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    this.pc.ontrack = (event) => {
      console.log('[WebRTC] Got remote track from', remoteName, 'kind:', event.track.kind);
      this.remoteStream.addTrack(event.track);
      // Ensure audio plays (autoplay may be blocked)
      this.audioElement.play().catch((e) => {
        console.warn('[WebRTC] Audio play failed for', remoteName, ':', e);
      });
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state with', remoteName, ':', this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state with', remoteName, ':', this.pc.iceConnectionState);
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };
  }

  static async create(remoteName: string): Promise<PeerConnection> {
    const iceServers = await getIceServers();
    return new PeerConnection(remoteName, iceServers);
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) return;
    this.dataChannel.onmessage = (event) => {
      if (this.onDataMessage) this.onDataMessage(event.data);
    };
    this.dataChannel.onerror = (event) => {
      console.warn('[WebRTC] Data channel error with', this.remoteName, ':', event);
    };
  }

  createDataChannel(): void {
    this.dataChannel = this.pc.createDataChannel('position', { ordered: false, maxRetransmits: 0 });
    this.setupDataChannel();
  }

  sendData(data: string): void {
    if (this.dataChannel?.readyState === 'open') {
      this.dataChannel.send(data);
    }
  }

  addLocalStream(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.pc.createOffer();
    offer.sdp = this.enhanceOpusSdp(offer.sdp || '');
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
    const answer = await this.pc.createAnswer();
    answer.sdp = this.enhanceOpusSdp(answer.sdp || '');
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Modify SDP to set Opus bitrate to 128kbps and enable DTX.
   * DTX (Discontinuous Transmission) stops sending packets during silence,
   * saving bandwidth without affecting audio quality.
   */
  private enhanceOpusSdp(sdp: string): string {
    return sdp.replace(
      /a=fmtp:111 (.*)/g,
      (match, params) => {
        let enhanced = params;
        // Set max bitrate to 128kbps
        if (!enhanced.includes('maxaveragebitrate')) {
          enhanced += ';maxaveragebitrate=128000';
        }
        // Enable DTX (silence suppression)
        if (!enhanced.includes('usedtx')) {
          enhanced += ';usedtx=1';
        }
        return 'a=fmtp:111 ' + enhanced;
      }
    );
  }

  async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    this.hasRemoteDescription = true;
    await this.flushPendingCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
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
    this.dataChannel?.close();
    this.remoteStream.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }
}
