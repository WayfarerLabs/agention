import {
  genericStrict,
  type HarnessClient,
  type Key,
  type NudgeOutcome,
  type NudgeTexts,
  type Observation,
  type Pane,
  PaneObserver,
  PaneUnusable,
  type Profile,
  profileNames,
  selectProfile,
  type Snapshot,
  type StoppedBy,
  TmuxPane,
} from "@wayfarerlabs/agention-harness-observer";
import {
  formatTimestamp,
  type MonitorCondition,
  type MonitorReport,
  quoted,
  timestamp,
} from "@wayfarerlabs/agention-api";
import { notReady } from "./nudge.ts";

// Monitoring's side in the bridge: what its configuration names, the reports
// the reporter sends of what the harness observer reads from the session's
// tmux pane, and the nudges it asks the observer for. Nothing read from the
// pane leaves here but the condition, the reason it stopped, their times and
// whether the session can be nudged; the log names the problem with the pane,
// never what it shows.

// Writes one line to the bridge's log, its standard error.
export type Log = (line: string) => void;

// The variables monitoring reads. The bridge never reads TMUX or TMUX_PANE:
// the pane is named, never guessed from the tmux the host happens to run in.
export interface MonitoringEnvironment {
  AGENTION_TMUX_SOCKET?: string | undefined;
  AGENTION_HARNESS_PROFILE?: string | undefined;
  AGENTION_NUDGE?: string | undefined;
}

// The command line's monitoring options, which win over their variables.
export interface MonitoringOptions {
  tmuxSocket?: string | undefined;
  harnessProfile?: string | undefined;
  nudge?: string | undefined;
}

// The configuration monitoring runs with: the tmux server's socket, if any;
// the profile name, "auto" unless one is configured; and the nudge type, if
// any, without which the nudge is off.
export interface MonitoringSettings {
  tmuxSocket: string | undefined;
  harnessProfile: string;
  nudge: string | undefined;
}

// monitoringSettings reads the options, else their variables. An empty value
// counts as unset, as it does for the bridge's other settings.
export function monitoringSettings(
  options: MonitoringOptions,
  environment: MonitoringEnvironment,
): MonitoringSettings {
  const given = (option: string | undefined, variable: string | undefined) =>
    option !== undefined && option !== "" ? option : variable !== "" ? variable : undefined;
  return {
    tmuxSocket: given(options.tmuxSocket, environment.AGENTION_TMUX_SOCKET),
    harnessProfile:
      given(options.harnessProfile, environment.AGENTION_HARNESS_PROFILE) ?? autoProfile,
    nudge: given(options.nudge, environment.AGENTION_NUDGE),
  };
}

const autoProfile = "auto";

// The nudge types the bridge knows: tmux, which types into the pane it
// monitors. Others, such as a nudge through a host's SDK, may follow.
export const nudgeTypes: readonly string[] = ["tmux"];

// A source of the reports the bridge sends while it acts for its session,
// each yielded report replacing the one before, and of the nudges it tries.
// None of its methods throws.
export interface Monitor {
  reports(signal: AbortSignal): AsyncIterable<MonitorReport>;
  // canNudge says whether the session can be nudged now: the nudge is on,
  // the pane can be read and runs the harness, and the profile can tell when
  // it is at its prompt, as every profile the observer has can, the generic
  // ones included.
  canNudge(): Promise<boolean>;
  // nudge has the observer nudge the agent with the texts given, while the
  // reports are being read; otherwise, or with the nudge off, it puts
  // nothing in the pane and answers not-ready.
  nudge(texts: NudgeTexts): Promise<NudgeOutcome>;
}

// What reads a pane through a profile and nudges at it: the harness
// observer.
export type NudgingObserver = Pick<PaneObserver, "observations" | "nudge">;

export interface PaneMonitorOptions {
  settings: MonitoringSettings;
  // The harness the bridge runs under, as its MCP client named itself, once
  // it has initialized.
  client: () => HarnessClient | undefined;
  log: Log;
  // The pane at a socket path; a TmuxPane of this session's own unless a
  // test gives another.
  pane?: ((socket: string) => Pane) | undefined;
  // The observer of a pane through a profile; a PaneObserver unless a test
  // gives another.
  observer?: ((pane: Pane, profile: Profile) => NudgingObserver) | undefined;
}

// sessionPane is the pane at a socket path, read only while its first
// process is an ancestor of this bridge: the harness that started it, or
// whatever started that harness. A socket that names any other pane, such as
// another session's, is refused rather than read.
function sessionPane(socket: string): Pane {
  return new TmuxPane(socket, { requireAncestorOf: process.pid });
}

// createMonitor makes the monitor the configuration asks for. Without a
// socket it reports that it monitors no pane. With one it reads the pane
// through the configured profile, which "auto" chooses from the MCP client
// once monitoring first starts, since the client names itself only once it
// has initialized. A profile name the observer does not know is logged now,
// once, and the strict generic profile reads the pane instead, as
// selectProfile chooses for such a name. The nudge is on only with a nudge
// type the bridge knows and a socket; a type it does not know, or the tmux
// type without a socket, is logged now, once, and leaves the nudge off.
export function createMonitor(options: PaneMonitorOptions): Monitor {
  const { settings, log } = options;
  const name = settings.harnessProfile;
  if (name !== autoProfile && !profileNames.includes(name)) {
    log(
      `the harness profile ${quoted(name)} is none of ` +
        `${[autoProfile, ...profileNames].join(", ")}, so monitoring reads the pane with ` +
        genericStrict.name,
    );
  }
  const socket = settings.tmuxSocket;
  const nudgeOn = nudgeConfigured(settings, log);
  if (socket === undefined) {
    return {
      reports: unmonitored,
      canNudge: () => Promise.resolve(false),
      nudge: () => Promise.resolve(notReady),
    };
  }
  const pane = new LoggedPane((options.pane ?? sessionPane)(socket), log);
  // The harness observer's nudge carries out every check of the session's
  // readiness and of each text it puts in the pane.
  const observe = options.observer ?? ((watched, read) => new PaneObserver(watched, read));
  let profile: Profile | undefined;
  // The observer while the reports are being read, which nudges.
  let observer: NudgingObserver | undefined;
  return {
    async *reports(signal) {
      profile ??= selectProfile(name, options.client());
      const watching = observe(pane, profile);
      observer = watching;
      try {
        for await (const observation of watching.observations(signal)) {
          yield reportOf(profile.name, observation, nudgeOn);
        }
      } finally {
        if (observer === watching) {
          observer = undefined;
        }
      }
    },
    async canNudge() {
      if (!nudgeOn) {
        return false;
      }
      try {
        const snapshot = await pane.snapshot();
        return snapshot.onePane && snapshot.hostHasTerminal;
      } catch {
        return false;
      }
    },
    nudge(texts) {
      return nudgeOn && observer !== undefined ? observer.nudge(texts) : Promise.resolve(notReady);
    },
  };
}

// nudgeConfigured says whether the nudge is on: a nudge type the bridge
// knows, and the socket of the pane it types into. Anything else is logged,
// once, and leaves it off.
function nudgeConfigured(settings: MonitoringSettings, log: Log): boolean {
  const { nudge, tmuxSocket } = settings;
  if (nudge === undefined) {
    return false;
  }
  if (!nudgeTypes.includes(nudge)) {
    log(`the nudge type ${quoted(nudge)} is none of ${nudgeTypes.join(", ")}, so the nudge is off`);
    return false;
  }
  if (tmuxSocket === undefined) {
    log(
      "the tmux nudge needs the tmux server's socket, which --tmux-socket or " +
        "AGENTION_TMUX_SOCKET gives, so the nudge is off",
    );
    return false;
  }
  return true;
}

async function* unmonitored(signal: AbortSignal): AsyncIterable<MonitorReport> {
  yield { monitored: false };
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
}

// reportOf is the report of an observation: the profile's name, the
// condition, since when, what stopped the harness, and whether the session
// can be nudged: with the nudge on, whenever the pane reads as anything but
// unknown. A reset time the agent API would not take, which a profile reads
// from the screen, is left out rather than failing the report.
export function reportOf(
  profile: string,
  observation: Observation,
  nudgeOn: boolean,
): MonitorReport {
  const { stoppedBy } = observation;
  const condition = conditionOf(observation);
  return {
    monitored: true,
    profile,
    condition,
    since: formatTimestamp(observation.since.getTime()),
    ...(stoppedBy && { stopped_by: stoppedByOf(stoppedBy) }),
    nudge: nudgeOn && condition !== "unknown",
  };
}

// conditionOf spells an observation's activity and screen as the agent API's
// one condition. The stopped-by reason goes beside it, so a reason with a
// prompt reads as stopped for that reason with the prompt on screen, and a
// prompt without one as stopped on it.
function conditionOf(observation: Observation): MonitorCondition {
  return observation.activity === "at_rest"
    ? conditionAtRest[observation.screen ?? "other"]
    : observation.activity;
}

// At rest, the screen names the condition: its prompt is at_prompt, and a
// screen the profile does not recognize is waiting.
const conditionAtRest: Record<NonNullable<Observation["screen"]>, MonitorCondition> = {
  input: "at_prompt",
  permission_prompt: "permission_prompt",
  other_prompt: "other_prompt",
  other: "waiting",
};

function stoppedByOf(
  stoppedBy: StoppedBy,
): NonNullable<Extract<MonitorReport, { monitored: true }>["stopped_by"]> {
  if (stoppedBy.reason !== "usage_limit") {
    return { reason: stoppedBy.reason };
  }
  const resetsAt = stoppedBy.resetsAt?.getTime();
  const written =
    resetsAt !== undefined && Number.isFinite(resetsAt) ? formatTimestamp(resetsAt) : undefined;
  return {
    reason: "usage_limit",
    ...(written !== undefined && timestamp.safeParse(written).success && { resets_at: written }),
  };
}

// LoggedPane logs why the pane cannot be read, once each time that starts:
// a failure to read it at all, a machine or a tmux monitoring cannot use, a
// pane that is not this session's, a terminal server holding more than one
// pane, or a harness that does not hold the terminal. The observer reads each
// as unknown. A reading that finds the pane as it should be ends the stretch,
// so a later problem is logged again.
type PaneProblem = "unreadable" | PaneUnusable["reason"] | "panes" | "terminal";

const unknown = "so the session's condition is unknown";

class LoggedPane implements Pane {
  readonly #pane: Pane;
  readonly #log: Log;
  #problem: PaneProblem | undefined;

  constructor(pane: Pane, log: Log) {
    this.#pane = pane;
    this.#log = log;
  }

  async snapshot(): Promise<Snapshot> {
    let snapshot: Snapshot;
    try {
      snapshot = await this.#pane.snapshot();
    } catch (error) {
      // TmuxPane's errors name the socket, processes and what tmux said,
      // never the screen.
      const { message } = error as Error;
      if (!(error instanceof PaneUnusable)) {
        this.#note("unreadable", `monitoring cannot read the tmux pane, ${unknown}: ${message}`);
      } else if (error.reason === "no-proc") {
        this.#note("no-proc", `monitoring finds no /proc (monitoring needs Linux), ${unknown}`);
      } else if (error.reason === "old-tmux") {
        this.#note("old-tmux", `monitoring needs tmux 3.3 or later, ${unknown}: ${message}`);
      } else {
        this.#note(
          "not-ancestor",
          `the tmux socket is not this session's, since its pane does not run this bridge, ` +
            `${unknown}: ${message}`,
        );
      }
      throw error;
    }
    if (!snapshot.onePane) {
      this.#note("panes", `monitoring finds more than one pane in the tmux server, ${unknown}`);
    } else if (!snapshot.hostHasTerminal) {
      this.#note(
        "terminal",
        `monitoring finds the pane's first process not holding its terminal, ${unknown}`,
      );
    } else {
      this.#problem = undefined;
    }
    return snapshot;
  }

  // paste and key pass to the pane, logging nothing: the nudge's observer
  // reports how a nudge ended, and its texts never reach the log.
  paste(line: string): Promise<void> {
    return this.#pane.paste(line);
  }

  key(key: Key): Promise<void> {
    return this.#pane.key(key);
  }

  #note(problem: PaneProblem, line: string): void {
    if (this.#problem !== problem) {
      this.#problem = problem;
      this.#log(line);
    }
  }
}

// The longest name and version taken from an MCP client.
const maxClientName = 100;
const maxClientVersion = 50;

// harnessClient takes the name and version an MCP client gave in its
// initialize request, which is outside input, for choosing a profile: only
// strings of a bounded length, else none.
export function harnessClient(info: unknown): HarnessClient | undefined {
  const { name, version } = (info ?? {}) as { name?: unknown; version?: unknown };
  if (
    typeof name !== "string" ||
    typeof version !== "string" ||
    name.length > maxClientName ||
    version.length > maxClientVersion
  ) {
    return undefined;
  }
  return { name, version };
}
