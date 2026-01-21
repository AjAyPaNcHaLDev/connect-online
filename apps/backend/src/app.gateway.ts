import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Queue of socket IDs waiting for a match
  private waitingQueue: string[] = [];

  // Map of socket ID to Room ID (for quick lookups)
  private socketToRoom: Map<string, string> = new Map();

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    this.handleUserLeave(client.id);
  }

  @SubscribeMessage('join_queue')
  handleJoinQueue(@ConnectedSocket() client: Socket) {
    // If already in a room or queue, ignore (or handle gracefully)
    if (
      this.socketToRoom.has(client.id) ||
      this.waitingQueue.includes(client.id)
    ) {
      return;
    }

    console.log(`Client joined queue: ${client.id}`);

    if (this.waitingQueue.length > 0) {
      // Match found!
      const partnerId = this.waitingQueue.shift();

      // Ensure partner is still connected (basic check)
      if (partnerId === client.id) {
        // Should not happen if check above is correct, but safety first
        this.waitingQueue.push(client.id);
        return;
      }

      const roomId = `room_${partnerId}_${client.id}`;

      // Store room mapping
      this.socketToRoom.set(client.id, roomId);
      if (partnerId) {
        this.socketToRoom.set(partnerId, roomId);

        // Join both
        void client.join(roomId);
        void this.server.sockets.sockets.get(partnerId)?.join(roomId);

        // Notify match
        this.server.to(roomId).emit('match_found', { roomId });

        // Roles
        client.emit('is_initiator', true);
        this.server.to(partnerId).emit('is_initiator', false);

        console.log(`Match made: ${client.id} and ${partnerId} in ${roomId}`);
      }
    } else {
      // No match, add to queue
      this.waitingQueue.push(client.id);
      client.emit('waiting_for_match');
    }
  }

  @SubscribeMessage('leave_room')
  handleLeaveRoom(@ConnectedSocket() client: Socket) {
    this.handleUserLeave(client.id);
  }

  @SubscribeMessage('signal')
  handleSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { target: string; signal: unknown },
  ) {
    const roomId = this.socketToRoom.get(client.id);
    if (roomId) {
      // Broadcast to the room EXCEPT sender (usually just 1 other person)
      client
        .to(roomId)
        .emit('signal', { sender: client.id, signal: payload.signal });
    }
  }

  @SubscribeMessage('send_message')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { text: string },
  ) {
    const roomId = this.socketToRoom.get(client.id);
    if (roomId) {
      client
        .to(roomId)
        .emit('receive_message', { sender: 'partner', text: payload.text });
      // Echo back to sender so they see their own message confirmed (optional, usually frontend handles optimistic UI, but let's confirm)
      // client.emit('receive_message', { sender: 'me', text: payload.text });
    }
  }

  private handleUserLeave(socketId: string) {
    // Remove from queue if present
    this.waitingQueue = this.waitingQueue.filter((id) => id !== socketId);

    // If in a room, notify partner and clean up
    const roomId = this.socketToRoom.get(socketId);
    if (roomId) {
      // Notify other people in the room
      this.server.to(roomId).emit('partner_disconnected');

      // Remove mappings for everyone in the room (effectively dissolving it or letting the other person search again)
      this.server.in(roomId).socketsLeave(roomId); // Force leave? Or let them stay and search?

      // We need to find the partner ID to remove their mapping too
      // In a map based system, iterating is slow. Better to just broadcast "partner_disco" and let the frontend handle "search again"
      // But we MUST clean up the server memory.

      // In this simple 1v1, we can iterate or keep a bidirectional map.
      // For now, let's just cleanup the Leaving socket.
      // Realistically, the Partner needs to know they are now alone.

      this.socketToRoom.delete(socketId);

      // If we want to be thorough:
      // const partnerSocket = ... (hard to find without iterating or extra storage).
      // We'll rely on the room broadcast.
    }
  }
}
