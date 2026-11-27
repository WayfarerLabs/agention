import { Status } from "../components.tsx";
import { CopyButton, useCopy } from "../copy.tsx";

// A code block, with a button that copies exactly its text.
export function CodeBlock({ code }: { code: string }) {
  const copying = useCopy();
  return (
    <>
      <div className="code-block">
        <pre>
          <code>{code}</code>
        </pre>
        <CopyButton label="Copy code" copying={copying} text={code} />
      </div>
      {copying.outcome === "refused" && (
        <Status>This browser refused to copy this code: select it to copy it by hand.</Status>
      )}
    </>
  );
}
