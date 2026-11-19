import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./cli.ts";

function capture() {
  return {
    text: "",
    write(text: string) {
      this.text += text;
    },
  };
}

async function runCaptured(args: string[]) {
  const stdout = capture();
  const stderr = capture();
  let served = false;
  const code = await run(args, {
    stdout,
    stderr,
    serve: async () => {
      served = true;
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, served };
}

describe("agention-mcp", () => {
  it("serves MCP on standard input and output without arguments", async () => {
    expect(await runCaptured([])).toEqual({ code: 0, stdout: "", stderr: "", served: true });
  });

  it("prints the package version", async () => {
    expect(await runCaptured(["--version"])).toEqual({
      code: 0,
      stdout: `agention-mcp ${packageJson.version}\n`,
      stderr: "",
      served: false,
    });
  });

  it.each([["--help"], ["-h"]])("prints help on stdout for %s", async (flag) => {
    const result = await runCaptured([flag]);
    expect(result).toMatchObject({ code: 0, stderr: "", served: false });
    expect(result.stdout).not.toBe("");
  });

  it.each([
    ["an unknown option", ["--verbose"]],
    ["a positional argument", ["serve"]],
  ])("rejects %s with a usage error on stderr", async (_, args) => {
    const result = await runCaptured(args);
    expect(result).toMatchObject({ code: 2, stdout: "", served: false });
    expect(result.stderr).not.toBe("");
  });
});
