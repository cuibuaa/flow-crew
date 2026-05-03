import { useRef, useEffect, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

export interface TerminalHandle {
  send: (data: string) => void;
  sendJson: (obj: unknown) => void;
}

interface TerminalProps {
  wsUrl?: string;
  staticContent?: string;
  className?: string;
  interactive?: boolean;
  onReady?: () => void;
  onPlanReady?: () => void;
  onBriefNotReady?: (message?: string) => void;
}

function sendBinary(ws: WebSocket, tag: number, data: string) {
  const encoded = new TextEncoder().encode(data);
  const payload = new Uint8Array(1 + encoded.length);
  payload[0] = tag;
  payload.set(encoded, 1);
  ws.send(payload);
}

const Terminal = forwardRef<TerminalHandle, TerminalProps>(({ wsUrl, staticContent, className, interactive, onReady, onPlanReady, onBriefNotReady }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useImperativeHandle(ref, () => ({
    send: (data: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendBinary(wsRef.current, 0x00, data);
      }
    },
    sendJson: (obj: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendBinary(wsRef.current, 0x01, JSON.stringify(obj));
      }
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: { background: "#0d1117", foreground: "#e0e0e0", cursor: "#667eea" },
      fontSize: 13,
      fontFamily: "Fira Code, JetBrains Mono, Menlo, monospace",
      disableStdin: !interactive,
      cursorBlink: !!interactive,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;

    if (staticContent) term.write(staticContent);

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    if (wsUrl) {
      let reconnectAttempts = 0;
      const maxReconnectAttempts = 5;

      if (interactive) {
        // Debounce rapid input (e.g. multiple quick pastes) into single bracketed paste
        let inputBuf = '';
        let inputTimer: ReturnType<typeof setTimeout> | null = null;

        function flushInput() {
          const ws = wsRef.current;
          if (!inputBuf || !ws || ws.readyState !== WebSocket.OPEN) { inputBuf = ''; return; }
          const data = inputBuf;
          inputBuf = '';
          if (data.length > 3 && !data.startsWith('\x1b[200~')) {
            sendBinary(ws, 0x00, '\x1b[200~' + data + '\x1b[201~');
          } else {
            sendBinary(ws, 0x00, data);
          }
        }

        term.onData((data) => {
          const ws = wsRef.current;
          if (data.length <= 1 || data.startsWith('\x1b')) {
            if (inputBuf) flushInput();
            if (ws && ws.readyState === WebSocket.OPEN) sendBinary(ws, 0x00, data);
            return;
          }
          inputBuf += data;
          if (inputTimer) clearTimeout(inputTimer);
          inputTimer = setTimeout(flushInput, 50);
        });

        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'v' && e.type === 'keydown') {
            if (inputBuf) flushInput();
            navigator.clipboard.readText().then((text) => {
              const ws = wsRef.current;
              if (text && ws && ws.readyState === WebSocket.OPEN) {
                sendBinary(ws, 0x00, '\x1b[200~' + text + '\x1b[201~');
              }
            }).catch(() => {});
            return false;
          }
          return true;
        });
      }

      term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendBinary(ws, 0x01, JSON.stringify({ type: "resize", cols: Math.max(90, Math.min(cols, 200)), rows: Math.min(rows, 60) }));
        }
      });

      function connectWs() {
        const ws = new WebSocket(wsUrl!);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttempts = 0;
          const dims = { type: "resize", cols: Math.max(90, Math.min(term.cols, 200)), rows: Math.min(term.rows, 60) };
          sendBinary(ws, 0x01, JSON.stringify(dims));
          onReady?.();
        };

        ws.onclose = () => {
          if (reconnectAttempts < maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
            reconnectAttempts++;
            term.write(`\r\n\x1b[33m[disconnected — reconnecting in ${Math.round(delay / 1000)}s…]\x1b[0m\r\n`);
            reconnectTimer = setTimeout(connectWs, delay);
          } else {
            term.write("\r\n\x1b[31m[connection lost — refresh the page to reconnect]\x1b[0m\r\n");
          }
        };

        ws.onmessage = (e) => {
          const buf = new Uint8Array(e.data as ArrayBuffer);
          if (buf.length === 0) return;
          if (buf[0] === 0x00) {
            term.write(buf.slice(1));
          } else if (buf[0] === 0x01) {
            try {
              const parsed = JSON.parse(new TextDecoder().decode(buf.slice(1)));
              if (parsed.type === "done") {
                term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
              } else if (parsed.type === "plan_ready") {
                term.write("\r\n\x1b[32m[task_brief.md written — moving to plan review]\x1b[0m\r\n");
                onPlanReady?.();
              } else if (parsed.type === "brief_not_ready") {
                const message = typeof parsed.message === "string" && parsed.message.trim()
                  ? parsed.message
                  : "No confirmed task brief was produced. Clarify the scope in Discussion, confirm it, then generate the plan again.";
                term.write(`\r\n\x1b[33m[brief not ready: ${message}]\x1b[0m\r\n`);
                onBriefNotReady?.(message);
              } else if (parsed.type === "error") {
                term.write(`\r\n\x1b[31m[error: ${parsed.message}]\x1b[0m\r\n`);
              }
            } catch { /* malformed control */ }
          } else {
            term.write(buf);
          }
        };
      }

      connectWs();
    }

    const onResize = () => {
      fit.fit();
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      term.dispose();
    };
  }, [wsUrl, staticContent, interactive]);

  return <div ref={containerRef} className={`${className ?? "h-full w-full"} pb-6`} />;
});

Terminal.displayName = "Terminal";
export default Terminal;
