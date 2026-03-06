// Configure these values - see docs/SETUP.md
export const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
export const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY_HERE';

// WebRTC STUN/TURN servers
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add a TURN server for users behind symmetric NATs:
  // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' },
];
