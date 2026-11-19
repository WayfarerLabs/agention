import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { bundle, noticesFile, readViteLicenses } from "./bundle.ts";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agention-build-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(name: string, content: string): void {
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, content);
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
    fakePackage(join(modules, "dirs"), "dirs", { "LICENSE/README": "not a license file\n" });
    put(join(root, "src/main.ts"), 'import { name } from "dirs";\nconsole.log(name);\n');

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"));

    expect(readFileSync(join(root, "dist", noticesFile), "utf8")).toContain("dirs 1.2.3");
  });

  it("adds the notices of the other files a package ships, as a Vite build reports them", async () => {
    const root = tempDir();
    put(join(root, "src/main.ts"), 'console.log("server");\n');
    put(
      join(root, "web/license.json"),
      JSON.stringify([
        { name: "ui-lib", version: "4.5.6", identifier: "MIT", text: "ui-lib license text\n" },
        { name: "bare", version: "0.1.0" },
      ]),
    );

    await bundle(join(root, "src/main.ts"), join(root, "dist/out.js"), {
      alsoShips: { name: "the web UI", packages: readViteLicenses(join(root, "web/license.json")) },
    });
    const notices = readFileSync(join(root, "dist", noticesFile), "utf8");

    for (const text of ["the web UI", "ui-lib 4.5.6", "MIT", "ui-lib license text", "bare 0.1.0"]) {
      expect(notices).toContain(text);
    }
  });
});
