// src/services/volume-client.ts
import { Position } from '../core/types';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../core/config';

interface VolumeResponse {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

export class VolumeClient {
  private endpoint: string;
  private authHeader: string;

  constructor() {
    this.endpoint = `${SUPABASE_URL}/functions/v1/compute-volumes`;
    this.authHeader = `Bearer ${SUPABASE_ANON_KEY}`;
  }

  async computeVolumes(
    myPosition: Position,
    peerBlobs: Record<string, string>,
  ): Promise<VolumeResponse> {
    const resp = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.authHeader,
      },
      body: JSON.stringify({
        myPosition: { x: myPosition.x, y: myPosition.y },
        peers: peerBlobs,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Volume API error: ${resp.status}`);
    }

    return resp.json();
  }
}
