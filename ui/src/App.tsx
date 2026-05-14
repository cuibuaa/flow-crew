import { BrowserRouter, Routes, Route, useParams } from "react-router-dom";
import Layout from "./components/Layout";
import ToastContainer from "./components/Toast";
import TaskBoard from "./components/TaskBoard";
import TaskDiscussion from "./components/TaskDiscussion";
import PlanReview from "./components/PlanReview";
import LiveMonitor from "./components/LiveMonitor";
import StageDetail from "./components/StageDetail";
import AgentManagement from "./components/AgentManagement";
import Settings from "./components/Settings";
import ImportBrief from "./components/ImportBrief";
import KnowledgeGraph from "./components/KnowledgeGraph";

function KnowledgeGraphRoute() {
  const { id } = useParams();
  if (!id) return null;
  return <KnowledgeGraph taskId={id} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastContainer />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<TaskBoard />} />
          <Route path="/import" element={<ImportBrief />} />
          <Route path="/task/:id/discuss" element={<TaskDiscussion />} />
          <Route path="/task/:id/plan" element={<PlanReview />} />
          <Route path="/task/:id/monitor" element={<LiveMonitor />} />
          <Route path="/task/:id/knowledge-graph" element={<KnowledgeGraphRoute />} />
          <Route path="/task/:id/stage/:stageId" element={<StageDetail />} />
          <Route path="/agents" element={<AgentManagement />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
