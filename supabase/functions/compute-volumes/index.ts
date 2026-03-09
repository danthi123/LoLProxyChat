// supabase/functions/compute-volumes/index.ts
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const SECRET_KEY_HEX = Deno.env.get('POSITION_ENCRYPTION_KEY') || '';
const MAX_HEARING_RANGE = 1200;
const BLOB_MAX_AGE_MS = 10000; // 10s to handle clock skew

interface RequestBody {
  myPosition: { x: number; y: number };
  peers: Record<string, string>; // name -> encrypted blob (base64)
}

interface ResponseBody {
  myBlob: string;
  peerVolumes: Record<string, number>;
}

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!/^[0-9a-fA-F]{64}$/.test(SECRET_KEY_HEX)) {
    throw new Error('POSITION_ENCRYPTION_KEY must be 64 hex chars (256-bit)');
  }
  const keyBytes = hexToBytes(SECRET_KEY_HEX);
  cachedKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cachedKey;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex in encryption key');
    bytes[i / 2] = byte;
  }
  return bytes;
}

async function encryptPosition(key: CryptoKey, x: number, y: number): Promise<string> {
  const timestamp = Date.now();
  const payload = new TextEncoder().encode(JSON.stringify({ x, y, t: timestamp }));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);
  // Concatenate iv + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptPosition(key: CryptoKey, blob: string): Promise<{ x: number; y: number } | null> {
  try {
    const combined = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(decrypted));
    // Reject blobs older than BLOB_MAX_AGE_MS (handles clock skew)
    if (typeof payload.t !== 'number' || Math.abs(Date.now() - payload.t) > BLOB_MAX_AGE_MS) return null;
    return { x: payload.x, y: payload.y };
  } catch {
    return null;
  }
}

function calculateVolume(distance: number): number {
  if (distance >= MAX_HEARING_RANGE) return 0.0;
  if (distance <= 0) return 1.0;
  const normalized = distance / MAX_HEARING_RANGE;
  return Math.max(0, 1 - Math.log1p(normalized * (Math.E - 1)));
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST',
      },
    });
  }

  try {
    const body: RequestBody = await req.json();

    // Validate input
    if (!body.myPosition || typeof body.myPosition.x !== 'number' || typeof body.myPosition.y !== 'number' ||
        !isFinite(body.myPosition.x) || !isFinite(body.myPosition.y)) {
      return new Response(JSON.stringify({ error: 'Invalid position' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (body.peers && typeof body.peers !== 'object') {
      return new Response(JSON.stringify({ error: 'Invalid peers' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const key = await getKey();

    // Encrypt caller's position
    const myBlob = await encryptPosition(key, body.myPosition.x, body.myPosition.y);

    // Decrypt peer positions and compute volumes
    const peerVolumes: Record<string, number> = {};
    for (const [name, peerBlob] of Object.entries(body.peers)) {
      const peerPos = await decryptPosition(key, peerBlob);
      if (!peerPos) {
        peerVolumes[name] = 0;
        continue;
      }
      const dx = body.myPosition.x - peerPos.x;
      const dy = body.myPosition.y - peerPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      peerVolumes[name] = calculateVolume(distance);
    }

    const response: ResponseBody = { myBlob, peerVolumes };
    return new Response(JSON.stringify(response), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
