import React, { useRef, useState, useEffect } from "react";
import { Play, Pause, RotateCcw, Volume2, ShieldCheck, ShieldAlert } from "lucide-react";
import { API_BASE_URL } from "../hooks/useApi";

interface VideoPlayerProps {
  lessonId: string;
  lessonTitle: string;
  signedUrl: string;
  isMock: boolean;
  videoProvider?: string;
  videoStreamUid?: string;
  onProgress: (percent: number) => void;
  onComplete: () => void;
  initialTime?: number;
  onTimeUpdate?: (seconds: number) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  lessonId,
  lessonTitle,
  signedUrl,
  isMock,
  videoProvider = "cloudflare",
  videoStreamUid,
  onProgress,
  onComplete,
  initialTime = 0,
  onTimeUpdate,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [hasCompleted, setHasCompleted] = useState(false);
  const lastReportedSecond = useRef<number>(-1);

  // Seek when initialTime changes (e.g., when clicking a note bookmark)
  useEffect(() => {
    if (videoRef.current && initialTime !== undefined && initialTime >= 0) {
      const diff = Math.abs(videoRef.current.currentTime - initialTime);
      if (diff > 1.5) {
        videoRef.current.currentTime = initialTime;
        setCurrentTime(initialTime);
      }
    }
  }, [initialTime]);

  // Reset completion state when switching lessons
  useEffect(() => {
    setHasCompleted(false);
    setIsPlaying(false);
    lastReportedSecond.current = -1;
    if (videoRef.current) {
      videoRef.current.load();
    }
  }, [lessonId]);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const current = videoRef.current.currentTime;
    const total = videoRef.current.duration || 1;
    setCurrentTime(current);

    // Report time updates throttled to once per second
    const currentSec = Math.floor(current);
    if (onTimeUpdate && currentSec !== lastReportedSecond.current) {
      lastReportedSecond.current = currentSec;
      onTimeUpdate(current);
    }
    
    const percent = Math.min(100, Math.round((current / total) * 100));
    
    // Periodically update progress (e.g., at multiples of 10%)
    if (percent > 0 && percent % 10 === 0) {
      onProgress(percent);
    }

    // Mark completed once watched past 95%
    if (percent >= 95 && !hasCompleted) {
      setHasCompleted(true);
      onComplete();
    }
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    setDuration(videoRef.current.duration);
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
            src={`https://www.youtube.com/embed/${videoStreamUid}`}
            style={{ border: "none", width: "100%", height: "100%", position: "absolute", top: 0, left: 0 }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : videoProvider === "vimeo" ? (
          <iframe
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
        {(!isMock && !isR2Video) && (
          <button
            onClick={() => {
              onProgress(100);
              onComplete();
            }}
            className="tech-button-primary"
            style={{ padding: "8px 16px", borderRadius: "12px", fontSize: "13px" }}
          >
            ทำเครื่องหมายว่าเรียนจบ
          </button>
        )}
      </div>
    </div>
  );
};
