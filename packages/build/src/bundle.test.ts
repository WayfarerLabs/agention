import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, onTestFinished } from "vitest";
import { bundle, bundleScript, noticesFile, readViteLicenses } from "./bundle.ts";
import { suppliedNotices } from "./supplied-notices.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agention-build-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(name: string, content: string): void {
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, content);
}

// eplPackage is the package.json of a package under the EPL, for fakePackage.
function eplPackage(name: string, version: string): string {
  return JSON.stringify({ name, version, license: "EPL-2.0", type: "module", main: "index.js" });
}

// noticedPackage returns a package that the build supplies notice text for,
// and the lines of that text.
function noticedPackage(): { name: string; version: string; lines: string[] } {
  const [key, supplied] = Object.entries(suppliedNotices)[0] ?? ["", { quoted: [] }];
  const blocks = [...supplied.quoted, ...(supplied.ours ?? [])];
  const at = key.lastIndexOf("@");
  return {
    name: key.slice(0, at),
    version: key.slice(at + 1),
    lines: blocks.flatMap((block) => block.split("\n")),
  };
}

// fakePackage writes a minimal ESM package that exports its own name.
function fakePackage(dir: string, name: string, files: Record<string, string>): void {
  put(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.2.3", license: "MIT", type: "module", main: "index.js" }),
  );
  put(join(dir, "index.js"), `export const name = ${JSON.stringify(name)};\n`);
  for (const [file, content] of Object.entries(files)) {
    put(join(dir, file), content);
  }
}

describe("bundle", () => {
  it("writes the license of every npm package the bundle includes beside it", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    fakePackage(join(modules, "plain"), "plain", { LICENSE: "plain license text\n" });
    fakePackage(join(modules, "@scope/nested"), "@scope/nested", {
      "LICENSE.md": "nested license text\n",
      NOTICE: "nested notice text\n",
      "index.js": 'export { name } from "inner";\n',
    });
    fakePackage(join(modules, "@scope/nested/node_modules/inner"), "inner", {
      COPYING: "inner license text\n",
    });
    fakePackage(join(modules, "unused"), "unused", { LICENSE: "unused license text\n" });
    put(
      join(root, "src/main.ts"),
      'import { name as plain } from "plain";\nimport { name as nested } from "@scope/nested";\nconsole.log(plain, nested);\n',
    );

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));
    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    for (const text of [
      "plain 1.2.3",
      "plain license text",
      "@scope/nested 1.2.3",
      "nested license text",
      "nested notice text",
      "inner 1.2.3",
      "inner license text",
    ]) {
      expect(notices).toContain(text);
    }
    expect(notices).not.toContain("unused");
  });

  it("writes the licenses of the packages an included package inlined in its own build", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    const region = (id: string, name: string) =>
      `//#region ../../node_modules/.pnpm/${id}/node_modules/${name}/dist/index.js\n//#endregion\n`;
    fakePackage(join(modules, "sdk"), "sdk", {
      LICENSE: "sdk license text\n",
      "index.js": `${region("validator@1.2.3", "validator")}${region("@scope+helper@1.2.3_validator@1.2.3", "@scope/helper")}export const name = "sdk";\n`,
    });
    fakePackage(join(modules, "validator"), "validator", { LICENSE: "validator license text\n" });
    fakePackage(join(modules, "@scope/helper"), "@scope/helper", { LICENSE: "helper text\n" });
    put(join(root, "src/main.ts"), 'import { name } from "sdk";\nconsole.log(name);\n');

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));
    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    for (const text of ["sdk 1.2.3", "validator 1.2.3", "validator license text", "helper text"]) {
      expect(notices).toContain(text);
    }
  });

  it("writes the licenses of the packages an included package's esbuild build inlined", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    fakePackage(join(modules, "chart"), "chart", {
      LICENSE: "chart license text\n",
      "index.js":
        "// ../../node_modules/.pnpm/yaml-lib@1.2.3/node_modules/yaml-lib/dist/index.mjs\n" +
        "// src/chart.ts\n" +
        'export const name = "chart";\n',
    });
    fakePackage(join(modules, "yaml-lib"), "yaml-lib", { LICENSE: "yaml-lib license text\n" });
    put(join(root, "src/main.ts"), 'import { name } from "chart";\nconsole.log(name);\n');

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));

    expect(readFileSync(join(root, "dist", noticesFile), "utf8")).toContain(
      "yaml-lib license text",
    );
  });

  it("finds an inlined package in the bundling workspace when another version is above it", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    fakePackage(join(modules, "sdk"), "sdk", {
      "index.js":
        "//#region ../../node_modules/.pnpm/validator@1.2.3/node_modules/validator/index.js\n" +
        'export const name = "sdk";\n',
      LICENSE: "sdk license text\n",
    });
    fakePackage(join(modules, "validator"), "validator", { LICENSE: "the wrong version\n" });
    put(
      join(modules, "validator/package.json"),
      JSON.stringify({ name: "validator", version: "9.9.9", main: "index.js" }),
    );
    fakePackage(join(root, "app/node_modules/validator"), "validator", {
      LICENSE: "the inlined version\n",
    });
    put(join(root, "app/src/main.ts"), 'import { name } from "sdk";\nconsole.log(name);\n');

    await bundle(join(root, "app/src/main.ts"), join(root, "app/dist/out.js"));
    const notices = readFileSync(join(root, "app/dist", noticesFile), "utf8");

    expect(notices).toContain("the inlined version");
    expect(notices).not.toContain("the wrong version");
  });

  it("fails when a package inlined in an included package's build is not installed at its version", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    fakePackage(join(modules, "sdk"), "sdk", {
      "index.js":
        "//#region ../../node_modules/.pnpm/validator@9.9.9/node_modules/validator/index.js\n" +
        'export const name = "sdk";\n',
    });
    fakePackage(join(modules, "validator"), "validator", {});
    put(join(root, "src/main.ts"), 'import { name } from "sdk";\nconsole.log(name);\n');

    await expect(bundle(join(root, "src/main.ts"), join(root, "dist/out.js"))).rejects.toThrow(
      "validator@9.9.9",
    );
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("writes notices with no package section when the bundle includes no third-party package", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'import { argv } from "node:process";\nconsole.log(argv);\n');

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));

    expect(readFileSync(join(root, "dist", noticesFile), "utf8")).not.toContain("-".repeat(72));
  });

  it("removes earlier notices when the build fails", async () => {
    const root = tempDir();
    put(join(root, "dist", noticesFile), "stale\n");
    put(
      join(root, "src/main.ts"),
      'import { missing } from "not-installed";\nconsole.log(missing);\n',
    );

    await expect(bundle(join(root, "src/main.ts"), join(root, "dist/out.js"))).rejects.toThrow();
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("reads only regular files as license files", async () => {
    const root = tempDir();
    const modules = join(root, "node_modules");
    fakePackage(join(modules, "dirs"), "dirs", {
      "LICENSE/README": "not a license file\n",
      COPYING: "dirs license text\n",
    });
    put(join(root, "src/main.ts"), 'import { name } from "dirs";\nconsole.log(name);\n');

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));
    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    expect(notices).toContain("dirs license text");
    expect(notices).not.toContain("not a license file");
  });

  it("refuses a package with no license text and none supplied", async () => {
    const root = tempDir();
    fakePackage(join(root, "node_modules/unlicensed"), "unlicensed", {});
    put(join(root, "src/main.ts"), 'import { name } from "unlicensed";\nconsole.log(name);\n');

    await expect(bundle(join(root, "src/main.ts"), join(root, "dist/out.js"))).rejects.toThrow(
      "unlicensed",
    );
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("refuses a package the Vite build reports with no license text and none supplied", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'console.log("server");\n');
    put(join(root, "web/license.json"), JSON.stringify([{ name: "bare", version: "0.1.0" }]));

    await expect(
      bundle(join(root, "src/main.ts"), join(root, "dist/out.js"), {
        alsoShips: {
          name: "the web UI",
          packages: readViteLicenses(join(root, "web/license.json")),
        },
      }),
    ).rejects.toThrow("bare");
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("refuses a package under the EPL with no supplied notice", async () => {
    const root = tempDir();
    fakePackage(join(root, "node_modules/copyleft"), "copyleft", {
      "package.json": eplPackage("copyleft", "1.0.0"),
    });
    put(join(root, "src/main.ts"), 'import { name } from "copyleft";\nconsole.log(name);\n');

    await expect(bundle(join(root, "src/main.ts"), join(root, "dist/out.js"))).rejects.toThrow(
      "copyleft",
    );
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("refuses a package with no license field whose license file is the EPL", async () => {
    const root = tempDir();
    fakePackage(join(root, "node_modules/copyleft"), "copyleft", {
      "package.json": JSON.stringify({ name: "copyleft", version: "1.0.0", main: "index.js" }),
      "LICENSE.md": "# Eclipse Public License - v 2.0\n",
    });
    put(join(root, "src/main.ts"), 'import { name } from "copyleft";\nconsole.log(name);\n');

    await expect(bundle(join(root, "src/main.ts"), join(root, "dist/out.js"))).rejects.toThrow(
      "copyleft",
    );
    expect(existsSync(join(root, "dist", noticesFile))).toBe(false);
  });

  it("writes the notice text the build supplies for a package", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'console.log("server");\n');
    const { name, version, lines } = noticedPackage();

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"), {
      alsoShips: {
        name: "the web UI",
        packages: [{ name, version, license: "EPL-2.0", texts: [] }],
      },
    });

    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    for (const line of lines) {
      expect(notices).toContain(line);
    }
  });

  it("adds the notices of the other files a package ships, as a Vite build reports them", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'console.log("server");\n');
    put(
      join(root, "web/license.json"),
      JSON.stringify([
        { name: "ui-lib", version: "4.5.6", identifier: "MIT", text: "ui-lib license text\n" },
        { name: "bare", version: "0.1.0", text: "bare license text\n" },
      ]),
    );

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"), {
      alsoShips: { name: "the web UI", packages: readViteLicenses(join(root, "web/license.json")) },
    });
    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    for (const text of [
      "the web UI",
      "ui-lib 4.5.6",
      "MIT",
      "ui-lib license text",
      "bare 0.1.0",
      "bare license text",
    ]) {
      expect(notices).toContain(text);
    }
  });
});

describe("bundleScript", () => {
  it("builds one classic script, its dynamic imports inlined, named for its content", async () => {
    const root = tempDir();
    fakePackage(join(root, "node_modules/lazy-lib"), "lazy-lib", {
      LICENSE: "lazy-lib license text\n",
    });
    put(
      join(root, "src/main.ts"),
      'void import("lazy-lib").then(({ name }) => {\n  (globalThis as { loaded?: string }).loaded = name;\n});\n',
    );

    const { file, packages } = await bundleScript(
      join(root, "src/main.ts"),
      join(root, "dist"),
      "frame",
      "the notices",
    );

    expect(file).toMatch(/^assets\/frame-[A-Z0-9]+\.js$/);
    // A classic script: it runs as one, with nothing to load.
    const context: { loaded?: string } = {};
    runInNewContext(readFileSync(join(root, "dist", file), "utf8"), context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.loaded).toBe("lazy-lib");
    expect(packages.map(({ name, version, texts }) => ({ name, version, texts }))).toEqual([
      { name: "lazy-lib", version: "1.2.3", texts: ["lazy-lib license text"] },
    ]);
  });

  it("names the script as given at the directory's root when its name is fixed", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'console.log("worker");\n');

    const { file } = await bundleScript(
      join(root, "src/main.ts"),
      join(root, "dist"),
      "service-worker",
      "x",
      { fixedName: true },
    );

    expect(file).toBe("service-worker.js");
    expect(existsSync(join(root, "dist", "service-worker.js"))).toBe(true);
  });

  it("opens the script with a comment that keeps the supplied notices of the EPL packages it includes", async () => {
    const root = tempDir();
    const { name, version, lines } = noticedPackage();
    fakePackage(join(root, "node_modules", name), name, {
      "package.json": eplPackage(name, version),
    });
    put(join(root, "src/main.ts"), `import { name } from "${name}";\nconsole.log(name);\n`);

    const { file } = await bundleScript(
      join(root, "src/main.ts"),
      join(root, "dist"),
      "frame",
      "x",
    );
    const script = readFileSync(join(root, "dist", file), "utf8");

    const comment = script.slice(0, script.indexOf("*/"));

    expect(script.startsWith("/*!")).toBe(true);
    for (const line of lines) {
      expect(comment).toContain(line);
    }
  });

  it("refuses a script that includes a package under the EPL with no supplied notice", async () => {
    const root = tempDir();
    fakePackage(join(root, "node_modules/copyleft"), "copyleft", {
      "package.json": eplPackage("copyleft", "1.0.0"),
    });
    put(join(root, "src/main.ts"), 'import { name } from "copyleft";\nconsole.log(name);\n');

    await expect(
      bundleScript(join(root, "src/main.ts"), join(root, "dist"), "frame", "x"),
    ).rejects.toThrow("copyleft");
    expect(existsSync(join(root, "dist", "assets"))).toBe(false);
  });
});
