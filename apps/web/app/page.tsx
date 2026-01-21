'use client';

import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Video, Mic, MicOff, VideoOff, MessageSquare, Send, MonitorPlay, X } from 'lucide-react';
import styles from './page.module.css';

// Environment variable for backend URL, default to localhost:3001
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

type Message = {
  sender: 'me' | 'partner' | 'system';
  text: string;
};

export default function Page() {
  const [status, setStatus] = useState<'idle' | 'searching' | 'connected'>('idle');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  // Initial setup
  useEffect(() => {
    socketRef.current = io(BACKEND_URL, {
      transports: ['websocket'], // Force websocket
    });

    const socket = socketRef.current;

    socket.on('connect', () => {
      console.log('Connected to signaling server');
    });

    socket.on('waiting_for_match', () => {
      setStatus('searching');
    });

    socket.on('match_found', async ({ roomId }: { roomId: string }) => {
      setStatus('connected');
      setMessages([]); // Clear chat for new match
    });

    socket.on('is_initiator', async (isInitiator: boolean) => {
      console.log('Role assigned:', isInitiator ? 'Initiator' : 'Receiver');
      if (isInitiator) {
        createOffer();
      }
    });

    socket.on('signal', async (data: { sender: string; signal: RTCSessionDescriptionInit | RTCIceCandidateInit }) => {
      const peer = peerConnectionRef.current;
      if (!peer) return;

      if ('type' in data.signal) {
        // It's an SDP (Offer or Answer)
        await peer.setRemoteDescription(new RTCSessionDescription(data.signal as RTCSessionDescriptionInit));

        if (data.signal.type === 'offer') {
          createAnswer();
        }
      } else if ('candidate' in data.signal) {
        // It's an ICE Candidate
        try {
          await peer.addIceCandidate(new RTCIceCandidate(data.signal as RTCIceCandidateInit));
        } catch (e) {
          console.error("Error adding ice candidate", e);
        }
      }
    });

    socket.on('receive_message', (data: { sender: 'partner', text: string }) => {
      setMessages(prev => [...prev, { sender: 'partner', text: data.text }]);
    });

    socket.on('partner_disconnected', () => {
      setMessages(prev => [...prev, { sender: 'system', text: 'Partner disconnected.' }]);
      cleanupConnection();
      setStatus('idle'); // Or 'searching' if you want auto-requeue
    });

    return () => {
      socket.disconnect();
      cleanupConnection();
    };
  }, []);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error("Failed to get media", err);
      alert("Could not access camera/microphone");
    }
  };

  const stopCamera = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
  };

  const handleJoin = async () => {
    if (!localStreamRef.current) {
      await startCamera();
    }

    // Initialize PeerConnection
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Public Google STUN server
      ]
    });

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        peer.addTrack(track, localStreamRef.current!);
      });
    }

    // Handle remote tracks
    peer.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // Handle ICE candidates
    peer.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('signal', { target: 'partner', signal: event.candidate });
      }
    };

    peerConnectionRef.current = peer;

    // Join queue
    socketRef.current?.emit('join_queue');
    setStatus('searching');
  };

  const handleLeave = () => {
    socketRef.current?.emit('leave_room');
    cleanupConnection();
    setStatus('idle');
  };

  const cleanupConnection = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const createOffer = async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socketRef.current?.emit('signal', { target: 'partner', signal: offer });
    } catch (err) {
      console.error("Error creating offer", err);
    }
  };

  const createAnswer = async () => {
    const peer = peerConnectionRef.current;
    if (!peer) return;
    try {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current?.emit('signal', { target: 'partner', signal: answer });
    } catch (err) {
      console.error("Error creating answer", err);
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    socketRef.current?.emit('send_message', { text: inputText });
    setMessages(prev => [...prev, { sender: 'me', text: inputText }]);
    setInputText('');
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  return (
    <div className={styles.container}>
      {/* Main Content Area */}
      <div className={styles.mainContent}>

        {/* Header / Top Bar */}
        <div className={styles.header}>
          <div className={styles.brand}>
            <MonitorPlay className={styles.brandIcon} size={24} />
            <span>SyncStream</span>
          </div>
          <div>
            <span className={styles.statusBadge}>
              {status === 'idle' && 'Ready to Connect'}
              {status === 'searching' && 'Looking for someone...'}
              {status === 'connected' && 'Connected'}
            </span>
          </div>
        </div>

        {/* Video Grid */}
        <div className={styles.videoGrid}>
          {/* Remote Video */}
          <div className={`${styles.remoteVideoContainer} ${status !== 'connected' ? styles.hidden : ''}`}>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={styles.remoteVideo}
            />
            <div className={styles.videoLabel}>Stranger</div>
          </div>

          {/* Local Video */}
          <div className={`${styles.localVideoContainer} ${status === 'connected' ? styles.pip : styles.large}`}>
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={styles.localVideo}
              style={{ opacity: isVideoOff ? 0 : 1 }}
            />
            {!localStreamRef.current && status === 'idle' && (
              <div className={styles.overlay}>
                <p style={{ color: '#a3a3a3' }}>Camera permission needed</p>
                <button onClick={startCamera} className={styles.primaryButton} style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}>
                  Enable Camera
                </button>
              </div>
            )}

            {/* Self Label */}
            <div className={styles.videoLabel}>You</div>

            {/* Pre-connection Actions */}
            {localStreamRef.current && status === 'idle' && (
              <div className={styles.overlay}>
                <button
                  onClick={handleJoin}
                  className={styles.primaryButton}
                >
                  Start Finding People
                </button>
              </div>
            )}
            {status === 'searching' && (
              <div className={styles.overlay}>
                <div className={styles.loader}></div>
                <button onClick={handleLeave} className={styles.controlBtn} style={{ borderRadius: '4px', padding: '0.5rem 1rem', fontSize: '0.875rem' }}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Controls Bar */}
        <div className={styles.controlsBar}>
          <button onClick={toggleMute} className={`${styles.controlBtn} ${isMuted ? styles.active : ''}`}>
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>
          <button onClick={toggleVideo} className={`${styles.controlBtn} ${isVideoOff ? styles.active : ''}`}>
            {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
          </button>

          {status === 'connected' && (
            <button
              onClick={handleLeave}
              className={styles.nextButton}
            >
              Next Person <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Chat Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <MessageSquare size={20} className={styles.brandIcon} />
          <span>Live Chat</span>
        </div>

        <div className={styles.messagesArea}>
          {messages.length === 0 && status !== 'connected' && (
            <div style={{ color: '#737373', textAlign: 'center', marginTop: '2rem' }}>
              Connect with someone to start chatting.
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`${styles.messageRow} ${msg.sender === 'me' ? styles.me : (msg.sender === 'system' ? '' : styles.partner)}`}>
              <div className={`${styles.messageBubble} ${msg.sender === 'me' ? styles.me : (msg.sender === 'system' ? styles.system : styles.partner)}`}>
                {msg.text}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={sendMessage} className={styles.inputArea}>
          <input
            className={styles.inputField}
            placeholder="Type a message..."
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            disabled={status !== 'connected'}
          />
          <button
            type="submit"
            disabled={status !== 'connected' || !inputText.trim()}
            className={styles.sendBtn}
          >
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}
