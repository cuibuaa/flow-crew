import { startDashboard } from "./dashboard.js";

// Prevent server crash on non-fatal errors (e.g., ERR_HTTP_HEADERS_SENT from SSE streams)
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ERR_HTTP_HEADERS_SENT') {
    console.error('[non-fatal] Headers already sent — ignoring:', err.message);
    return;
  }
  console.error('[fatal] Uncaught exception:', err);
  process.exit(1);
});

const port = parseInt(process.env.PORT || "3000");
const projectDir = process.env.PROJECT_DIR || process.cwd();
startDashboard(projectDir, port);
