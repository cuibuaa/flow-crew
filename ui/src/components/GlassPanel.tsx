import type { ReactNode } from "react";

export default function GlassPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`glass-panel rounded-card p-4 ${className}`}>{children}</div>;
}
