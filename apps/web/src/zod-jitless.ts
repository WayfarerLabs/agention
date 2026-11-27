import { z } from "zod";

// Zod compiles a fast path for its object schemas with new Function when it
// may. The app's content security policy refuses that, and Zod catches the
// refusal, but the browser still reports each attempt as a policy violation.
// Jitless keeps Zod from trying. Zod decides, and probes, when a module builds
// an object schema, and the API package builds its schemas as it loads, so
// main.tsx imports this module before any other.
z.config({ jitless: true });
