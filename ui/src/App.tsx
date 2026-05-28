import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AgentsView from "./components/AgentsView";
import RunDetail from "./components/RunDetail";
import SettingsView from "./components/SettingsView";
import ToastContainer from "./components/Toast";
import Workspaces from "./components/Workspaces";

export default function App() {
  return (
    <BrowserRouter>
      <ToastContainer />
      <Routes>
        <Route path="/" element={<Workspaces />} />
        <Route path="/campaign" element={<Workspaces />} />
        <Route path="/campaign/:id" element={<Workspaces />} />
        <Route path="/campaign/:campaignId/run/:id" element={<><TopbarOnly /><main className="main run-main"><RunDetail /></main></>} />
        <Route path="/run/:id" element={<><TopbarOnly /><main className="main run-main"><RunDetail /></main></>} />
        <Route path="/agents" element={<><TopbarOnly /><main className="main full-main"><AgentsView /></main></>} />
        <Route path="/settings" element={<><TopbarOnly /><main className="main full-main"><SettingsView /></main></>} />
        <Route path="/task/:id/monitor" element={<Navigate to="/campaign" replace />} />
        <Route path="/task/:id/plan" element={<Navigate to="/campaign" replace />} />
        <Route path="/task/:id/knowledge-graph" element={<Navigate to="/campaign" replace />} />
        <Route path="/import" element={<Navigate to="/campaign" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function TopbarOnly() {
  return (
    <div className="topbar">
      <div className="brand">FlowCrew</div>
      <div className="tabs">
        <a className="tab" href="/campaign">Workspaces</a>
        <a className="tab" href="/agents">Agents</a>
        <a className="tab" href="/settings">Settings</a>
      </div>
    </div>
  );
}
