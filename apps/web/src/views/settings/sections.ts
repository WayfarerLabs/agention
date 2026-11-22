import type { ComponentType } from "react";
import { ApiKeysSection } from "./ApiKeys.tsx";
import { PasskeysSection } from "./Passkeys.tsx";
import { SignOutSection } from "./SignOut.tsx";
import { StorageSection } from "./Storage.tsx";
import { VoiceSection } from "./Voice.tsx";

// Settings' sections, declared once: the navigation and each section's page,
// at /settings/<slug>, are built from this list, so a new section is an entry
// here and its component. The navigation lists the groups in their order,
// each with its sections in the order declared here, and then the sections
// in no group, apart. /settings opens the first section listed.
//
// A section's component holds everything below its heading, which the
// Settings view gives it, and loads only the data it shows. A section that
// changes a secret offers a recent sign-in itself (RecentSignIn.tsx).

export const settingsGroups = ["Access", "Features"] as const;
export type SettingsGroup = (typeof settingsGroups)[number];

// What the Settings view gives the open section's component.
export interface SectionProps {
  // Puts focus on the section's heading, as at the top of the section.
  focusHeading: () => void;
}

export interface SettingsSection {
  // The section's address under /settings, in lower-kebab-case.
  slug: string;
  title: string;
  // The group it is listed under, or none for one listed apart.
  group?: SettingsGroup;
  component: ComponentType<SectionProps>;
}

export const settingsSections: readonly SettingsSection[] = [
  { slug: "passkeys", title: "Passkeys", group: "Access", component: PasskeysSection },
  { slug: "api-keys", title: "API keys", group: "Access", component: ApiKeysSection },
  { slug: "voice", title: "Voice", group: "Features", component: VoiceSection },
  { slug: "storage", title: "Storage", group: "Features", component: StorageSection },
  { slug: "sign-out", title: "Sign out", component: SignOutSection },
];

// The navigation's groups, each with its sections, leaving out a group with
// none, and the sections listed apart after them.
export const settingsNavigation = {
  groups: settingsGroups
    .map((group) => ({
      group,
      sections: settingsSections.filter((section) => section.group === group),
    }))
    .filter(({ sections }) => sections.length > 0),
  apart: settingsSections.filter((section) => section.group === undefined),
};

const [first] = [
  ...settingsNavigation.groups.flatMap(({ sections }) => sections),
  ...settingsNavigation.apart,
];
if (first === undefined) {
  throw new Error("Settings needs a section");
}

// The section /settings opens: the first the navigation lists.
export const firstSection: SettingsSection = first;

export const sectionBySlug = (slug: string): SettingsSection | undefined =>
  settingsSections.find((section) => section.slug === slug);

export const sectionHref = (section: SettingsSection) => `/settings/${section.slug}`;
