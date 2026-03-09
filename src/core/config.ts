// Injected at build time via webpack.DefinePlugin — see .env.example
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const SUPABASE_URL: string = typeof __SUPABASE_URL__ !== 'undefined'
  ? __SUPABASE_URL__
  : 'https://your-project.supabase.co';
export const SUPABASE_ANON_KEY: string = typeof __SUPABASE_ANON_KEY__ !== 'undefined'
  ? __SUPABASE_ANON_KEY__
  : '';

// TURN server config — injected at build time via webpack.DefinePlugin
declare const __TURN_SERVER__: string;
declare const __TURN_SECRET__: string;
const TURN_SERVER: string = typeof __TURN_SERVER__ !== 'undefined' ? __TURN_SERVER__ : '';
const TURN_SECRET: string = typeof __TURN_SECRET__ !== 'undefined' ? __TURN_SECRET__ : '';

/**
 * Generate time-limited TURN credentials using HMAC-SHA1.
 * coturn's use-auth-secret expects: username = "expiry:arbitrary", credential = HMAC-SHA1(secret, username).
 */
async function generateTurnCredentials(): Promise<{ username: string; credential: string }> {
  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600; // 24h from now
  const username = expiry + ':proxchat';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(TURN_SECRET), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { username, credential };
}

// WebRTC STUN/TURN servers
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

/** Build ICE servers list with fresh TURN credentials. */
export async function getIceServers(): Promise<RTCIceServer[]> {
  if (!TURN_SERVER || !TURN_SECRET) return ICE_SERVERS;
  const { username, credential } = await generateTurnCredentials();
  return [
    ...ICE_SERVERS,
    { urls: `stun:${TURN_SERVER}:3478` },
    { urls: `turn:${TURN_SERVER}:3478`, username, credential },
    { urls: `turns:${TURN_SERVER}:5349`, username, credential },
  ];
}
