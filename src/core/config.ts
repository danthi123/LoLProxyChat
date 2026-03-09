// Injected at build time via webpack.DefinePlugin — see .env.example
declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

export const SUPABASE_URL: string = typeof __SUPABASE_URL__ !== 'undefined'
  ? __SUPABASE_URL__
  : 'https://your-project.supabase.co';
export const SUPABASE_ANON_KEY: string = typeof __SUPABASE_ANON_KEY__ !== 'undefined'
  ? __SUPABASE_ANON_KEY__
  : '';

// WebRTC STUN/TURN servers
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add a TURN server for users behind symmetric NATs:
  // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' },
];
