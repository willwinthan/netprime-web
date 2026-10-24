import React from "react";
import * as Icons from "lucide-react";

interface MetricsCardProps {
  title: string;
  value: string | number;
  subValue?: string;
  icon: keyof typeof Icons;
  progress?: {
    current: number;
    total: number;
  };
  color?: "blue" | "purple" | "accent";
}

export const MetricsCard: React.FC<MetricsCardProps> = ({
  title,
  value,
  subValue,
  icon,
  progress,
  color = "blue",
}) => {
  const IconComponent = Icons[icon] as React.ComponentType<{ className?: string }>;

  // Map color tokens to CSS variable classes
  const colorMap = {
    blue: {
      text: "var(--primary)",
      glow: "var(--primary-glow)",
      fill: "progress-bar-blue",
      border: "rgba(59, 130, 246, 0.15)",
    },
    purple: {
      text: "var(--secondary)",
      glow: "var(--secondary-glow)",
      fill: "progress-bar-purple",
      border: "rgba(168, 85, 247, 0.15)",
    },
    accent: {
      text: "var(--accent)",
      glow: "var(--accent-glow)",
      fill: "progress-bar-accent",
      border: "rgba(16, 185, 129, 0.15)",
    },
  };

  const selectedColor = colorMap[color];
  const progressPercent = progress ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;

  return (
    <div 
      className="glass-card animate-fade-in" 
      style={{ 
        borderLeft: `4px solid ${selectedColor.text}`,
        borderColor: `${selectedColor.border} ${selectedColor.border} ${selectedColor.border} ${selectedColor.text}`
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            {title}
          </span>
          <h2 style={{ fontSize: "28px", marginTop: "4px", fontFamily: "Outfit, sans-serif", fontWeight: 700 }}>
            {value}
          </h2>
          {subValue && (
            <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
              {subValue}
            </p>
          )}
        </div>
        
        <div style={{ 
          padding: "10px", 
          borderRadius: "10px", 
          background: selectedColor.glow, 
          color: selectedColor.text 
        }}>
          {IconComponent && <IconComponent className="icon-class" />}
        </div>
      </div>

      {progress && (
        <div style={{ marginTop: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-secondary)", marginBottom: "6px" }}>
            <span>การใช้งาน</span>
            <span>{progressPercent}% ({progress.current}/{progress.total})</span>
          </div>
          <div className="progress-bar-container">
            <div 
              className={`progress-bar-fill ${selectedColor.fill}`} 
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
