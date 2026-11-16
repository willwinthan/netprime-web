// Equipment drawings shared by the lab designer board and the learner's topology view (NetPrime's own art).
import React from "react";
import type { DeviceKind } from "./labSpec";
import "./deviceIcon.css";

/** NetPrime's own simple equipment drawings (centred on 0,0). */
export const DeviceIcon: React.FC<{ kind: DeviceKind }> = ({ kind }) => {
  if (kind === "router") return (
    <g className="np-ld-icon router">
      <ellipse cx={0} cy={6} rx={26} ry={10} className="np-ld-icon-side" />
      <rect x={-26} y={-6} width={52} height={12} className="np-ld-icon-side" />
      <ellipse cx={0} cy={-6} rx={26} ry={10} className="np-ld-icon-top" />
      <path d="M-14 -6 h10 m-3 -3 l3 3 l-3 3 M14 -6 h-10 m3 -3 l-3 3 l3 3" className="np-ld-icon-mark" />
    </g>
  );
  if (kind === "switch") return (
    <g className="np-ld-icon switch">
      <rect x={-28} y={-12} width={56} height={24} rx={4} className="np-ld-icon-top" />
      <path d="M-16 -4 h22 m-3 -3 l3 3 l-3 3 M16 4 h-22 m3 -3 l-3 3 l3 3" className="np-ld-icon-mark" />
    </g>
  );
  if (kind === "pc") return (
    <g className="np-ld-icon pc">
      <rect x={-20} y={-18} width={40} height={26} rx={3} className="np-ld-icon-top" />
      <rect x={-6} y={8} width={12} height={6} className="np-ld-icon-side" />
      <rect x={-14} y={14} width={28} height={4} rx={2} className="np-ld-icon-side" />
    </g>
  );
  return (
    <g className="np-ld-icon server">
      <rect x={-14} y={-20} width={28} height={40} rx={3} className="np-ld-icon-top" />
      <path d="M-8 -10 h16 M-8 -2 h16 M-8 6 h16" className="np-ld-icon-mark" />
    </g>
  );
};

