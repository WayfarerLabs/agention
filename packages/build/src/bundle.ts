import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type BuildOptions, build, type Metafile } from "esbuild";
import { suppliedNotices } from "./supplied-notices.ts";

// The file the build writes beside each bundle.
export const noticesFile = "THIRD-PARTY-NOTICES.txt";

// The license notice of one third-party package that a published package
// includes: an npm package, or a work whose files a workspace copies in, such
// as the web UI's icons.
export interface PackageNotice {
  name: string;
  version: string;
  license: string | undefined;
  texts: string[];
}

// Other files a published package ships beside its bundle, such as the web UI
// the server serves, and the third-party packages they include.
export interface ShippedFiles {
  name: string;
  packages: PackageNotice[];
}

// bundle builds a command into one ESM file for Node that includes all of its
// code, so its package can declare no dependencies, and writes the license
// notices of every npm package the bundle includes beside it, counting those
// an included package inlined in its own build, followed by those of the other
// files the package ships.
export async function bundle(
  entry: string,
  outfile: string,
  options: { alsoShips?: ShippedFiles } = {},
): Promise<void> {
  // A failed build must not leave an earlier build's notices beside it.
  const notices = join(dirname(outfile), noticesFile);
  rmSync(notices, { force: true });
  const { metafile } = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "warning",
    metafile: true,
  });
  const bundleName = basename(outfile);
  const sections = [noticeSection(bundleName, includedPackages(metafile, entry))];
  if (options.alsoShips !== undefined) {
    sections.push(noticeSection(options.alsoShips.name, options.alsoShips.packages));
  }
  writeFileSync(notices, sections.join("\n"));
}

// bundleScript builds a browser entry into one minified classic script that
// includes all of its code, every dynamic import inlined, so it loads as one
// file wherever it runs, a frame whose origin is opaque included. The script
// is written into dir as assets/<name>-<hash>.js, named for its content, so
// it can be cached for good, or, with fixedName, as <name>.js at dir's root,
// for a script whose address must stay the same across releases, as a
// service worker's does. It returns that path, relative to dir, and the
// license notices of every npm package the script includes, counting those an
// included package inlined in its own build, for the package that ships it.
// The script opens with a comment that says where those notices ship, given
// as noticesAt, and carries the supplied notice of each package under the
// Eclipse Public License, which asks that every copy carry it.
export async function bundleScript(
  entry: string,
  dir: string,
  name: string,
  noticesAt: string,
  { fixedName = false }: { fixedName?: boolean } = {},
): Promise<{ file: string; packages: PackageNotice[] }> {
  const options = {
    entryPoints: [entry],
    outdir: dir,
    entryNames: fixedName ? name : `assets/${name}-[hash]`,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    // The notices the caller ships carry every license.
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
    metafile: true,
  } satisfies BuildOptions;
  // The comment depends on what the script includes, which only a build
  // finds, so a first build that writes nothing finds it.
  const packages = includedPackages((await build({ ...options, write: false })).metafile, entry);
  // Every package's notice is checked here, so a gap fails this build already.
  const eplNotices = packages.flatMap((notice) => {
    const supplied = suppliedNotice(notice);
    if (!underEpl(notice)) {
      return [];
    }
    const lines = supplied.flatMap((block) => block.split("\n"));
    return [
      ` *\n * ${notice.name} ${notice.version}\n${lines.map((line) => ` * ${line}\n`).join("")}`,
    ];
  });
  const { metafile } = await build({
    ...options,
    banner: {
      js: `/*!\n * The license notices of the npm packages this script includes are in ${noticesAt}.\n${eplNotices.join("")} */`,
    },
  });
  const [output] = Object.keys(metafile.outputs);
  if (output === undefined) {
    throw new Error(`building ${entry} wrote no script`);
  }
  return { file: relative(dir, output).split(sep).join("/"), packages };
}

// includedPackages returns the notices of the npm packages a build's input
// files come from, and of those an included package inlined in its own
// build.
function includedPackages(metafile: Metafile, entry: string): PackageNotice[] {
  const inputs = Object.keys(metafile.inputs);
  const packageDirs = new Set([...bundledPackages(inputs), ...inlinedPackages(inputs, entry)]);
  return [...packageDirs].map(packageNotice);
}

// readViteLicenses reads the license metadata a Vite build writes when its
// build.license option names a .json file.
export function readViteLicenses(file: string): PackageNotice[] {
  const entries = JSON.parse(readFileSync(file, "utf8")) as {
    name: string;
    version: string;
    identifier?: string;
    text?: string;
  }[];
  return entries.map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.identifier,
    texts: entry.text === undefined ? [] : [entry.text.trim()],
  }));
}

// bundledPackages returns the directory of each npm package that the
// bundle's input files come from. An input below node_modules belongs to the
// package that its last node_modules segment names; the workspaces' own
// sources are Agention's and need no notice.
function bundledPackages(inputs: string[]): string[] {
  const packageDirs = new Set<string>();
  for (const input of inputs) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match?.[1] !== undefined) {
      packageDirs.add(resolve(match[1]));
    }
  }
  return [...packageDirs];
}

// inlinedPackages returns the directory of each npm package that an included
// package's own build inlined into the files the bundle takes from it, which
// those files name in the region comments rolldown writes, such as
// "//#region ../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/ajv.js",
// or in the path comments esbuild writes, such as
// "// ../../node_modules/.pnpm/js-yaml@4.3.2/node_modules/js-yaml/dist/js-yaml.mjs".
// The directory is the installed copy of that package, which must be the
// version inlined: the package that bundles them lists each under its
// devDependencies, so its license text is at hand and its advisories audited.
// That copy is the one the inlining package would import or, when the
// version there differs, the one the bundle's entry would import, which npm
// installs in the bundling workspace's own node_modules when another version
// is installed above it.
function inlinedPackages(inputs: string[], entry: string): string[] {
  const packageDirs = new Set<string>();
  for (const input of inputs) {
    const owner = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (owner === undefined) {
      continue;
    }
    const regions = readFileSync(input, "utf8").matchAll(
      /^\/\/(?:#region)? \S*?node_modules\/(?:\.pnpm\/([^/]+)\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//gm,
    );
    for (const [, store, name] of regions) {
      if (name === undefined || owner.endsWith(`node_modules/${name}`)) {
        continue;
      }
      // A pnpm store directory names the package and its version, followed by
      // its peers: ajv-formats@3.0.1_ajv@8.18.0.
      const version = store?.slice(name.replace("/", "+").length + 1).split("_")[0];
      packageDirs.add(installedCopy([resolve(owner), dirname(resolve(entry))], name, version));
    }
  }
  return [...packageDirs];
}

// installedCopy finds the package a module in the first of places would
// import as name, or failing that one in the next, that is the version given.
function installedCopy(places: string[], name: string, version: string | undefined): string {
  for (const place of places) {
    const candidate = importedCopy(place, name);
    if (candidate !== undefined) {
      const installed = (
        JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { version: string }
      ).version;
      if (version === undefined || installed === version) {
        return candidate;
      }
    }
  }
  const wanted = version === undefined ? name : `${name}@${version}`;
  throw new Error(
    `${places[0]} inlines ${wanted}, whose license notice the bundle must ship: add ${wanted} ` +
      "to the devDependencies of the package that bundles it",
  );
}

// importedCopy returns the directory of the package a module in from would
// import as name, or undefined when none is installed.
function importedCopy(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

function noticeSection(name: string, packages: PackageNotice[]): string {
  const title = `Third-party software in ${name}\n\n`;
  if (packages.length === 0) {
    return `${title}${name} includes no third-party packages.\n`;
  }
  const sections = packages.map(formatNotice).sort();
  return `${title}${name} includes the third-party packages below, each under the license shown with it.\n\n${sections.join("\n")}`;
}

function packageNotice(dir: string): PackageNotice {
  const { name, version, license } = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ) as {
    name: string;
    version: string;
    license?: unknown;
  };
  const licenseFiles = readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^(license|licence|copying|notice)(?![a-z])/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  return {
    name,
    version,
    license: typeof license === "string" ? license : undefined,
    texts: licenseFiles.map((file) => readFileSync(join(dir, file), "utf8").trim()),
  };
}

// underEpl reports whether a package is under the Eclipse Public License, by
// its license field or a license file.
function underEpl(notice: PackageNotice): boolean {
  return (
    /\bEPL\b/i.test(notice.license ?? "") ||
    notice.texts.some((text) => /Eclipse Public License/i.test(text))
  );
}

// suppliedNotice returns the notice text the build supplies for a package,
// which is empty when the package's own files give the build all it needs. It
// fails for a package under the EPL, or one with no license text the build can
// find, that has none, so no notice ships without what its license asks for.
function suppliedNotice(notice: PackageNotice): readonly string[] {
  const supplied = suppliedNotices[`${notice.name}@${notice.version}`];
  if (supplied !== undefined) {
    return [...supplied.quoted, ...(supplied.ours ?? [])];
  }
  const where = "add its text, quoted from the package, to suppliedNotices in packages/build";
  if (underEpl(notice)) {
    throw new Error(
      `${notice.name} ${notice.version} is under the Eclipse Public License, so its notices must ` +
        `keep its copyright notices and say where its source code is available: ${where}`,
    );
  }
  if (notice.texts.length === 0) {
    throw new Error(
      `${notice.name} ${notice.version} has no license text the build can find, so its notice ` +
        `would carry none: ${where}`,
    );
  }
  return [];
}

function formatNotice(notice: PackageNotice): string {
  const texts = [...suppliedNotice(notice), ...notice.texts];
  return [
    `${"-".repeat(72)}\n`,
    `${notice.name} ${notice.version}\n`,
    `License: ${notice.license ?? "not stated"}\n\n`,
    `${texts.join("\n\n")}\n`,
  ].join("");
}
