import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class StudioErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Studio render failed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="studio-shell">
          <section className="load-state">
            <strong>Studio failed to render</strong>
            <p>{this.state.error.message}</p>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <StudioErrorBoundary>
      <App />
    </StudioErrorBoundary>
  </StrictMode>
);
