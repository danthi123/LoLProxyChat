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

  hasPeer(name: string): boolean {
    return this.peers.has(name);
  }

  unregisterPeer(name: string): void {
    this.peers.delete(name);
    this.peerBlobs.delete(name);
  }

  broadcastBlob(blob: string): void {
    for (const [, peer] of this.peers) {
      try {
        peer.sendData(blob);
      } catch (e) {
        console.warn('[DataChannel] Failed to send to peer:', e);
      }
    }
  }

  /**
   * Returns the latest blob from each registered peer.
   * Blobs persist until the peer sends a new one or is unregistered.
   * (No clear-on-read — volume tick runs at 8Hz but peers may send less often.)
   */
  getPeerBlobs(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, blob] of this.peerBlobs) {
      if (this.peers.has(name)) {
        result[name] = blob;
      }
    }
    return result;
  }
}
