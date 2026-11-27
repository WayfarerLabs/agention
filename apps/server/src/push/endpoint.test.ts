import { expect, it } from "vitest";
import { endpointProblem } from "./endpoint.ts";

// Each endpoint, accepted or refused. Only whether a problem is found is
// checked, never its words.
const cases: [string, boolean][] = [
  ["https://fcm.googleapis.com/fcm/send/cX1:APA91bH", true],
  ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk", true],
  ["https://web.push.apple.com/QGuQyavXutnMEbF", true],
  ["https://push.apple.com/QGuQ", true],
  ["https://wns2-par02p.notify.windows.com/w/?token=BQYAAA", true],
  ["https://FCM.googleapis.com/fcm/send/x", true],
  ["https://fcm.googleapis.com:443/fcm/send/x", true],
  // Refused: another scheme, port, user information, or host.
  ["http://fcm.googleapis.com/fcm/send/x", false],
  ["https://fcm.googleapis.com:8443/fcm/send/x", false],
  ["https://user:pass@fcm.googleapis.com/fcm/send/x", false],
  ["https://user@fcm.googleapis.com/fcm/send/x", false],
  ["https://fcm.googleapis.com./fcm/send/x", false],
  ["https://fcm.googleapis.com.evil.test/fcm/send/x", false],
  ["https://evilpush.apple.com/x", false],
  ["https://notify.windows.com/x", false],
  ["https://.notify.windows.com/x", false],
  ["https://evil.test/push.apple.com", false],
  ["https://127.0.0.1/x", false],
  ["https://[::1]/x", false],
  ["https://169.254.169.254/latest", false],
  ["fcm.googleapis.com/fcm/send/x", false],
  ["/fcm/send/x", false],
  [`https://fcm.googleapis.com/${"x".repeat(2048)}`, false],
  // Short enough as given, but not once its spaces are percent-encoded.
  [`https://fcm.googleapis.com/${"x y".repeat(500)}`, false],
];

it.each(cases)("judges %s", (endpoint, accepted) => {
  expect(endpointProblem(endpoint) === undefined).toBe(accepted);
});
