import { useEffect, useRef, useState } from 'react';
import type { Bot } from '@orbit/contracts';
import { portraitUrl } from '../../voice/api';
import { registerAvatarCanvas, useAvatarCall } from '../../voice/audiocpp-call';

function CameraGlyph({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10l5-3v10l-5-3z" />
      <rect x="3" y="6" width="12" height="12" rx="2" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

/**
 * The video half of a GPU-voice call: the bot's portrait, lip-synced by SoulX-FlashHead while it
 * speaks (frames are drawn by audiocpp-call.ts onto the canvas registered here), and an optional
 * self-view of the person's own camera. The self-view never leaves this browser.
 */
export function AvatarVideo({ bot, speaking }: { bot: Bot; speaking: boolean }) {
  const hasAvatar = useAvatarCall((s) => s.hasAvatar);
  const videoLive = useAvatarCall((s) => s.videoLive);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selfRef = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    registerAvatarCanvas(canvasRef.current);
    return () => registerAvatarCanvas(null);
  }, [hasAvatar]);

  useEffect(() => {
    if (selfRef.current) selfRef.current.srcObject = camera;
  }, [camera]);

  // The camera goes off with the call (this component unmounts) and when toggled.
  useEffect(() => () => camera?.getTracks().forEach((t) => t.stop()), [camera]);

  const toggleCamera = async () => {
    if (camera) { setCamera(null); return; }
    setCameraError(null);
    try {
      setCamera(await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' }, audio: false }));
    } catch {
      setCameraError('Camera unavailable');
    }
  };

  if (!hasAvatar) return null;
  return (
    <div className={`vcall__video${speaking ? ' is-speaking' : ''}`} aria-label={`${bot.name}'s animated portrait`}>
      <img className="vcall__portrait" src={portraitUrl(bot.id)} alt="" aria-hidden />
      <canvas ref={canvasRef} className={`vcall__frames${videoLive ? ' is-live' : ''}`} width={512} height={512} />
      {camera && <video ref={selfRef} className="vcall__self" autoPlay muted playsInline aria-label="Your camera" />}
      <button
        type="button"
        className={`vcall__btn vcall__cam${camera ? ' is-on' : ''}`}
        onClick={() => void toggleCamera()}
        aria-pressed={!!camera}
        aria-label={camera ? 'Hide your camera' : 'Show your camera'}
        title={cameraError ?? (camera ? 'Hide your camera' : 'Show your camera (stays on this device)')}
      >
        <CameraGlyph off={!camera} />
      </button>
    </div>
  );
}
