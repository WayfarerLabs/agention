import type { SettingsResult } from "@wayfarerlabs/agention-server-api";
import { request } from "../../api.ts";
import { Loadable } from "../../components.tsx";
import { useResource } from "../../data.ts";
import { byteSize, plural } from "../../format.tsx";

// Settings' storage: how much space the files attached to messages take,
// pending uploads among them, which every backup copies. It is only shown;
// nothing here changes it.

const loadSettings = () => request<SettingsResult>("GET", "/settings");

// StorageSection is Settings' section of storage, once the settings load.
export function StorageSection() {
  const settings = useResource(loadSettings);
  return (
    <Loadable data={settings.data} failure={settings.failure} retry={settings.refresh}>
      {(data) => <Storage totals={data.storage} />}
    </Loadable>
  );
}

function Storage({ totals }: { totals: SettingsResult["storage"] }) {
  return (
    <p>
      {totals.count === 0
        ? "No files are attached yet."
        : `Attachments take ${byteSize(totals.bytes)} in ${plural(totals.count, "file")}, and every backup copies them.`}
    </p>
  );
}
