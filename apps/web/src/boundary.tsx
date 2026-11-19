import { Component, type ReactNode } from "react";

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
