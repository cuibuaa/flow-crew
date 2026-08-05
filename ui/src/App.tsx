import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation } from "react-router-dom";
import AgentsView from "./components/AgentsView";
import Inbox from "./components/Inbox";
import RunDetail from "./components/RunDetail";
import SettingsView from "./components/SettingsView";
import ToastContainer from "./components/Toast";
import Workspaces from "./components/Workspaces";
import DashboardFreshnessBanner from "./components/DashboardFreshnessBanner";

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

export function AppRoutes() {
  return (
    <>
      <ToastContainer />
      <DashboardFreshnessBanner />
      <Routes>
        <Route path="/" element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<><TopbarOnly /><main className="main full-main"><Inbox /></main></>} />
        <Route path="/campaign" element={<Workspaces />} />
        <Route path="/campaign/:id" element={<Workspaces />} />
        <Route path="/campaign/:campaignId/run/:id" element={<><TopbarOnly /><main className="main run-main"><RunDetail /></main></>} />
        <Route path="/run/:id" element={<><TopbarOnly /><main className="main run-main"><RunDetail /></main></>} />
        <Route path="/agents" element={<><TopbarOnly /><main className="main full-main"><AgentsView /></main></>} />
        <Route path="/settings" element={<><TopbarOnly /><main className="main full-main"><SettingsView /></main></>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </>
  );
}

function NotFound() {
  const location = useLocation();
  return (
    <>
      <TopbarOnly />
      <main className="main full-main not-found-page" data-testid="not-found-page">
        <div className="section">
          <div className="eyebrow">404 · PAGE NOT FOUND</div>
          <h1>This dashboard page is unavailable</h1>
          <p>The requested route is not implemented: <code>{location.pathname}</code></p>
          <div className="not-found-links">
            <Link className="btn" to="/inbox">Open Inbox</Link>
            <Link className="btn ghost" to="/campaign">Open Workspaces</Link>
          </div>
        </div>
      </main>
    </>
  );
}

export function TopbarOnly() {
  return (
    <div className="topbar">
      <div className="brand">FlowCrew</div>
      <div className="tabs">
        <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/inbox">Inbox</NavLink>
        <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/campaign">Workspaces</NavLink>
        <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/agents">Agents</NavLink>
        <NavLink className={({ isActive }) => `tab ${isActive ? "active" : ""}`} to="/settings">Settings</NavLink>
      </div>
    </div>
  );
}
