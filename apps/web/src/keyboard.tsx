import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { anyMenuOpen, Sheet } from "./components.tsx";
import { useDeviceChoice } from "./device.ts";
import { Link, navigate, useLocation } from "./router.tsx";

// Keyboard shortcuts: single keys, in the manner of mail and code-review
// tools, that act only while focus is outside a text field, an open menu and
// a dialog, and never with Ctrl, Alt or Meta held unless the key itself needs
// them. Every shortcut is declared once, in shortcuts below, which the help
// overlay lists whole. While it is mounted, the view of each place gives every
// shortcut of that place its action (useShortcuts), and the composer takes its
// own, which act within its fields, from its form's key handler
// (useFieldShortcuts); each must give exactly its place's shortcuts, so none
// listed goes without an action. The operator turns them all off in
// Settings, and this browser keeps the choice.
//
// Enter in the composer's text boxes is a choice of its own, off unless the
// operator turns it on in Settings, which this browser keeps: on, Enter sends
// and Shift+Enter starts a new line, as in a terminal. It is not a shortcut,
// so turning the shortcuts off leaves it as chosen: someone who turns them
// off for their screen reader or voice control and turns it on still wants
// Enter to send. The composer's boxes say so in their hints while it is on.
//
// The handler listens on the document, after the page's own handlers, so a
// control that handles a key itself, such as a menu's Escape, keeps it. A
// screen reader in its browse mode takes single keys for its own navigation
// before the page sees them, so these act only once it passes keys through,
// as in its focus mode or where the operator lets a key through.
//
// Side by side, the thread list and a thread are on the page at once, each
// in its pane, which its view's ShortcutArea names. While focus is in one
// place's area, another place's keys act there only if they reach across
// (reachesAcross): the list's do, moving focus into it, as j does from the
// thread beside it, but a thread's do not, so e, a digit or u never acts on
// the thread while the operator is in the list. A key both places bind, as
// both bind n, acts in the place whose area holds focus, or, with focus in
// neither, in the later place in shortcutPlaces: the thread.

// Where a shortcut acts: anywhere, on the thread list, on a thread's page,
// or within the composer's text fields.
const shortcutPlaces = ["Anywhere", "Thread list", "Thread", "Composer"] as const;
export type ShortcutPlace = (typeof shortcutPlaces)[number];

// Whether a place's keys act while focus is in another place's area.
const reachesAcross: Record<ShortcutPlace, boolean> = {
  Anywhere: true,
  "Thread list": true,
  Thread: false,
  Composer: false,
};

// A key is a KeyboardEvent key value, such as "j", "?" or "Escape"; one with
// a modifier it needs, "Control+Enter" or "Meta+Enter"; "1-9", any digit from
// 1 through 9; or two such keys in turn, apart by a space, as "g t".
export interface Shortcut {
  place: ShortcutPlace;
  // The keys that do it, any one of them.
  keys: readonly string[];
  description: string;
  // Whether a key held down acts once, not again as it repeats: those that
  // leave the page, which would otherwise go on past where the operator
  // meant to stop.
  once?: true;
}

export const shortcuts = {
  help: { place: "Anywhere", keys: ["?"], description: "Show the keyboard shortcuts" },
  goThreads: { place: "Anywhere", keys: ["g t"], description: "Go to Threads" },
  goSessions: { place: "Anywhere", keys: ["g s"], description: "Go to Sessions" },
  goSettings: { place: "Anywhere", keys: ["g ,"], description: "Go to Settings" },
  nextThread: { place: "Thread list", keys: ["j"], description: "Move to the next thread" },
  previousThread: { place: "Thread list", keys: ["k"], description: "Move to the previous thread" },
  nextNeeding: {
    place: "Thread list",
    keys: ["n"],
    description: "Move to the next thread that is unread or blocked on you",
  },
  previousNeeding: {
    place: "Thread list",
    keys: ["N"],
    description: "Move to the previous thread that is unread or blocked on you",
  },
  openThread: { place: "Thread list", keys: ["o"], description: "Open the thread" },
  toggleSelected: {
    place: "Thread list",
    keys: ["x"],
    description: "Select or unselect the thread, to act on it with others",
  },
  search: { place: "Thread list", keys: ["/"], description: "Search the threads" },
  backToList: { place: "Thread", keys: ["u", "Escape"], description: "Back to the thread list" },
  reply: { place: "Thread", keys: ["r"], description: "Write in the composer" },
  archive: {
    place: "Thread",
    keys: ["e"],
    description: "Archive all of the thread, then go where Auto-advance says",
    once: true,
  },
  openAbove: {
    place: "Thread",
    keys: ["["],
    description: "Open the thread above in the list",
    once: true,
  },
  openBelow: {
    place: "Thread",
    keys: ["]"],
    description: "Open the thread below in the list",
    once: true,
  },
  jump: {
    place: "Thread",
    keys: ["n"],
    description: "Jump to the next unread message or open ask",
  },
  choose: {
    place: "Thread",
    keys: ["1-9"],
    description:
      "Choose a suggested answer by its number, on the ask that has focus or else the first open ask",
  },
  send: { place: "Composer", keys: ["Control+Enter", "Meta+Enter"], description: "Send" },
  leaveComposer: { place: "Composer", keys: ["Escape"], description: "Leave the composer" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof shortcuts;

// The shortcuts of a place.
type IdsIn<P extends ShortcutPlace> = {
  [Id in ShortcutId]: (typeof shortcuts)[Id]["place"] extends P ? Id : never;
}[ShortcutId];

// An action given a shortcut, with the key that was pressed. One whose
// control cannot act, as Send cannot while there is nothing to send, does
// nothing, and the key is still taken from the browser: no key bound does
// anything of the browser's own where it acts, except / on the thread list,
// which takes Firefox's Quick Find, deliberately.
type ShortcutAction = (key: string) => void;

// The actions a place's view gives: one for each of its shortcuts.
type PlaceActions<P extends ShortcutPlace> = Record<IdsIn<P>, ShortcutAction>;

// How long the second key of two may follow the first.
export const prefixTimeout = 1500;

// Where this browser keeps whether the shortcuts are on.
export const shortcutsChoice = "agention.keyboard-shortcuts";

// Where this browser keeps whether Enter sends from the composer.
export const enterSendsChoice = "agention.enter-sends";

// Where the shortcuts are turned on and off.
const keyboardSettingsHref = "/settings/keyboard";

const digit = /^[1-9]$/;

// modified says whether Ctrl, Alt or Meta is held for its own sake. AltGr,
// which types a character on many layouts, as ] on a German keyboard, and
// which Chrome on Windows reports as Ctrl and Alt held together, holds none
// for a key it types, punctuation such as [ and ]: the key is the character
// it typed. Chrome on Windows reports AltGr for a real Ctrl and Alt chord
// too, so with a letter or a digit, which no shortcut needs AltGr to type,
// or a named key such as Escape, which types nothing, it counts as Ctrl and
// Alt.
function modified(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const typedByAltGr = event.getModifierState("AltGraph") && /^[^\p{L}\p{N}]$/u.test(event.key);
  return event.metaKey || (!typedByAltGr && (event.ctrlKey || event.altKey));
}

// stepMatches says whether one key of a shortcut is the key pressed.
function stepMatches(step: string, event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const [modifier, key] = step.includes("+") && step.length > 1 ? step.split("+") : [];
  if (modifier !== undefined && key !== undefined) {
    const held = modifier === "Control" ? event.ctrlKey : event.metaKey;
    const other = modifier === "Control" ? event.metaKey : event.ctrlKey;
    return held && !other && !event.altKey && !event.shiftKey && event.key === key;
  }
  if (modified(event)) {
    return false;
  }
  return step === "1-9" ? digit.test(event.key) : event.key === step;
}

const stepsOf = (key: string) => key.split(" ");

// The first keys of the shortcuts of two keys.
const prefixes = new Set(
  Object.values(shortcuts).flatMap((shortcut: Shortcut) =>
    shortcut.keys.flatMap((key) => {
      const steps = stepsOf(key);
      return steps.length > 1 && steps[0] !== undefined ? [steps[0]] : [];
    }),
  ),
);

// typing says whether a key goes to something that takes text: a text
// field, a select, which takes typed letters to choose, or editable content.
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range"].includes(
      target.type,
    );
  }
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

// composing says whether a key is an input method's, while it composes text:
// the Enter that commits what it composed acts on nothing else. WebKit sends
// that Enter with isComposing false, but with the key code 229, as every
// browser does while composing.
export const composing = (event: ReactKeyboardEvent) =>
  event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

// sendsByEnter says whether a key is Enter alone, typed into one of the
// composer's text boxes, which sends while the operator chose that it does,
// though not as it repeats (useFieldShortcuts). Shift+Enter, like Enter
// elsewhere in its form, such as on a button, is the browser's.
const sendsByEnter = (event: ReactKeyboardEvent) =>
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.metaKey &&
  event.target instanceof HTMLTextAreaElement;

// overlaid says whether a dialog or an options menu is open, which takes the
// keys for itself, the composer's own included.
const overlaid = () => document.querySelector("dialog[open]") !== null || anyMenuOpen();

// heldBack says whether a key is the page's own: already handled, typed into
// a text field, where any composition is, or pressed while a dialog or a menu
// is open.
const heldBack = (event: KeyboardEvent) =>
  event.defaultPrevented || typing(event.target) || overlaid();

interface Keyboard {
  on: boolean;
  setOn: (on: boolean) => void;
  // Whether Enter sends from the composer, and a way to choose it.
  enterSends: boolean;
  setEnterSends: (enterSends: boolean) => void;
  showHelp: () => void;
  // register gives a shortcut its action, through a getter of the latest,
  // in the area of the page its place holds, if it names one, until the
  // returned function takes it away. Only one component gives a shortcut its
  // action at a time.
  register: (id: ShortcutId, action: () => ShortcutAction, area?: Area) => () => void;
}

// The part of the page a place holds, side by side: its pane.
type Area = RefObject<HTMLElement | null>;

// ShortcutArea names, for the views within it, the area their place holds.
export const ShortcutArea = createContext<Area | undefined>(undefined);

const KeyboardContext = createContext<Keyboard | undefined>(undefined);

function useKeyboardContext(): Keyboard {
  const keyboard = useContext(KeyboardContext);
  if (keyboard === undefined) {
    throw new Error("The keyboard shortcuts need a KeyboardProvider");
  }
  return keyboard;
}

// useKeyboard gives whether the shortcuts are on, a way to turn them on or
// off, whether Enter sends from the composer, a way to choose it, and a way
// to show their overlay.
export function useKeyboard(): Pick<
  Keyboard,
  "on" | "setOn" | "enterSends" | "setEnterSends" | "showHelp"
> {
  return useKeyboardContext();
}

// useShortcuts gives a place's shortcuts their actions, all of them, while
// the calling component, the place's view, is mounted. The actions may change
// on every render; the latest given acts.
export function useShortcuts<P extends "Thread list" | "Thread">(
  _place: P,
  actions: PlaceActions<P>,
): void {
  useRegistered(useKeyboardContext().register, actions, useContext(ShortcutArea));
}

function useRegistered<P extends ShortcutPlace>(
  register: Keyboard["register"],
  actions: PlaceActions<P>,
  area?: Area,
): void {
  const latest = useRef(actions);
  latest.current = actions;
  const ids = Object.keys(actions).sort().join(" ");
  useEffect(() => {
    const removals = (ids.split(" ") as IdsIn<P>[]).map((id) =>
      register(id, () => latest.current[id], area),
    );
    return () => removals.forEach((remove) => remove());
  }, [register, ids, area]);
}

// useFieldShortcuts gives the composer's form a key handler for the
// shortcuts that act within its fields, all of them, while the shortcuts are
// on and no dialog or menu is open, such as Attach's within the form; and,
// while the operator chose that Enter sends, for Enter in its text boxes,
// which does what its Send shortcut does, the shortcuts on or off.
export function useFieldShortcuts(
  _place: "Composer",
  actions: PlaceActions<"Composer">,
): (event: ReactKeyboardEvent) => void {
  const { on, enterSends } = useKeyboardContext();
  return (event) => {
    if (event.defaultPrevented || composing(event) || overlaid()) {
      return;
    }
    if (enterSends && sendsByEnter(event)) {
      // A held Enter sends once, and its repeats type nothing: one that
      // began as Shift+Enter, Shift then let go, or one after a send that
      // failed, would otherwise send.
      event.preventDefault();
      if (!event.repeat) {
        actions.send(event.key);
      }
      return;
    }
    if (!on) {
      return;
    }
    for (const [id, action] of Object.entries(actions) as [ShortcutId, ShortcutAction][]) {
      const shortcut: Shortcut = shortcuts[id];
      if (shortcut.keys.some((key) => stepMatches(key, event))) {
        event.preventDefault();
        action(event.key);
        return;
      }
    }
  };
}

// KeyboardProvider holds the shortcuts for the signed-in pages: whether they
// are on, the actions the views give them, the handler on the document, and
// the help overlay, which shows the shortcuts whether or not they are on.
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useDeviceChoice(shortcutsChoice, true);
  const [enterSends, setEnterSends] = useDeviceChoice(enterSendsChoice, false);
  // Each shortcut's action, and its place's area, by its id.
  const actions = useRef(new Map<ShortcutId, { action: () => ShortcutAction; area?: Area }>());
  const [helpOpen, setHelpOpen] = useState(false);
  const showHelp = useCallback(() => setHelpOpen(true), []);
  const register = useCallback((id: ShortcutId, action: () => ShortcutAction, area?: Area) => {
    const map = actions.current;
    if (map.has(id)) {
      throw new Error(`The shortcut ${id} already has an action`);
    }
    map.set(id, area === undefined ? { action } : { action, area });
    return () => map.delete(id);
  }, []);
  useRegistered<"Anywhere">(register, {
    help: () => setHelpOpen(true),
    goThreads: () => navigate("/"),
    goSessions: () => navigate("/sessions"),
    goSettings: () => navigate("/settings"),
  });

  useEffect(() => {
    if (!on) {
      return;
    }
    // The first key of two, while the second may follow.
    let pending: { key: string; timer: ReturnType<typeof setTimeout> } | undefined;
    const clear = () => {
      clearTimeout(pending?.timer);
      pending = undefined;
    };
    // actionFor finds the action of the registered shortcut a key completes,
    // after the first key of two, before, or alone, among those that act
    // where focus is; of two places' that both bind it, the one in the area
    // that holds focus, or else the later place's.
    const actionFor = (event: KeyboardEvent, before: string | undefined) => {
      const completed = [...actions.current].flatMap(([id, registered]) => {
        const shortcut: Shortcut = shortcuts[id];
        const matches = shortcut.keys.some((key) => {
          const steps = stepsOf(key);
          const [first, second] = steps;
          return before === undefined
            ? steps.length === 1 && first !== undefined && stepMatches(first, event)
            : first === before && second !== undefined && stepMatches(second, event);
        });
        return matches
          ? [{ place: shortcut.place, once: shortcut.once === true, ...registered }]
          : [];
      });
      const focus = document.activeElement;
      const holds = (area: Area | undefined) =>
        focus !== null && area?.current?.contains(focus) === true;
      const inArea = [...actions.current.values()].some(({ area }) => holds(area));
      const acting = completed.filter(
        ({ place, area }) => !inArea || holds(area) || reachesAcross[place],
      );
      const order = ({ place }: { place: ShortcutPlace }) => shortcutPlaces.indexOf(place);
      const focused = acting.find(({ area }) => holds(area));
      const later = acting.sort((one, other) => order(other) - order(one))[0];
      return focused ?? later;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const before = pending?.key;
      clear();
      if (heldBack(event)) {
        return;
      }
      const second = before === undefined ? undefined : actionFor(event, before);
      if (second === undefined && !modified(event) && prefixes.has(event.key)) {
        event.preventDefault();
        pending = { key: event.key, timer: setTimeout(clear, prefixTimeout) };
        return;
      }
      const found = second ?? actionFor(event, undefined);
      if (found !== undefined) {
        event.preventDefault();
        if (!(found.once && event.repeat)) {
          found.action()(event.key);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clear();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [on]);

  return (
    <KeyboardContext.Provider value={{ on, setOn, enterSends, setEnterSends, showHelp, register }}>
      {children}
      {helpOpen && <ShortcutsHelp on={on} onClose={() => setHelpOpen(false)} />}
    </KeyboardContext.Provider>
  );
}

// The keys as the overlay names them.
const keyNames: Record<string, string> = {
  Escape: "Esc",
  "Control+Enter": "Ctrl+Enter",
  "Meta+Enter": "Cmd+Enter",
  "1-9": "1 to 9",
};

// Keys names a shortcut's keys, any one of which does it, each of two keys
// in turn as "g then t".
function Keys({ keys }: { keys: readonly string[] }) {
  return keys.map((key, index) => (
    <span key={key}>
      {index > 0 && " or "}
      {stepsOf(key).map((step, at) => (
        <span key={at}>
          {at > 0 && " then "}
          <kbd>{keyNames[step] ?? step}</kbd>
        </span>
      ))}
    </span>
  ));
}

// ShortcutsHelp is the overlay listing every shortcut, by where it acts, and
// where to turn them off or on. Closing it returns focus to where it was;
// going to another page, as its link to Settings does, closes it there.
function ShortcutsHelp({ on, onClose }: { on: boolean; onClose: () => void }) {
  const sheet = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => document.activeElement);
  const { pathname } = useLocation();
  const [openedAt] = useState(pathname);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (pathname !== openedAt) {
      close.current();
    }
  }, [pathname, openedAt]);
  return (
    <Sheet
      sheet={sheet}
      heading="Keyboard shortcuts"
      onClose={() => {
        onClose();
        if (opener instanceof HTMLElement && opener.isConnected) {
          opener.focus();
        }
      }}
      foot={
        <button type="button" onClick={() => sheet.current?.close()}>
          Close
        </button>
      }
    >
      <p>
        {on
          ? "Single keys act while focus is outside a text field. Turn them off in "
          : "Keyboard shortcuts are off in this browser. Turn them on in "}
        <Link to={keyboardSettingsHref}>Settings, under Keyboard</Link>.
      </p>
      {shortcutPlaces.map((place) => (
        <section key={place} className="shortcut-place">
          <h3>{place}</h3>
          <dl className="shortcut-list">
            {Object.values(shortcuts)
              .filter((shortcut: Shortcut) => shortcut.place === place)
              .map((shortcut: Shortcut) => (
                <div key={shortcut.description}>
                  <dt>
                    <Keys keys={shortcut.keys} />
                  </dt>
                  <dd>{shortcut.description}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
}
