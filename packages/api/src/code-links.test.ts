import { describe, expect, it } from "vitest";
import {
  branchLink,
  branchList,
  branchShortForm,
  linkKey,
  maxLinks,
  parseBranch,
  parsePullRequest,
  pullRequestLink,
  pullRequestList,
  pullRequestShortForm,
  repo,
  shortForm,
} from "./code-links.ts";
import { messageSendInput } from "./threads.ts";

describe("repo", () => {
  it.each([
    "acme/agention",
    "Acme-Labs/agention.js",
    "a/_",
    "a/..x",
    `${"o".repeat(39)}/${"n".repeat(100)}`,
  ])("takes %s", (value) => {
    expect(repo.safeParse(value).success).toBe(true);
  });

  it.each([
    "agention",
    "acme/",
    "/agention",
    "acme/agention/x",
    "oc_to/agention",
    "acme/two words",
    "acme/.",
    "acme/..",
    "acme/a#1",
    "acme/a:b",
    `${"o".repeat(40)}/n`,
    `o/${"n".repeat(101)}`,
  ])("refuses %j", (value) => {
    expect(repo.safeParse(value).success).toBe(false);
  });
});

describe("a branch's name", () => {
  // Each decided as git check-ref-format --branch decides it.
  it.each(["main", "feat/links", "a#1", "a@b", "a{b", "a/-b", "a.lock.b", "a.b", "café"])(
    "takes %s",
    (branch) => {
      expect(branchLink.safeParse({ repo: "o/r", branch }).success).toBe(true);
    },
  );

  it.each([
    "",
    "a b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a..b",
    "a@{b",
    "-a",
    "/a",
    "a/",
    "a//b",
    "a.",
    ".a",
    "a/.b",
    "a.lock",
    "a/b.lock",
    "a.lock/b",
    "@",
    "HEAD",
    "a\tb",
    "a‮b",
    "x".repeat(256),
  ])("refuses %j", (branch) => {
    expect(branchLink.safeParse({ repo: "o/r", branch }).success).toBe(false);
  });

  it("takes 255 characters", () => {
    expect(branchLink.safeParse({ repo: "o/r", branch: "x".repeat(255) }).success).toBe(true);
  });
});

describe("a pull request", () => {
  it("takes a positive whole number and a linkable URL", () => {
    expect(pullRequestLink.safeParse({ repo: "o/r", number: 1 }).success).toBe(true);
    for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(pullRequestLink.safeParse({ repo: "o/r", number }).success).toBe(false);
    }
    const url = "https://github.com/o/r/pull/1";
    expect(pullRequestLink.safeParse({ repo: "o/r", number: 1, url }).success).toBe(true);
    const refused = pullRequestLink.safeParse({ repo: "o/r", number: 1, url: "http://x.y" });
    expect(refused.error?.issues[0]?.path).toEqual(["url"]);
  });
});

describe("short forms and keys", () => {
  it("writes and reads each kind back", () => {
    const pull = { repo: "Acme/Agention", number: 135 };
    const branch = { repo: "Acme/Agention", branch: "feat/a#1" };
    expect(shortForm(pull)).toBe("Acme/Agention#135");
    expect(shortForm(branch)).toBe("Acme/Agention:feat/a#1");
    expect(parsePullRequest(shortForm(pull))).toEqual(pull);
    expect(parseBranch(shortForm(branch))).toEqual(branch);
  });

  it("folds the repository but never the number or the branch", () => {
    expect(linkKey({ repo: "Acme/Agention", number: 7 })).toBe("acme/agention#7");
    expect(linkKey({ repo: "Acme/Agention", branch: "Feat/X" })).toBe("acme/agention:Feat/X");
  });

  it("refuses what is not of its kind, saying which rule it breaks", () => {
    for (const text of ["o/r", "o/r#", "o/r#01", "o/r#1x", "o/r:main", "#1", "o/r#0"]) {
      expect(pullRequestShortForm.safeParse(text).success, text).toBe(false);
    }
    for (const text of ["o/r", "o/r#1", "o/r:", "o:r:main", ":main"]) {
      expect(branchShortForm.safeParse(text).success, text).toBe(false);
    }
    expect(branchShortForm.safeParse("o/r:a..b").error?.issues[0]?.message).toMatch(/^branch /);
    expect(pullRequestShortForm.safeParse("o_x/r#1").error?.issues[0]?.message).toMatch(/^repo /);
    expect(branchShortForm.safeParse("o_x/r:main").error?.issues[0]?.message).toMatch(/^repo /);
  });
});

describe("a message's lists", () => {
  it("names each entry once, by its key", () => {
    const twice = pullRequestList.safeParse([
      { repo: "Acme/R", number: 1 },
      { repo: "acme/r", number: 1, url: "https://github.com/acme/r/pull/1" },
    ]);
    expect(twice.error?.issues[0]?.path).toEqual([1]);
    expect(
      branchList.safeParse([
        { repo: "o/r", branch: "Main" },
        { repo: "o/r", branch: "main" },
      ]).success,
    ).toBe(true);
  });

  it("holds 1 to maxLinks entries", () => {
    const pulls = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ repo: "o/r", number: index + 1 }));
    expect(pullRequestList.safeParse(pulls(0)).success).toBe(false);
    expect(pullRequestList.safeParse(pulls(maxLinks)).success).toBe(true);
    expect(pullRequestList.safeParse(pulls(maxLinks + 1)).success).toBe(false);
  });

  it("is a part of its own", () => {
    const base = { request_id: "r", seen_through: 1 };
    expect(messageSendInput.safeParse(base).success).toBe(false);
    expect(
      messageSendInput.safeParse({ ...base, pull_requests: [{ repo: "o/r", number: 1 }] }).success,
    ).toBe(true);
    expect(
      messageSendInput.safeParse({ ...base, branches: [{ repo: "o/r", branch: "main" }] }).success,
    ).toBe(true);
  });
});
