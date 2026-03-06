import { ICE_SERVERS } from '../core/config';

export class PeerConnection {
  private pc: RTCPeerConnection;
  private remoteStream: MediaStream = new MediaStream();
  private audioElement: HTMLAudioElement;
  private dataChannel: RTCDataChannel | null = null;
  readonly remoteName: string;

  onIceCandidate: ((candidate: RTCIceCandidate) => void) | null = null;
  onDataMessage: ((data: string) => void) | null = null;

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

  private setupDataChannel(): void {
    if (!this.dataChannel) return;
    this.dataChannel.onmessage = (event) => {
      if (this.onDataMessage) this.onDataMessage(event.data);
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
    this.dataChannel?.close();
    this.pc.close();
    this.audioElement.pause();
    this.audioElement.srcObject = null;
  }
}
