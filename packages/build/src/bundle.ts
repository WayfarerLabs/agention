import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { build } from "esbuild";

// The file the build writes beside each bundle.
export const noticesFile = "THIRD-PARTY-NOTICES.txt";

// The license notice of one npm package that a published package includes.
export interface PackageNotice {
  name: string;
  version: string;
  license: string | undefined;
  texts: string[];
}

// Other files a published package ships beside its bundle, such as the web UI
// the server serves, and the npm packages they include.
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
  const inputs = Object.keys(metafile.inputs);
  const packageDirs = new Set([...bundledPackages(inputs), ...inlinedPackages(inputs)]);
  const sections = [noticeSection(bundleName, [...packageDirs].map(packageNotice))];
  if (options.alsoShips !== undefined) {
    sections.push(noticeSection(options.alsoShips.name, options.alsoShips.packages));
  }
  writeFileSync(notices, sections.join("\n"));
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
// "//#region ../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/ajv.js".
// The directory is the installed copy of that package, which must be the
// version inlined: the package that bundles them lists each under its
// devDependencies, so its license text is at hand and its advisories audited.
function inlinedPackages(inputs: string[]): string[] {
  const packageDirs = new Set<string>();
  for (const input of inputs) {
    const owner = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1];
    if (owner === undefined) {
      continue;
    }
    const regions = readFileSync(input, "utf8").matchAll(
      /^\/\/#region \S*?node_modules\/(?:\.pnpm\/([^/]+)\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//gm,
    );
    for (const [, store, name] of regions) {
      if (name === undefined || owner.endsWith(`node_modules/${name}`)) {
        continue;
      }
      // A pnpm store directory names the package and its version, followed by
      // its peers: ajv-formats@3.0.1_ajv@8.18.0.
      const version = store?.slice(name.replace("/", "+").length + 1).split("_")[0];
      packageDirs.add(installedCopy(resolve(owner), name, version));
    }
  }
  return [...packageDirs];
}

// installedCopy finds the package a module in from would import as name, and
// checks it is the version given.
function installedCopy(from: string, name: string, version: string | undefined): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      const installed = (
        JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { version: string }
      ).version;
      if (version === undefined || installed === version) {
        return candidate;
      }
      break;
    }
    if (dirname(dir) === dir) {
      break;
    }
  }
  const wanted = version === undefined ? name : `${name}@${version}`;
  throw new Error(
    `${from} inlines ${wanted}, whose license notice the bundle must ship: add ${wanted} to ` +
      "the devDependencies of the package that bundles it",
  );
}

function noticeSection(name: string, packages: PackageNotice[]): string {
  const title = `Third-party software in ${name}\n\n`;
  if (packages.length === 0) {
    return `${title}${name} includes no third-party packages.\n`;
  }
  const sections = packages.map(formatNotice).sort();
  return `${title}${name} includes the npm packages below, each under the license shown with it.\n\n${sections.join("\n")}`;
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

function formatNotice(notice: PackageNotice): string {
  return [
    `${"-".repeat(72)}\n`,
    `${notice.name} ${notice.version}\n`,
    `License: ${notice.license ?? "not stated"}\n\n`,
    notice.texts.length > 0
      ? `${notice.texts.join("\n\n")}\n`
      : "The package includes no license file.\n",
  ].join("");
}
