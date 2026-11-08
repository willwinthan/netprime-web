import React, { useRef, useState, useEffect, useCallback } from "react";
import { Play, Pause, RotateCcw, Volume2, ShieldCheck, ShieldAlert, CheckCircle2 } from "lucide-react";
import { API_BASE_URL } from "../hooks/useApi";

/** What the server has credited for this lesson (POST/GET /student/lessons/:id/progress). */
export interface WatchStatus {
  watched_seconds: number;
  required_seconds: number | null;
  completed: boolean;
}

interface VideoPlayerProps {
  lessonId: string;
  lessonTitle: string;
  signedUrl: string;
  isMock: boolean;
  videoProvider?: string;
  videoStreamUid?: string;
  /**
   * Playback heartbeat: sent every HEARTBEAT_MS while playing and on pause/end. The server credits real
   * playback from these and completes the lesson itself (backend/src/utils/videoProgress.ts).
   */
  onHeartbeat: (lessonId: string, seconds: number, duration: number | null) => void;
  watchStatus?: WatchStatus | null;
  initialTime?: number;
  onTimeUpdate?: (seconds: number) => void;
}

const HEARTBEAT_MS = 10_000;
const VIMEO_ORIGIN = "https://player.vimeo.com";
const YOUTUBE_ORIGINS = ["https://www.youtube.com", "https://www.youtube-nocookie.com"];

const parseMessage = (data: unknown): any => {
  if (typeof data !== "string") return data && typeof data === "object" ? data : null;
  try { return JSON.parse(data); } catch { return null; }
};

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  lessonId,
  lessonTitle,
  signedUrl,
  isMock,
  videoProvider = "cloudflare",
  videoStreamUid,
  onHeartbeat,
  watchStatus,
  initialTime = 0,
  onTimeUpdate,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const lastReportedSecond = useRef<number>(-1);

  // Latest playback state, read by the heartbeat timer and the embed message handlers
  const position = useRef(0);
  const length = useRef<number | null>(null);
  const playing = useRef(false);
  const started = useRef(false);
  const heartbeatRef = useRef(onHeartbeat);
  heartbeatRef.current = onHeartbeat;
  const timeUpdateRef = useRef(onTimeUpdate);
  timeUpdateRef.current = onTimeUpdate;
  const resumeAt = useRef(initialTime);
  // The lesson the playback state belongs to (a final heartbeat may run after lessonId changed)
  const trackedLesson = useRef(lessonId);

  const beat = useCallback(() => {
    if (started.current) heartbeatRef.current(trackedLesson.current, position.current, length.current);
  }, []);

  /** Shared by the native <video> and the Vimeo / YouTube embeds. */
  const track = useCallback((seconds: number, total: number | null, isNowPlaying: boolean) => {
    if (Number.isFinite(seconds) && seconds >= 0) position.current = seconds;
    if (total && Number.isFinite(total) && total > 0) length.current = total;
    setCurrentTime(position.current);
    if (length.current) setDuration(length.current);
    const sec = Math.floor(position.current);
    if (sec !== lastReportedSecond.current) {
      lastReportedSecond.current = sec;
      timeUpdateRef.current?.(position.current);
    }
    if (isNowPlaying && !playing.current) {
      playing.current = true;
      setIsPlaying(true);
      // The first heartbeat of a play sets the server's baseline
      started.current = true;
      beat();
    } else if (!isNowPlaying && playing.current) {
      playing.current = false;
      setIsPlaying(false);
      beat();
    }
  }, [beat]);

  // Heartbeat on a wall-clock timer while playing; final heartbeat when leaving the lesson
  useEffect(() => {
    const timer = window.setInterval(() => { if (playing.current) beat(); }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      if (playing.current) beat();
    };
  }, [lessonId, beat]);

  // Reset when switching lessons
  useEffect(() => {
    trackedLesson.current = lessonId;
    position.current = 0;
    length.current = null;
    playing.current = false;
    started.current = false;
    resumeAt.current = initialTime;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    lastReportedSecond.current = -1;
    if (videoRef.current) {
      videoRef.current.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonId]);

  const postToEmbed = useCallback((message: object, origin: string) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(message), origin);
  }, []);

  // Vimeo player postMessage API
  useEffect(() => {
    if (videoProvider !== "vimeo") return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== VIMEO_ORIGIN || event.source !== iframeRef.current?.contentWindow) return;
      const msg = parseMessage(event.data);
      if (!msg) return;
      if (msg.event === "ready") {
        for (const name of ["playProgress", "play", "pause", "finish", "seeked"])
          postToEmbed({ method: "addEventListener", value: name }, VIMEO_ORIGIN);
        postToEmbed({ method: "getDuration" }, VIMEO_ORIGIN);
        if (resumeAt.current > 1) postToEmbed({ method: "setCurrentTime", value: resumeAt.current }, VIMEO_ORIGIN);
      } else if (msg.method === "getDuration") {
        track(position.current, Number(msg.value), playing.current);
      } else if (msg.event === "playProgress" || msg.event === "play") {
        track(Number(msg.data?.seconds ?? position.current), Number(msg.data?.duration ?? 0), true);
      } else if (msg.event === "pause" || msg.event === "finish") {
        track(Number(msg.data?.seconds ?? position.current), Number(msg.data?.duration ?? 0), false);
      } else if (msg.event === "seeked") {
        track(Number(msg.data?.seconds ?? position.current), Number(msg.data?.duration ?? 0), playing.current);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [videoProvider, lessonId, track, postToEmbed]);

  // YouTube iframe postMessage API (enablejsapi=1)
  useEffect(() => {
    if (videoProvider !== "youtube") return;
    let seeked = false;
    const onMessage = (event: MessageEvent) => {
      if (!YOUTUBE_ORIGINS.includes(event.origin) || event.source !== iframeRef.current?.contentWindow) return;
      const msg = parseMessage(event.data);
      if (!msg) return;
      if (msg.event === "onReady" && !seeked && resumeAt.current > 1) {
        seeked = true;
        postToEmbed({ event: "command", func: "seekTo", args: [resumeAt.current, true] }, "*");
      }
      const info = msg.event === "infoDelivery" ? msg.info : msg.event === "initialDelivery" ? msg.info : null;
      if (!info) return;
      // playerState: 1 playing, 3 buffering (still watching), 2 paused, 0 ended
      const state = typeof info.playerState === "number" ? info.playerState : null;
      const nowPlaying = state === null ? playing.current : state === 1 || state === 3;
      track(Number(info.currentTime ?? position.current), Number(info.duration ?? 0), nowPlaying);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [videoProvider, lessonId, track, postToEmbed]);

  const onYoutubeLoad = () => {
    // Ask the player to start sending infoDelivery messages to this window
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: lessonId, channel: "widget" }), "*");
    for (const name of ["onReady", "onStateChange"])
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "addEventListener", args: [name], id: lessonId, channel: "widget" }), "*");
  };

  // Seek when initialTime changes (e.g., when clicking a note bookmark)
  useEffect(() => {
    if (initialTime === undefined || initialTime < 0) return;
    if (videoRef.current) {
      const diff = Math.abs(videoRef.current.currentTime - initialTime);
      if (diff > 1.5) {
        videoRef.current.currentTime = initialTime;
        setCurrentTime(initialTime);
      }
    } else if (Math.abs(position.current - initialTime) > 1.5 && started.current) {
      if (videoProvider === "vimeo") postToEmbed({ method: "setCurrentTime", value: initialTime }, VIMEO_ORIGIN);
      if (videoProvider === "youtube") postToEmbed({ event: "command", func: "seekTo", args: [initialTime, true] }, "*");
    }
  }, [initialTime, videoProvider, postToEmbed]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    track(v.currentTime, v.duration || null, !v.paused && !v.ended);
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration);
    length.current = videoRef.current.duration || null;
    if (initialTime && initialTime > 0) {
      videoRef.current.currentTime = initialTime;
      setCurrentTime(initialTime);
    }
  };

  const handleSpeedChange = (speed: number) => {
    if (!videoRef.current) return;
    videoRef.current.playbackRate = speed;
    setPlaybackSpeed(speed);
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const isCF = videoProvider === "cloudflare";
  const isR2Video = videoStreamUid && (videoStreamUid.startsWith("videos/") || videoStreamUid.includes("/"));
  const r2VideoUrl = isR2Video 
    ? `${API_BASE_URL}/student/video?key=${encodeURIComponent(videoStreamUid!)}&token=${localStorage.getItem("netprime_token") || ""}`
    : "";

  return (
    <div className="glass-card" style={{ padding: "0", overflow: "hidden", border: "1px solid var(--border-active)" }}>
      {/* Video Canvas Container */}
      <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", background: "#000" }}>
        {videoProvider === "youtube" ? (
          <iframe
            ref={iframeRef}
            onLoad={onYoutubeLoad}
            src={`https://www.youtube.com/embed/${videoStreamUid}?enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
            style={{ border: "none", width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : videoProvider === "vimeo" ? (
          <iframe
            ref={iframeRef}
            src={`https://player.vimeo.com/video/${videoStreamUid}`}
            style={{ border: "none", width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
          />
        ) : isR2Video ? (
          // Direct Secure R2 Video Player
          <video
            ref={videoRef}
            src={r2VideoUrl}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handleTimeUpdate}
            onPause={handleTimeUpdate}
            onEnded={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onClick={togglePlay}
          />
        ) : isMock ? (
          // Dev Mode: Interactive Video with mock Cloudflare Stream telemetry
          <video
            ref={videoRef}
            src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            onTimeUpdate={handleTimeUpdate}
            onPlay={handleTimeUpdate}
            onPause={handleTimeUpdate}
            onEnded={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onClick={togglePlay}
          />
        ) : (
          // Production Mode: Embed actual Cloudflare Stream Player iframe
          <iframe
            src={signedUrl}
            style={{ border: "none", width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
            allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}

        {/* Development overlay HUD */}
        <div style={{ 
          position: "absolute", 
          top: "16px", 
          left: "16px", 
          background: "rgba(0, 0, 0, 0.75)", 
          padding: "6px 12px", 
          borderRadius: "99px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          fontSize: "11px",
          color: "#fff",
          backdropFilter: "blur(4px)"
        }}>
          {isR2Video ? (
            <>
              <ShieldCheck size={14} color="var(--primary)" />
              <span>สตรีมวิดีโอที่ปลอดภัย (ผ่านพร็อกซี)</span>
            </>
          ) : videoProvider === "youtube" ? (
            <>
              <ShieldCheck size={14} color="var(--primary)" />
              <span>วิดีโอฝังจาก YouTube</span>
            </>
          ) : videoProvider === "vimeo" ? (
            <>
              <ShieldCheck size={14} color="var(--primary)" />
              <span>วิดีโอฝังจาก Vimeo</span>
            </>
          ) : isMock ? (
            <>
              <ShieldCheck size={14} color="var(--accent)" />
              <span>โหมดจำลองสำหรับนักพัฒนา</span>
            </>
          ) : (
            <>
              <ShieldAlert size={14} color="var(--primary)" />
              <span>สตรีมผ่าน Cloudflare (ลิงก์ที่ลงนามแล้ว)</span>
            </>
          )}
        </div>
      </div>

      {/* Controller bar (only for developer simulation mode or secure R2 player) */}
      {(isMock || isR2Video) && isCF && (
        <div style={{ padding: "16px", background: "rgba(0, 0, 0, 0.4)", display: "flex", flexDirection: "column", gap: "12px" }}>
          
          {/* Progress bar scrub */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{formatTime(currentTime)}</span>
            <div className="progress-bar-container" style={{ flexGrow: 1, cursor: "pointer", height: "4px" }} onClick={(e) => {
              if (!videoRef.current || duration === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const pos = (e.clientX - rect.left) / rect.width;
              videoRef.current.currentTime = pos * duration;
            }}>
              <div 
                className="progress-bar-fill progress-bar-blue" 
                style={{ width: `${(currentTime / (duration || 1)) * 100}%` }}
              />
            </div>
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{formatTime(duration)}</span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
              <button 
                onClick={togglePlay}
                aria-label={isPlaying ? "หยุดชั่วคราว" : "เล่น"}
                style={{ background: "none", border: "none", color: "#fff", cursor: "pointer" }}
              >
                {isPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>
              
              <button 
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = 0;
                }}
                aria-label="เล่นใหม่ตั้งแต่ต้น"
                style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer" }}
              >
                <RotateCcw size={16} />
              </button>

              <div style={{ display: "flex", alignItems: "center", gap: "6px", color: "var(--text-secondary)" }}>
                <Volume2 size={16} />
                <span style={{ fontSize: "12px" }}>100%</span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 600 }}>ความเร็วในการเล่น</span>
              {[1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  onClick={() => handleSpeedChange(speed)}
                  style={{
                    background: playbackSpeed === speed ? "var(--primary)" : "rgba(255,255,255,0.05)",
                    border: "none",
                    color: "#fff",
                    fontSize: "11px",
                    fontWeight: "600",
                    padding: "4px 8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    transition: "var(--transition-fast)"
                  }}
                >
                  {speed}x
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Footer Meta */}
      <div style={{ padding: "16px 24px", borderTop: "1px solid var(--border-subtle)", background: "rgba(0, 0, 0, 0.2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ fontSize: "16px", fontWeight: "600", color: "#fff" }}>{lessonTitle}</h3>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
            {videoProvider === "youtube" ? "สตรีมผ่าน YouTube" :
             videoProvider === "vimeo" ? "สตรีมผ่าน Vimeo" :
             "สตรีมอย่างปลอดภัยผ่านเครือข่าย Cloudflare ตรวจสอบลายเซ็นป้องกันการละเมิดลิขสิทธิ์แล้ว"}
          </p>
        </div>
        <WatchBadge status={watchStatus} trackable={videoProvider !== "cloudflare" || isMock || !!isR2Video} />
      </div>
    </div>
  );
};


/** Shows how much playback the server has credited; video lessons complete on their own. */
const WatchBadge: React.FC<{ status?: WatchStatus | null; trackable: boolean }> = ({ status, trackable }) => {
  const style: React.CSSProperties = { fontSize: "12px", color: "var(--text-secondary)", textAlign: "right", flexShrink: 0, marginLeft: "16px" };
  if (status?.completed) {
    return (
      <span style={{ ...style, display: "flex", alignItems: "center", gap: "6px", color: "var(--primary)", fontWeight: 600 }}>
        <CheckCircle2 size={16} /> เรียนจบบทนี้แล้ว
      </span>
    );
  }
  if (!trackable) return <span style={style}>วิดีโอแบบนี้ยังบันทึกการดูอัตโนมัติไม่ได้</span>;
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  return (
    <span style={style}>
      {status?.required_seconds
        ? <>ดูแล้ว {fmt(Math.min(status.watched_seconds, status.required_seconds))} / {fmt(status.required_seconds)}<br /></>
        : null}
      ระบบบันทึกว่าเรียนจบเมื่อดูวิดีโอถึง 90%
    </span>
  );
};
