import type { NotificationsState, PushDevice } from "@wayfarerlabs/agention-api";
import { useEffect, useId, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, Loadable, Tags } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { type DeviceNotifications, useDeviceNotifications } from "../../device.ts";
import { Time } from "../../format.tsx";
import { loadNotifications, pushSupported, turnOff, turnOn } from "../../push/subscription.ts";
import { Link } from "../../router.tsx";
import { needingRecent, RecentSignIn } from "./RecentSignIn.tsx";
import type { SectionProps } from "./sections.ts";

// Settings' notifications: this device's switch and its state, and every
// device that receives notifications, each removable. Turning this device on
// asks the browser's permission, from the tap, and needs a recent sign-in,
// as removing another device does; turning it off needs none. Which saved
// views notify is set in Settings' Saved views, which this section points
// to.

// What a stopped device's state says of why.
const stoppedWhy = {
  dropped: "This browser no longer holds this device's notifications.",
  removed: "Another device removed this one, or its push service ended it.",
} as const;

// stateOf words this device's state: on, off, stopped and why, or blocked by
// the browser, which no tap here can undo.
function stateOf(kept: DeviceNotifications, blocked: boolean): string {
  if (kept.state === "on") {
    return "On";
  }
  if (kept.state === "stopped") {
    return `Stopped. ${stoppedWhy[kept.why]} Turn them on again to receive them.`;
  }
  return blocked ? "Blocked by the browser" : "Off";
}

// useBlocked says whether the browser blocks this origin's notifications,
// following a change made in its site settings, from the Permissions API
// where the browser has it, which also answers in headless Chromium, whose
// Notification.permission says denied whatever was granted.
function useBlocked(): boolean {
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const follow = () => setBlocked(status?.state === "denied");
    if (navigator.permissions === undefined) {
      setBlocked(Notification.permission === "denied");
      return undefined;
    }
    navigator.permissions.query({ name: "notifications" }).then(
      (found) => {
        status = found;
        follow();
        status.addEventListener("change", follow);
      },
      () => setBlocked(Notification.permission === "denied"),
    );
    return () => status?.removeEventListener("change", follow);
  }, []);
  return blocked;
}

export function NotificationsSection({ focusHeading }: SectionProps) {
  const state = useResource(loadNotifications);
  const recentHint = useId();
  return (
    <>
      <p>
        Agention can notify your devices when an agent writes in a thread that a saved view which
        notifies keeps: once, until you read or archive the thread. A notification shows the
        thread&apos;s title and why it needs you, never what a message says.
      </p>
      <RecentSignIn
        recent={state.data?.recent}
        need="Turning on this device's notifications, or removing another device"
        hint={recentHint}
        refresh={state.refresh}
        focusHeading={focusHeading}
      />
      <Loadable data={state.data} failure={state.failure} retry={state.refresh}>
        {(data) => (
          <Devices
            data={data}
            refresh={state.refresh}
            recentHint={recentHint}
            focusHeading={focusHeading}
          />
        )}
      </Loadable>
      <p className="hint">
        Which saved views notify is set in <Link to="/settings/saved-views">Saved views</Link>, with
        the Notify switch on each.
      </p>
    </>
  );
}

// Devices is this device's switch and the list of every device.
function Devices({
  data,
  refresh,
  recentHint,
  focusHeading,
}: {
  data: NotificationsState;
  refresh: () => void;
  recentHint: string;
  focusHeading: () => void;
}) {
  return (
    <>
      {pushSupported() ? (
        <ThisDevice data={data} refresh={refresh} recentHint={recentHint} />
      ) : (
        <div className="notice">
          <p>
            This browser cannot receive notifications. On an iPhone or iPad, add Agention to the
            Home Screen and open it from there.
          </p>
        </div>
      )}
      <h3>Devices</h3>
      {data.devices.length === 0 ? (
        <p className="empty">No device receives notifications.</p>
      ) : (
        <ul className="push-devices">
          {data.devices.map((device) => (
            <DeviceItem
              key={device.id}
              device={device}
              recent={data.recent}
              recentHint={recentHint}
              refresh={refresh}
              onRemoved={focusHeading}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// ThisDevice is this device's switch, with its state.
function ThisDevice({
  data,
  refresh,
  recentHint,
}: {
  data: NotificationsState;
  refresh: () => void;
  recentHint: string;
}) {
  const id = useId();
  const kept = useDeviceNotifications();
  const blocked = useBlocked();
  const action = useAction();
  const on = kept.state === "on";
  // Turning on needs a recent sign-in; turning off never does.
  const held = !on && !data.recent;
  const current = data.devices.find((device) => device.current);
  const change = async (next: boolean) => {
    await action.run((csrf) =>
      next
        ? needingRecent(turnOn(data.public_key, csrf), refresh)
        : turnOff(current, csrf).then(() => current),
    );
    refresh();
  };
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={held || action.pending}
          aria-describedby={held ? `${id}-state ${recentHint}` : `${id}-state`}
          onChange={(event) => void change(event.target.checked)}
        />
        Notifications on this device
      </label>
      <p className="hint" id={`${id}-state`}>
        {stateOf(kept, blocked)}
      </p>
      <Failure failure={action.failure} />
    </>
  );
}

// DeviceItem is one device in the list: its label, when it was turned on and
// last received a notification, and Remove. Removing this device is turning
// it off; removing another needs a recent sign-in. Once it is removed, its
// controls gone with it, focus goes to the section's heading.
function DeviceItem({
  device,
  recent,
  recentHint,
  refresh,
  onRemoved,
}: {
  device: PushDevice;
  recent: boolean;
  recentHint: string;
  refresh: () => void;
  onRemoved: () => void;
}) {
  const action = useAction();
  const held = !device.current && !recent;
  const remove = async () => {
    const done = await action.run((csrf) =>
      device.current
        ? turnOff(device, csrf).then(() => device)
        : needingRecent(
            request("POST", `/notifications/devices/${device.id}/remove`, { csrf }),
            refresh,
          ),
    );
    refresh();
    if (done !== undefined) {
      onRemoved();
    }
  };
  return (
    <li>
      <article className="push-device" aria-label={`Device ${device.label}`}>
        <h4>{device.label}</h4>
        <p className="where">
          Turned on <Time value={device.created_at} />
          {" · "}
          {device.accepted_at === undefined ? (
            "nothing sent yet"
          ) : (
            <>
              last sent <Time value={device.accepted_at} />
            </>
          )}
        </p>
        {device.current && <Tags tags={[{ label: "This device" }]} />}
        <div className="actions">
          <ConfirmButton
            label="Remove"
            confirmLabel="Remove this device"
            question={
              device.current
                ? "Turn off notifications on this device?"
                : `Stop notifying ${device.label}? Turning it on again needs that device.`
            }
            disabled={held || action.pending}
            describedBy={held ? recentHint : undefined}
            onConfirm={() => void remove()}
          />
        </div>
        <Failure failure={action.failure} />
      </article>
    </li>
  );
}
