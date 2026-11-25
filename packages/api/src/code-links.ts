import { z } from "zod";
import { maxListed, sequence } from "./bounds.ts";
import { linkableUrl } from "./references.ts";
import { singleLineText } from "./text.ts";

// The pull requests and branches a message names: each a GitHub repository,
// with a pull request's number or a branch's name, and the URL its writer
// gave, if any. They are what the writer declared, shown as data and never
// fetched. An entry's identity, its key, is its short form with the
// repository's owner and name folded to lower case, as GitHub compares them;
// a branch's name is compared exactly, as git does.

// A repository's owner and name, as GitHub allows them.
const maxOwnerLength = 39;
const maxRepositoryNameLength = 100;
const maxRepoLength = maxOwnerLength + 1 + maxRepositoryNameLength;
const repoPattern = new RegExp(
  `^[A-Za-z0-9-]{1,${maxOwnerLength}}/[A-Za-z0-9._-]{1,${maxRepositoryNameLength}}$`,
);

export const repo = z
  .string()
  .regex(
    repoPattern,
    `must be owner/name: an owner of 1 to ${maxOwnerLength} of A-Z, a-z, 0-9 and -, and a ` +
      `name of 1 to ${maxRepositoryNameLength} of A-Z, a-z, 0-9, '.', '_' and -`,
  )
  .refine((value) => !/\/\.{1,2}$/.test(value), "must not name the repository . or ..")
  .describe("The GitHub repository, as owner/name.");

const pullRequestNumber = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .describe("The pull request's number.");

// What git's branch names may not hold, beyond what a single line refuses:
// git check-ref-format --branch's rules.
const notInBranch: [RegExp, string][] = [
  [/[ ~^:?*[\\]/, "must not hold a space, '~', '^', ':', '?', '*', '[' or '\\'"],
  [/\.\.|@\{/, "must not hold '..' or '@{'"],
  [/^[-/]|\/$|\/\//, "must not start with '-' or '/', end with '/', or hold '//'"],
  [/\.$/, "must not end with '.'"],
  [/(^|\/)\.|\.lock(\/|$)/, "must have no part, between '/', that starts with '.' or ends '.lock'"],
  [/^(@|HEAD)$/, "must not be '@' or 'HEAD'"],
];

const maxBranchLength = 255;

const branchName = singleLineText({ min: 1, max: maxBranchLength })
  .superRefine((value, context) => {
    for (const [pattern, message] of notInBranch) {
      if (pattern.test(value)) {
        context.addIssue({ code: "custom", message });
        return;
      }
    }
  })
  .describe("The branch's name, as git names it.");

const linkUrl = linkableUrl.describe(
  "The pull request's or branch's https URL. Give it whenever you have it.",
);

export const pullRequestLink = z.object({
  repo,
  number: pullRequestNumber,
  url: linkUrl.optional(),
});
export type PullRequestLink = z.infer<typeof pullRequestLink>;

export const branchLink = z.object({
  repo,
  branch: branchName,
  url: linkUrl.optional(),
});
export type BranchLink = z.infer<typeof branchLink>;

export type CodeLink = PullRequestLink | BranchLink;

const isPullRequest = (link: CodeLink): link is PullRequestLink => "number" in link;

// shortForm writes an entry as owner/name#135 or owner/name:branch, as written.
export function shortForm(link: CodeLink): string {
  return isPullRequest(link) ? `${link.repo}#${link.number}` : `${link.repo}:${link.branch}`;
}

// linkKey is an entry's identity: its short form, the repository folded to
// lower case. A repository is ASCII, so folding it is exact. A pull request's
// key holds no ':', and a branch's always does, so the two kinds never meet.
export function linkKey(link: CodeLink): string {
  return isPullRequest(link)
    ? `${link.repo.toLowerCase()}#${link.number}`
    : `${link.repo.toLowerCase()}:${link.branch}`;
}

// The most pull requests, and the most branches, one message names.
export const maxLinks = 20;

// eachKeyOnce refuses a list naming the same entry twice.
function eachKeyOnce(links: CodeLink[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  links.forEach((link, index) => {
    const key = linkKey(link);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "names an entry this list already names",
      });
    }
    seen.add(key);
  });
}

// A message's lists: omitted rather than empty, each entry once.
export const pullRequestList = z
  .array(pullRequestLink)
  .min(1)
  .max(maxLinks)
  .superRefine(eachKeyOnce)
  .describe(
    "Up to 20 GitHub pull requests the message is about, each once, with its URL whenever you " +
      "have it.",
  );
export const branchList = z
  .array(branchLink)
  .min(1)
  .max(maxLinks)
  .superRefine(eachKeyOnce)
  .describe(
    "Up to 20 git branches of GitHub repositories the message is about, each once, with its URL " +
      "whenever you have it.",
  );

// Short forms, as filters take them. The repository holds no '#' or ':', so
// a short form splits at the first; which kind a filter takes says which to
// expect, so a '#' within a branch's name stays part of it. The entry's schema
// then checks the fields, so an error names the rule a field breaks.

// A pull request's number in decimal: no more digits than the largest allowed.
const maxNumberDigits = String(Number.MAX_SAFE_INTEGER).length;
const numberPattern = new RegExp(`^[1-9][0-9]{0,${maxNumberDigits - 1}}$`);

// splitPullRequest and splitBranch split a short form into its fields, or
// give undefined when it is not of that form.
function splitPullRequest(text: string): unknown {
  const at = text.indexOf("#");
  const digits = text.slice(at + 1);
  return at < 0 || !numberPattern.test(digits)
    ? undefined
    : { repo: text.slice(0, at), number: Number(digits) };
}

function splitBranch(text: string): unknown {
  const at = text.indexOf(":");
  return at < 0 ? undefined : { repo: text.slice(0, at), branch: text.slice(at + 1) };
}

// parsePullRequest reads a pull request's short form, or gives undefined.
export function parsePullRequest(text: string): PullRequestLink | undefined {
  return pullRequestLink.safeParse(splitPullRequest(text)).data;
}

// parseBranch reads a branch's short form, or gives undefined.
export function parseBranch(text: string): BranchLink | undefined {
  return branchLink.safeParse(splitBranch(text)).data;
}

// shortFormKey gives the key of the entry a short form names, as parse reads
// it, or the text itself when it names none.
export function shortFormKey(text: string, parse: (text: string) => CodeLink | undefined): string {
  const link = parse(text);
  return link === undefined ? text : linkKey(link);
}

// shortFormOf is a short form's schema: text of the form split reads, whose
// fields the entry's schema takes, refused with the reason of the first rule
// it breaks.
function shortFormOf(split: (text: string) => unknown, link: z.ZodType, form: string) {
  return z.string().superRefine((value, context) => {
    const fields = split(value);
    const issue = fields === undefined ? undefined : link.safeParse(fields).error?.issues[0];
    if (fields === undefined) {
      context.addIssue({ code: "custom", message: `must be ${form}` });
    } else if (issue !== undefined) {
      context.addIssue({ code: "custom", message: `${issue.path.join(".")} ${issue.message}` });
    }
  });
}

export const pullRequestShortForm = shortFormOf(
  splitPullRequest,
  pullRequestLink,
  "owner/name#number",
)
  .meta({ maxLength: maxRepoLength + 1 + maxNumberDigits })
  .describe("A pull request as owner/name#number.");
export const branchShortForm = shortFormOf(splitBranch, branchLink, "owner/name:branch")
  .meta({ maxLength: maxRepoLength + 1 + maxBranchLength })
  .describe("A branch as owner/name:branch.");

// A thread's roll-up of one kind: the distinct entries its live messages
// name, each as its latest live mention wrote it, with the URL of the latest
// that gave one, the most recently mentioned first, at most maxListed, and
// whether any were left out, the least recently mentioned.
export const pullRequestRollup = z
  .object({
    links: z.array(pullRequestLink).max(maxListed),
    truncated: z.boolean(),
  })
  .describe(
    "The distinct pull requests the thread's live messages name, each as its latest mention " +
      "wrote it with the latest URL given, the most recently mentioned first; truncated says " +
      "the least recent were left out.",
  );
export type PullRequestRollup = z.infer<typeof pullRequestRollup>;
export const branchRollup = z
  .object({
    links: z.array(branchLink).max(maxListed),
    truncated: z.boolean(),
  })
  .describe(
    "The distinct branches the thread's live messages name, each as its latest mention wrote " +
      "it with the latest URL given, the most recently mentioned first; truncated says the " +
      "least recent were left out.",
  );
export type BranchRollup = z.infer<typeof branchRollup>;

// What a thread's summary says of its roll-up, which a list row shows: how
// many distinct pull requests and branches its live messages name, and, when
// they name exactly one entry of either kind, that entry, as the roll-up
// lists it.
export const summaryLinks = z
  .object({
    pull_requests: sequence,
    branches: sequence,
    pull_request: pullRequestLink.optional(),
    branch: branchLink.optional(),
  })
  .describe(
    "How many distinct pull requests and branches the thread's live messages name; when they " +
      "name exactly one in all, pull_request or branch is that one, as its latest mention " +
      "wrote it with the latest URL given.",
  );
export type SummaryLinks = z.infer<typeof summaryLinks>;
