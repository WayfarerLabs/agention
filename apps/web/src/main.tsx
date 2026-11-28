import "./zod-jitless.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { listenForOpenThread } from "./push/open-thread.ts";
import { registerServiceWorker } from "./push/subscription.ts";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html has no #root element");
}

// The service worker, for notifications, and the page's side of opening a
// notification's thread, which every route of the UI hears.
registerServiceWorker();
listenForOpenThread();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
