import { startDashboard } from "./dashboard.js";
const port = parseInt(process.env.PORT || "3000");
const projectDir = process.env.PROJECT_DIR || process.cwd();
startDashboard(projectDir, port);
