import { startDashboard } from "./dashboard.js";
import pino from "pino";

const log = pino({ name: 'flowcrew' });

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ERR_HTTP_HEADERS_SENT') {
    log.warn({ err: err.message }, 'Non-fatal: headers already sent');
    return;
  }
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

const port = parseInt(process.env.PORT || "3000");
const projectDir = process.env.PROJECT_DIR || process.cwd();
startDashboard(projectDir, port);
