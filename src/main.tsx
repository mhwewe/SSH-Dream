// main.tsx — React entry. (No StrictMode on purpose: it double-runs effects in dev and would
// register the Tauri event listeners twice.)
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initTheme } from "./store/theme";
import "./styles.css";
import "./ssh.css";   // Handoff 2: terminal tab + host-key / password dialogs
import "./sftp.css";  // Handoff 3: SFTP tab, file table, transfer queue

initTheme(); // sets <html data-theme> before the first paint (no flash of the wrong colours)

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
