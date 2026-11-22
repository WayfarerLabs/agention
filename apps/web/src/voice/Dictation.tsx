import {
  minRecordingBytes,
  type SettingsResult,
  type TranscriptionResult,
} from "@wayfarerlabs/agention-api";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { describeFailure, request, upload } from "../api.ts";
import { focusLeftWith, Status } from "../components.tsx";
import { useFollowing, useUnauthenticatedCheck } from "../data.ts";
import { Icon } from "../icons.tsx";
import { useSession } from "../session.tsx";
import { stopSpeaking } from "./speech.ts";

// Dictation: the operator records, the server has the recording transcribed
// by the provider in Settings, and the text goes where the caller puts it.
// Nothing is ever sent by itself. The composer and Settings' Try it share it,
// so Try it tests the path dictation takes.

// A recording stops at five minutes, or at 1.9 MiB of data, whichever comes
// first. At 32 kbit/s five minutes is about 1.2 MB, which keeps a recording
// under the API's 2 MiB body cap.
export const recordingLimit = 5 * 60_000;
export const recordingByteLimit = Math.floor(1.9 * 1024 * 1024);
export const audioBitsPerSecond = 32_000;

// How long a transcription may take: the server's 30 seconds to receive the
// upload and the provider's 60 to answer, with room to spare.
export const transcriptionTimeout = 120_000;

// The types a recording is made in, in the order tried, as the upload
// declares them.
const recorderTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

// recorderType picks the type this browser records in, or undefined when it
// cannot record.
export function recorderType(): string | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof navigator.mediaDevices?.getUserMedia !== "function"
  ) {
    return undefined;
  }
  return recorderTypes.find((type) => MediaRecorder.isTypeSupported(type));
}

// useVoiceOn reads the settings once, when the page opens, and says whether
// to offer dictation: voice is on, and this browser can record.
export function useVoiceOn(): boolean {
  const settings = useFollowing("settings", true, () =>
    request<SettingsResult>("GET", "/settings"),
  );
  return settings?.voice?.on === true && recorderType() !== undefined;
}

// A finished recording, with the type it was asked for.
interface Take {
  blob: Blob;
  type: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; elapsed: number }
  | { kind: "transcribing"; take: Take }
  // Failed, kept for Retry until discarded.
  | { kind: "failed"; take: Take; failure: unknown };

// The control that takes focus once the next state shows, when one of this
// dictation's own controls replaced another.
type Focus = "dictate" | "stop" | "transcribing" | "retry";

const clock = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function microphoneProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError"
    ? "The microphone was refused. Allow it in this site's settings to dictate."
    : name === "NotFoundError" || name === "OverconstrainedError"
      ? "No microphone was found."
      : "The microphone could not be started.";
}

export interface Dictation {
  // The controls: Dictate, then Stop while recording, Cancel while
  // transcribing, and Retry and Discard after a failure.
  controls: ReactNode;
  // What went wrong, such as why a transcription failed, or null.
  problem: ReactNode;
  // What dictation says otherwise, such as that nothing was heard, or null.
  said: ReactNode;
}

// useDictation records, has the recording transcribed, and gives the text to
// onText when it holds words. It stops recording when the page is hidden,
// and transcribes what it recorded, and stops and drops everything when the
// caller goes away. The caller places its controls and what it says.
export function useDictation({
  onText,
  onActive,
  disabled = false,
}: {
  // Takes a transcript that holds words, and whether focus is still where
  // dictation's controls left it, free for the caller to move.
  onText: (text: string, focusFree: boolean) => void;
  // Told when a recording starts and when none is left: recording,
  // transcribing or awaiting Retry.
  onActive?: (active: boolean) => void;
  disabled?: boolean;
}): Dictation {
  const { csrf } = useSession();
  const onFailure = useUnauthenticatedCheck();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [notice, setNotice] = useState<{ text: string; problem: boolean }>();
  const recorder = useRef<MediaRecorder>(undefined);
  const dropped = useRef(false);
  const transcription = useRef<AbortController>(undefined);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const focus = useRef<Focus>(undefined);
  const controlRefs = useRef(new Map<Focus, HTMLElement>());
  const refFor = (which: Focus) => (element: HTMLElement | null) => {
    if (element === null) {
      controlRefs.current.delete(which);
    } else {
      controlRefs.current.set(which, element);
    }
  };
  // Where the controls are, which a control the operator pressed is in.
  const container = useRef<HTMLDivElement>(null);
  // Focus moves to the next state's control once it shows, unless the
  // operator has moved it meanwhile, as into the message box while the
  // microphone opens.
  useLayoutEffect(() => {
    const wanted = focus.current;
    const element = wanted === undefined ? undefined : controlRefs.current.get(wanted);
    if (element !== undefined) {
      focus.current = undefined;
      if (focusLeftWith(container.current)) {
        element.focus();
      }
    }
  });

  const finish = useCallback((drop: boolean) => {
    const current = recorder.current;
    if (current !== undefined && current.state !== "inactive") {
      dropped.current = drop;
      current.stop();
    }
  }, []);

  const end = useCallback((then?: Focus) => {
    focus.current = then;
    setPhase({ kind: "idle" });
    onActiveRef.current?.(false);
  }, []);

  const transcribe = useCallback(
    async (take: Take) => {
      // Too short to hold words, as a tap of Dictate and Stop makes.
      if (take.blob.size < minRecordingBytes) {
        end("dictate");
        setNotice({ text: "Nothing heard.", problem: false });
        return;
      }
      const controller = new AbortController();
      transcription.current = controller;
      setNotice(undefined);
      setPhase({ kind: "transcribing", take });
      try {
        const result = await upload<TranscriptionResult>("/transcriptions", take.blob, {
          type: take.type,
          csrf,
          timeout: transcriptionTimeout,
          signal: controller.signal,
        });
        if (controller.signal.aborted || !mounted.current) {
          return;
        }
        if (result.text.trim() === "") {
          end("dictate");
          setNotice({ text: "Nothing heard.", problem: false });
        } else {
          const free = focusLeftWith(container.current);
          end();
          onTextRef.current(result.text, free);
        }
      } catch (failure) {
        if (controller.signal.aborted || !mounted.current) {
          return;
        }
        onFailure(failure);
        focus.current = "retry";
        setPhase({ kind: "failed", take, failure });
      }
    },
    [csrf, end, onFailure],
  );

  const start = async () => {
    stopSpeaking();
    setNotice(undefined);
    const type = recorderType();
    if (type === undefined) {
      setNotice({ text: "This browser cannot record.", problem: true });
      return;
    }
    setPhase({ kind: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (mounted.current) {
        end("dictate");
        setNotice({ text: microphoneProblem(error), problem: true });
      }
      return;
    }
    const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
    if (!mounted.current) {
      stopTracks();
      return;
    }
    // A page still hidden when the microphone opens was hidden before any
    // recorder existed for the hide to stop, so none starts unwatched.
    if (document.visibilityState === "hidden") {
      stopTracks();
      end("dictate");
      return;
    }
    const chunks: Blob[] = [];
    let bytes = 0;
    const started = Date.now();
    let made: MediaRecorder;
    try {
      made = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond });
      made.start(1000);
    } catch (error) {
      stopTracks();
      end("dictate");
      setNotice({ text: microphoneProblem(error), problem: true });
      return;
    }
    recorder.current = made;
    dropped.current = false;
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= recordingLimit) {
        finish(false);
      } else {
        setPhase((current) =>
          current.kind === "recording" ? { kind: "recording", elapsed } : current,
        );
      }
    }, 250);
    made.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
        bytes += event.data.size;
        if (bytes >= recordingByteLimit) {
          finish(false);
        }
      }
    };
    made.onstop = () => {
      window.clearInterval(timer);
      stopTracks();
      recorder.current = undefined;
      if (!mounted.current) {
        return;
      }
      if (dropped.current) {
        end();
      } else {
        focus.current = "transcribing";
        void transcribe({ blob: new Blob(chunks, { type }), type });
      }
    };
    focus.current = "stop";
    setPhase({ kind: "recording", elapsed: 0 });
    onActiveRef.current?.(true);
  };

  // A hidden page stops the recording, so the microphone never runs
  // unwatched, and transcribes what it recorded.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        finish(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, [finish]);

  // Going away stops the recording, every track with it, and drops a
  // transcription under way.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      finish(true);
      transcription.current?.abort();
    };
  }, [finish]);

  const cancel = () => {
    transcription.current?.abort();
    end("dictate");
  };

  const problem =
    phase.kind === "failed" ? (
      <div className="notice danger" role="alert">
        <p>Transcribing failed: {describeFailure(phase.failure)}</p>
      </div>
    ) : notice?.problem === true ? (
      <p className="field-error" role="alert">
        {notice.text}
      </p>
    ) : null;
  const said =
    phase.kind !== "failed" && notice?.problem === false ? <Status>{notice.text}</Status> : null;

  // Each phase's controls carry a key of their own, so none takes over the
  // element of another: a second tap on Stop never lands on Cancel.
  let controls: ReactNode;
  switch (phase.kind) {
    case "idle":
    case "starting":
      controls = (
        <button
          key="dictate"
          ref={refFor("dictate")}
          type="button"
          className="secondary"
          disabled={disabled || phase.kind === "starting"}
          onClick={() => void start()}
        >
          <Icon name="microphone" />
          <span className="dictate-label">Dictate</span>
        </button>
      );
      break;
    case "recording":
      controls = (
        <Fragment key="recording">
          {/* Said once, as recording starts; the clock itself is not
              announced each time it ticks. */}
          <span className="visually-hidden" role="status">
            Recording
          </span>
          <p className="recording-time">
            <span className="recording-word">Recording </span>
            {clock(phase.elapsed)} of {clock(recordingLimit)}
          </p>
          <button ref={refFor("stop")} type="button" onClick={() => finish(false)}>
            Stop
          </button>
        </Fragment>
      );
      break;
    case "transcribing":
      controls = (
        <Fragment key="transcribing">
          <p ref={refFor("transcribing")} tabIndex={-1} className="status" role="status">
            Transcribing
          </p>
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        </Fragment>
      );
      break;
    case "failed":
      controls = (
        <Fragment key="failed">
          <p className="dictation-failed">Failed</p>
          <button ref={refFor("retry")} type="button" onClick={() => void transcribe(phase.take)}>
            Retry
          </button>
          <button type="button" className="secondary" onClick={() => end("dictate")}>
            Discard
          </button>
        </Fragment>
      );
      break;
  }
  return {
    controls: (
      <div ref={container} className="dictation">
        {controls}
      </div>
    ),
    problem,
    said,
  };
}
