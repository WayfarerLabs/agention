import { type ChangeEvent, type RefObject, useRef, useState } from "react";
import { MenuItem, OptionsMenu } from "../components.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { useMedia } from "../media.ts";
import type { DraftFiles } from "./attach.ts";

// AttachButton is Attach, its paper clip alone, and the file pickers it
// opens. With a mouse or a trackpad it opens the one picker, which takes any
// files. On a phone or a tablet, where the browser would hand that picker to
// the system's chooser, it opens a menu of its own instead, whose items say
// what each source is: the camera for a photo or a video, the photos and
// videos on the device, or other files. Each item is its own hidden picker, so
// what is chosen from any of them is added alike. Choosing leaves focus on
// Attach, where the picker returns it.

// A device whose primary pointer is a finger, a phone or a tablet. A laptop
// whose screen also takes touch keeps its picker, since its primary pointer
// is its trackpad or mouse.
const touch = "(pointer: coarse)";

interface Source {
  label: string;
  icon: IconName;
  accept?: string;
  // Which camera a capture opens; one taken from the camera is one file.
  capture?: "environment";
}

// The one picker of a mouse or a trackpad, which takes any file.
const files: Source = { label: "Files", icon: "file" };

const sources: readonly Source[] = [
  { label: "Take a photo", icon: "camera", accept: "image/*", capture: "environment" },
  { label: "Record a video", icon: "video", accept: "video/*", capture: "environment" },
  { label: "Photos and videos", icon: "photos", accept: "image/*,video/*" },
  // Documents and text only: a picker that could take images, video or
  // audio is one Android hands to its chooser of camera, video camera and
  // files, which this menu stands in for, while this goes to its files.
  { label: "Other files", icon: "file", accept: "application/*,text/*" },
];

export function AttachButton({
  draft,
  attach,
  disabled,
}: {
  draft: DraftFiles;
  attach: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
}) {
  const onTouch = useMedia(touch);
  const [open, setOpen] = useState(false);
  const pickers = useRef(new Map<Source, HTMLInputElement>());
  const pick = (source: Source) => pickers.current.get(source)?.click();
  const add = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    draft.add(chosen.map((file) => ({ file, name: file.name })));
  };
  return (
    <>
      {(onTouch ? sources : [files]).map((source) => (
        <input
          key={source.label}
          ref={(element) => {
            if (element === null) {
              pickers.current.delete(source);
            } else {
              pickers.current.set(source, element);
            }
          }}
          type="file"
          multiple={source.capture === undefined}
          accept={source.accept}
          capture={source.capture}
          hidden
          onChange={add}
        />
      ))}
      {onTouch ? (
        <OptionsMenu
          label="Attach files"
          open={open}
          setOpen={setOpen}
          button={attach}
          icon="attach"
          buttonClass="secondary attach"
          disabled={disabled}
        >
          {sources.map((source) => (
            <MenuItem key={source.label} onChoose={() => pick(source)}>
              <Icon name={source.icon} />
              {source.label}
            </MenuItem>
          ))}
        </OptionsMenu>
      ) : (
        <button
          ref={attach}
          type="button"
          className="secondary attach"
          aria-label="Attach files"
          title="Attach files"
          disabled={disabled}
          onClick={() => pick(files)}
        >
          <Icon name="attach" />
        </button>
      )}
    </>
  );
}
