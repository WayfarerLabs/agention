import { Component, type ReactNode } from "react";
import { PageHeading } from "./components.tsx";

// ErrorBoundary shows fallback in place of children that fail to render, so
// one part of the page that cannot be shown leaves the rest standing.
export class ErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// PageFailed stands in for a page, or a pane of one, that failed to render.
export function PageFailed() {
  return (
    <>
      <PageHeading>Something went wrong</PageHeading>
      <p>Agention could not show this page.</p>
      <div className="actions">
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </>
  );
}
