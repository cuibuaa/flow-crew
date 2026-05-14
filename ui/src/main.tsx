import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "xterm/css/xterm.css";
import "./index.css";

class AppErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    // eslint-disable-next-line no-console
    console.error("App rendering error:", err, "\nComponentStack:", info.componentStack);
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "#f85149" }}>
          <h2>Something went wrong rendering this page.</h2>
          <p style={{ color: "#e1e4e8" }}>Open DevTools → Console for the full stack, or reload.</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#8b949e", fontSize: 12 }}>{String(this.state.err.message)}</pre>
          <button onClick={() => this.setState({ err: null })} style={{ marginTop: 12, padding: "6px 12px" }}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
