import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        "lg-wide": "1200px",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["Fira Code", "JetBrains Mono", "Menlo", "monospace"],
      },
      colors: {
        rc: {
          bg: "#1a1a2e",
          card: "#16213e",
          hover: "#0f3460",
          border: "#2a2a4a",
          "border-hover": "#3a3a5a",
          text: "#e0e0e0",
          "text-secondary": "#a0a0b0",
          muted: "#666680",
          accent: "#667eea",
          success: "#4ade80",
          error: "#f87171",
          warning: "#fbbf24",
          code: "#0d1117",
        },
      },
      borderRadius: {
        card: "12px",
        btn: "8px",
        input: "6px",
      },
      boxShadow: {
        glow: "0 4px 20px rgba(102, 126, 234, 0.1)",
      },
    },
  },
  plugins: [typography],
} satisfies Config;
