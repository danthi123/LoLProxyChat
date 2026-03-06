import { PeerConnection } from './peer-connection';

export class DataChannelService {
  private peers: Map<string, PeerConnection> = new Map();
  private peerBlobs: Map<string, string> = new Map();

  registerPeer(name: string, peer: PeerConnection): void {
    this.peers.set(name, peer);
    peer.onDataMessage = (data: string) => {
      this.peerBlobs.set(name, data);
    };
  }

  unregisterPeer(name: string): void {
    this.peers.delete(name);
    this.peerBlobs.delete(name);
  }

  broadcastBlob(blob: string): void {
    for (const [, peer] of this.peers) {
      peer.sendData(blob);
    }
  }

  getPeerBlobs(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, blob] of this.peerBlobs) {
      result[name] = blob;
    }
    return result;
  }
}
