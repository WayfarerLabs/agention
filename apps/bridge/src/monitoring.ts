import {
  genericStrict,
  type HarnessClient,
  type Observation,
  type Pane,
  PaneObserver,
  type Profile,
  profiles,
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

// Monitoring's side in the bridge: what its configuration names, and the
// reports the reporter sends of what the harness observer reads from the
// session's tmux pane. Nothing read from the pane leaves here but the
// condition, the reason it stopped and their times; the log names the
// problem with the pane, never what it shows.

// Writes one line to the bridge's log, its standard error.
export type Log = (line: string) => void;

// The variables monitoring reads. The bridge never reads TMUX or TMUX_PANE:
// the pane is named, never guessed from the tmux the host happens to run in.
export interface MonitoringEnvironment {
  AGENTION_TMUX_SOCKET?: string | undefined;
  AGENTION_HARNESS_PROFILE?: string | undefined;
}

// The command line's monitoring options, which win over their variables.
export interface MonitoringOptions {
  tmuxSocket?: string | undefined;
  harnessProfile?: string | undefined;
}

// The configuration monitoring runs with: the tmux server's socket, if any,
// and the profile name, "auto" unless one is configured.
export interface MonitoringSettings {
  tmuxSocket: string | undefined;
  harnessProfile: string;
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
  };
}

const autoProfile = "auto";

// A source of the reports the bridge sends while it acts for its session:
// each yielded report replaces the one before. It never throws.
export interface Monitor {
  reports(signal: AbortSignal): AsyncIterable<MonitorReport>;
}

export interface PaneMonitorOptions {
  settings: MonitoringSettings;
  // The harness the bridge runs under, as its MCP client named itself, once
  // it has initialized.
  client: () => HarnessClient | undefined;
  log: Log;
  // The pane at a socket path; a TmuxPane unless a test gives another.
  pane?: ((socket: string) => Pane) | undefined;
}

// createMonitor makes the monitor the configuration asks for. Without a
// socket it reports that it monitors no pane. With one it reads the pane
// through the configured profile, which "auto" chooses from the MCP client
// once monitoring first starts, since the client names itself only once it
// has initialized. A profile name the registry does not know is logged now,
// once, and the strict generic profile reads the pane instead.
export function createMonitor(options: PaneMonitorOptions): Monitor {
  const { settings, log } = options;
  const known = profiles.select(settings.harnessProfile, undefined) !== undefined;
  if (!known) {
    log(
      `the harness profile ${quoted(settings.harnessProfile)} is none of ` +
        `${[autoProfile, ...profiles.names].join(", ")}, so monitoring reads the pane with ` +
        genericStrict.name,
    );
  }
  const socket = settings.tmuxSocket;
  if (socket === undefined) {
    return { reports: unmonitored };
  }
  const name = known ? settings.harnessProfile : genericStrict.name;
  const pane = new LoggedPane((options.pane ?? ((path) => new TmuxPane(path)))(socket), log);
  let profile: Profile | undefined;
  return {
    async *reports(signal) {
      profile ??= profiles.select(name, options.client()) ?? genericStrict;
      const observer = new PaneObserver(pane, profile);
      for await (const observation of observer.observations(signal)) {
        yield reportOf(profile.name, observation);
      }
    },
  };
}

async function* unmonitored(signal: AbortSignal): AsyncIterable<MonitorReport> {
  yield { monitored: false };
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
}

// The observer's conditions and reasons as the agent API spells them.
const conditions: Record<Observation["condition"], MonitorCondition> = {
  unknown: "unknown",
  "permission-prompt": "permission_prompt",
  "other-prompt": "other_prompt",
  running: "running",
  "at-prompt": "at_prompt",
  waiting: "waiting",
};

// reportOf is the report of an observation: the profile's name, the
// condition, since when, and what stopped the harness. A reset time the
// agent API would not take, which a profile reads from the screen, is left
// out rather than failing the report.
export function reportOf(profile: string, observation: Observation): MonitorReport {
  const { stoppedBy } = observation;
  return {
    monitored: true,
    profile,
    condition: conditions[observation.condition],
    since: formatTimestamp(observation.since.getTime()),
    ...(stoppedBy && { stopped_by: stoppedByOf(stoppedBy) }),
  };
}

function stoppedByOf(
  stoppedBy: StoppedBy,
): NonNullable<Extract<MonitorReport, { monitored: true }>["stopped_by"]> {
  if (stoppedBy.reason !== "usage-limit") {
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
// a failure to read it at all, a terminal server holding more than one pane,
// or a harness that does not hold the terminal. The observer reads each as
// unknown. A reading that finds the pane as it should be ends the stretch,
// so a later problem is logged again.
type PaneProblem = "unreadable" | "panes" | "terminal";

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
      // TmuxPane's errors name the socket and what tmux said, never the
      // screen.
      this.#note(
        "unreadable",
        `monitoring cannot read the tmux pane, so the session's condition is unknown: ` +
          (error as Error).message,
      );
      throw error;
    }
    if (!snapshot.onePane) {
      this.#note(
        "panes",
        "monitoring finds more than one pane in the tmux server, so the session's condition " +
          "is unknown",
      );
    } else if (!snapshot.hostHasTerminal) {
      this.#note(
        "terminal",
        "monitoring finds the pane's first process not holding its terminal, so the " +
          "session's condition is unknown",
      );
    } else {
      this.#problem = undefined;
    }
    return snapshot;
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
