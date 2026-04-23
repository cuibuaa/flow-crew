import { useTasks } from "./Layout";
import Dashboard from "./Dashboard";

export default function TaskBoard() {
  const tasks = useTasks();
  return <Dashboard tasks={tasks} />;
}
