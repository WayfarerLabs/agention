// The oldest Node major version the bridge runs on, as its package's engines
// range and its bundle's target say.
export const minimumNodeMajor = 24;

// nodeVersionProblem says why the bridge cannot run on a Node version, such as
// process.versions.node, or returns undefined when it can. This module imports
// nothing, so the entry point can check before loading code an older Node may
// lack.
export function nodeVersionProblem(version: string): string | undefined {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (major >= minimumNodeMajor) {
    return undefined;
  }
  return `agention-mcp needs Node.js ${minimumNodeMajor} or later, but this is Node.js ${version}`;
}
