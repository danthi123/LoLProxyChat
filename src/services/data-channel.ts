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
   * Returns and clears peer blobs (consume-once pattern prevents unbounded growth).
   */
  getPeerBlobs(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, blob] of this.peerBlobs) {
      // Only include blobs from peers that are still registered
      if (this.peers.has(name)) {
        result[name] = blob;
      }
    }
    this.peerBlobs.clear();
    return result;
  }
}
