import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import TaskBoard from "./components/TaskBoard";
import TaskDiscussion from "./components/TaskDiscussion";
import PlanReview from "./components/PlanReview";
import LiveMonitor from "./components/LiveMonitor";
import StageDetail from "./components/StageDetail";
import AgentManagement from "./components/AgentManagement";
import Settings from "./components/Settings";
import ImportBrief from "./components/ImportBrief";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<TaskBoard />} />
          <Route path="/import" element={<ImportBrief />} />
          <Route path="/task/:id/discuss" element={<TaskDiscussion />} />
          <Route path="/task/:id/plan" element={<PlanReview />} />
          <Route path="/task/:id/monitor" element={<LiveMonitor />} />
          <Route path="/task/:id/stage/:stageId" element={<StageDetail />} />
          <Route path="/agents" element={<AgentManagement />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
