import { useCallback, useId, useRef } from "react";
import { PageHeading, usePageTitle } from "../components.tsx";
import { Icon } from "../icons.tsx";
import { Link } from "../router.tsx";
import { NotFound } from "./NotFound.tsx";
import {
  firstSection,
  type SettingsSection,
  sectionBySlug,
  sectionHref,
  settingsNavigation,
} from "./settings/sections.ts";

// The Settings view: what the operator configures, in the sections
// settings/sections.ts declares, each at /settings/<slug>. On a wide screen
// the navigation stands beside the open section, and /settings opens the
// first; on a phone, /settings is the navigation alone and a section's page
// leads back to it. Which of them shows is the stylesheet's to decide, by
// the screen's width, so /settings holds both the navigation and the first
// section.

export function Settings({ section }: { section?: string }) {
  const open = section === undefined ? firstSection : sectionBySlug(section);
  return open === undefined ? (
    <NotFound />
  ) : (
    <SettingsPage open={open} listing={section === undefined} />
  );
}

// SettingsPage shows the open section beside the navigation, or, listing,
// at /settings, beside the navigation a phone shows alone.
function SettingsPage({ open, listing }: { open: SettingsSection; listing: boolean }) {
  usePageTitle(listing ? "Settings" : `${open.title} · Settings`);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useCallback(() => heading.current?.focus(), []);
  const Section = open.component;
  return (
    <div className={listing ? "settings listing" : "settings"}>
      <PageHeading visuallyHidden>Settings</PageHeading>
      <SettingsNavigation open={open} listing={listing} />
      {/* The way back to the list, in the navigation's place on a phone. */}
      <Link to="/settings" className="back settings-back" aria-label="Back to settings">
        <Icon name="arrow-left" />
        Settings
      </Link>
      <section className="settings-section" aria-labelledby={headingId}>
        <h2 id={headingId} ref={heading} tabIndex={-1}>
          {open.title}
        </h2>
        <Section focusHeading={focusHeading} />
      </section>
    </div>
  );
}

// SettingsNavigation lists the sections, by group, then those apart. The
// open section is marked as the page on its own page, and as the current one
// at /settings, where a phone lists it without showing it.
function SettingsNavigation({ open, listing }: { open: SettingsSection; listing: boolean }) {
  const id = useId();
  const entries = (sections: readonly SettingsSection[], labelledBy?: string) => (
    <ul aria-labelledby={labelledBy}>
      {sections.map((section) => (
        <li key={section.slug}>
          <Link
            to={sectionHref(section)}
            aria-current={section === open ? (listing ? "true" : "page") : undefined}
          >
            {section.title}
          </Link>
        </li>
      ))}
    </ul>
  );
  return (
    <nav className="settings-nav" aria-label="Settings">
      {settingsNavigation.groups.map(({ group, sections }) => (
        <div className="settings-group" key={group}>
          <p id={`${id}-${group}`}>{group}</p>
          {entries(sections, `${id}-${group}`)}
        </div>
      ))}
      {settingsNavigation.apart.length > 0 && (
        <div className="settings-apart">{entries(settingsNavigation.apart)}</div>
      )}
    </nav>
  );
}
