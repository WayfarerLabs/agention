import { openThreadMessage } from "@wayfarerlabs/agention-api";
import { navigate } from "../router.tsx";
import { threadHref } from "../routes.ts";

// listenForOpenThread has the page open the thread the service worker names
// when the operator opens a notification and the worker picks this window,
// as any navigation opens it. It runs as the page starts, before the shell
// picks a view, so every route of the UI hears it, the sign-in page and a
// page still loading included; signed out, the shell sends the thread's route
// to sign-in, which comes back to it. Only this origin's own service worker
// posts to the page, and a message of any other shape is ignored.
export function listenForOpenThread(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const message = openThreadMessage.safeParse(event.data);
    if (message.success) {
      const { agent, session, thread } = message.data;
      navigate(threadHref(agent, session, thread));
    }
  });
  navigator.serviceWorker.startMessages();
}
