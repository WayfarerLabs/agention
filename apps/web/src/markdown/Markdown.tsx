import { isLinkableUrl } from "@wayfarerlabs/agention-api";
import type { Nodes, Root, RootContent, Table } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { createElement, Fragment, type ReactNode, useMemo } from "react";
import { ErrorBoundary } from "../boundary.tsx";
import { Diagram } from "./Diagram.tsx";

// Agention's Markdown: CommonMark with GitHub's tables, task lists and
// strikethrough, rendered inert. Nothing in the text can run, load or style
// anything: raw HTML shows as text, images show as links, only absolute https
// links are live, and no class or attribute comes from the text. A fenced
// block whose language is mermaid is a diagram, which is drawn in a sandboxed
// frame and shows as an image the page makes from the frame's answer. Bare URLs
// stay text, since GFM's autolink literals are not enabled, and so do
// footnotes, which would generate links and ids.
//
// Nor can the text take the page down. A line that opens more blocks than
// maxNesting is shown as text without being parsed, since the parser's cost
// grows faster than such text; the renderer shows anything nested deeper than
// maxNesting as its text, so no tree exhausts the stack; and a field that
// fails to render anyway falls back to its text.

export const maxNesting = 32;

// Headings in the text sit this many levels below the page's own heading.
const headingLevelsBelowPage = 2;

export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
    mdastExtensions: [
      gfmStrikethroughFromMarkdown(),
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });
}

// A block quote marker or a list item marker at the start of a line, after
// the markers before it.
const blockMarker = /[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/y;

// opensTooManyBlocks says whether a line of text opens more nested blocks,
// block quotes and list items in any mix, than maxNesting.
export function opensTooManyBlocks(text: string): boolean {
  for (const line of text.split(/\r\n|\r|\n/)) {
    let opened = 0;
    blockMarker.lastIndex = 0;
    while (blockMarker.exec(line) !== null) {
      opened++;
      if (opened > maxNesting) {
        return true;
      }
    }
  }
  return false;
}

// liveUrl returns the parsed URL a link goes to, or undefined when the URL is
// shown as text. The link's href is the parsed URL, so what the browser
// follows is exactly what the rule checked.
export function liveUrl(url: string): URL | undefined {
  if (!isLinkableUrl(url)) {
    return undefined;
  }
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

// ExternalLink is a live link to somewhere outside Agention. It opens in a new
// tab, so following it never loses a draft, and sends no referrer. When its
// text is not its own URL, the link's host follows it, since a phone cannot
// show where a link goes before it is followed.
export function ExternalLink({
  url,
  text,
  children,
}: {
  url: URL;
  // The link's text, to compare with its URL.
  text: string;
  children: ReactNode;
}) {
  const showsItsUrl = text === url.href || liveUrl(text)?.href === url.href;
  return (
    <>
      <a
        href={url.href}
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
        target="_blank"
      >
        {children}
      </a>
      {!showsItsUrl && <span className="host"> ({url.host})</span>}
    </>
  );
}

interface Context {
  // Link and image reference definitions, by normalized label.
  definitions: Map<string, string>;
  // How many nodes enclose the one being rendered.
  depth: number;
  // Inline content, where raw HTML is a run of text rather than a block.
  inline: boolean;
  // Inside a link, images render as their text and links do not nest.
  inLink: boolean;
  // Inside a tight list, paragraphs render without their own block.
  tight: boolean;
}

// pushChildren adds children to a stack of nodes to visit, so they are taken
// off it in order.
function pushChildren(pending: Nodes[], children: readonly Nodes[]): void {
  for (let index = children.length - 1; index >= 0; index--) {
    pending.push(children[index] as Nodes);
  }
}

// plainText returns the text a node holds, walking the tree without
// recursion.
export function plainText(root: Nodes): string {
  let text = "";
  const pending: Nodes[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if ("value" in node) {
      text += node.value;
    } else if (node.type === "image" || node.type === "imageReference") {
      text += node.alt ?? "";
    } else if ("children" in node) {
      pushChildren(pending, node.children);
    }
  }
  return text;
}

// collectDefinitions maps each label to the URL of its first definition, as in
// CommonMark, walking the tree without recursion.
export function collectDefinitions(root: Root): Map<string, string> {
  const definitions = new Map<string, string>();
  const pending: Nodes[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === "definition") {
      if (!definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
    } else if ("children" in node) {
      pushChildren(pending, node.children);
    }
  }
  return definitions;
}

function renderLink(
  url: string | undefined,
  text: string,
  children: ReactNode,
  context: Context,
): ReactNode {
  const live = url === undefined || context.inLink ? undefined : liveUrl(url);
  return live === undefined ? (
    children
  ) : (
    <ExternalLink url={live} text={text}>
      {children}
    </ExternalLink>
  );
}

// An image never loads: it is a link to its URL, labelled with its alt text or
// the URL when it has none, and inside a link it is just that text.
function renderImage(url: string | undefined, alt: string, context: Context): ReactNode {
  const label = alt !== "" ? alt : (url ?? "");
  return renderLink(url, label, label, context);
}

function renderChildren(nodes: RootContent[], context: Context): ReactNode[] {
  const inner = { ...context, depth: context.depth + 1 };
  return nodes.map((node, index) => renderNode(node, inner, index));
}

function renderTable(table: Table, context: Context, key: number): ReactNode {
  const [head, ...body] = table.children;
  const row = (cells: Table["children"][number], cell: "th" | "td", rowKey: number) => (
    <tr key={rowKey}>
      {cells.children.map((child, index) => {
        // Alignment is one of a fixed set of classes.
        const align = table.align?.[index];
        return createElement(
          cell,
          { key: index, className: align ? `align-${align}` : undefined },
          renderChildren(child.children, { ...context, inline: true }),
        );
      })}
    </tr>
  );
  return (
    <div key={key} className="table">
      <table>
        {head !== undefined && <thead>{row(head, "th", 0)}</thead>}
        {body.length > 0 && <tbody>{body.map((cells, index) => row(cells, "td", index))}</tbody>}
      </table>
    </div>
  );
}

function renderNode(node: RootContent, context: Context, key: number): ReactNode {
  // Below maxNesting, a node with children shows as its text.
  if (context.depth > maxNesting && "children" in node) {
    return <Fragment key={key}>{plainText(node)}</Fragment>;
  }
  const inline = { ...context, inline: true };
  switch (node.type) {
    case "paragraph":
      return context.tight ? (
        <Fragment key={key}>{renderChildren(node.children, inline)}</Fragment>
      ) : (
        <p key={key}>{renderChildren(node.children, inline)}</p>
      );
    case "heading":
      return createElement(
        `h${Math.min(6, node.depth + headingLevelsBelowPage)}`,
        { key },
        renderChildren(node.children, inline),
      );
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return (
        <blockquote key={key}>
          {renderChildren(node.children, { ...context, tight: false })}
        </blockquote>
      );
    case "list": {
      const tight = !(node.spread === true || node.children.some((item) => item.spread === true));
      const items = renderChildren(node.children, { ...context, tight });
      return node.ordered === true ? (
        <ol key={key} start={node.start ?? undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "listItem": {
      const task = typeof node.checked === "boolean";
      return (
        <li key={key} className={task ? "task" : undefined}>
          {task && <input type="checkbox" checked={node.checked === true} disabled readOnly />}
          {renderChildren(node.children, context)}
        </li>
      );
    }
    case "code":
      // A mermaid block is a diagram, drawn in isolation; any other info
      // string is not used, so no class comes from the text.
      return node.lang === "mermaid" ? (
        <Diagram key={key} source={node.value} />
      ) : (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case "html":
      // Raw HTML is text; a block of it keeps its line breaks.
      return context.inline ? (
        <Fragment key={key}>{node.value}</Fragment>
      ) : (
        <p key={key} className="raw">
          {node.value}
        </p>
      );
    case "definition":
      return null;
    case "table":
      return renderTable(node, context, key);
    case "text":
      return <Fragment key={key}>{node.value}</Fragment>;
    case "emphasis":
      return <em key={key}>{renderChildren(node.children, inline)}</em>;
    case "strong":
      return <strong key={key}>{renderChildren(node.children, inline)}</strong>;
    case "delete":
      return <del key={key}>{renderChildren(node.children, inline)}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "break":
      return <br key={key} />;
    case "link":
    case "linkReference": {
      const url = node.type === "link" ? node.url : context.definitions.get(node.identifier);
      const children = renderChildren(node.children, { ...inline, inLink: true });
      return <Fragment key={key}>{renderLink(url, plainText(node), children, context)}</Fragment>;
    }
    case "image":
    case "imageReference": {
      const url = node.type === "image" ? node.url : context.definitions.get(node.identifier);
      return <Fragment key={key}>{renderImage(url, node.alt ?? "", context)}</Fragment>;
    }
    default:
      // The parser makes no other nodes with the extensions above; anything
      // else would show as its text.
      return <Fragment key={key}>{plainText(node)}</Fragment>;
  }
}

// AsText shows Markdown as the text it is, keeping its line breaks.
function AsText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <p className="plain">{text}</p>
    </div>
  );
}

function Rendered({ text }: { text: string }) {
  const content = useMemo(() => {
    if (opensTooManyBlocks(text)) {
      return undefined;
    }
    const tree = parseMarkdown(text);
    return renderChildren(tree.children, {
      definitions: collectDefinitions(tree),
      depth: 0,
      inline: false,
      inLink: false,
      tight: false,
    });
  }, [text]);
  return content === undefined ? <AsText text={text} /> : <div className="markdown">{content}</div>;
}

// Markdown renders text written as Markdown. Its headings sit two levels below
// the page's own heading, and stop at level six.
export function Markdown({ text }: { text: string }) {
  return (
    <ErrorBoundary key={text} fallback={<AsText text={text} />}>
      <Rendered text={text} />
    </ErrorBoundary>
  );
}
