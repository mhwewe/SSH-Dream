// components/ErrorBoundary.tsx — last line of defence: a crash while rendering shows a message + "Reload view"
// instead of a blank white window. The backend (SSH sessions, transfers) keeps running; "Reload view" only restarts the UI.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("UI crashed:", error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h2>Something went wrong in the window</h2>
        <p>Your SSH sessions and transfers are still running in the background. Reloading the view only restarts this screen.</p>
        <pre>{error.message}</pre>
        <div className="crash-buttons">
          <button onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="primary" onClick={() => window.location.reload()}>Reload view</button>
        </div>
      </div>
    );
  }
}
