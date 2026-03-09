import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../core/config';
import { Position } from '../core/types';

export type SignalType = 'offer' | 'answer' | 'ice-candidate';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to: string;
  payload: any;
}

export interface PositionBroadcast {
  summonerName: string;
  championName: string;
  team: string;
  position: Position;
  isMuted: boolean;
  isDead: boolean;
}

type OnPeerPosition = (peer: PositionBroadcast) => void;
type OnSignal = (signal: SignalMessage) => void;
type OnPeerLeave = (summonerName: string) => void;

export class SignalingService {
  private supabase: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private localName: string = '';

  constructor() {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }

  joinRoom(
    roomId: string,
    localName: string,
    onPeerPosition: OnPeerPosition,
    onSignal: OnSignal,
    onPeerLeave: OnPeerLeave,
  ): void {
    this.localName = localName;

    this.channel = this.supabase.channel('game:' + roomId, {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: localName },
      },
    });

    // Position broadcasts
    this.channel.on('broadcast', { event: 'position' }, ({ payload }) => {
      if (payload.summonerName !== this.localName) {
        onPeerPosition(payload as PositionBroadcast);
      }
    });

    // WebRTC signaling
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const signal = payload as SignalMessage;
      if (signal.to === this.localName) {
        onSignal(signal);
      }
    });

    // Presence tracking for leave detection
    this.channel.on('presence', { event: 'leave' }, ({ key }) => {
      if (key) onPeerLeave(key);
    });

    this.channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Joined room game:' + roomId);
        this.channel!.track({ summonerName: localName });
      }
    });
  }

  broadcastPosition(data: PositionBroadcast): void {
    this.channel?.send({
      type: 'broadcast',
      event: 'position',
      payload: data,
    });
  }

  sendSignal(signal: SignalMessage): void {
    this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: signal,
    });
  }

  leaveRoom(): void {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
  }
}
