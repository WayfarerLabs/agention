# Separate releases: Functional Requirements

- Status: Draft for the operator's acceptance
- Date: 2026-11-22
- Repository: `WayfarerLabs/agention`, which holds this SDD; paths below are relative to its root
- Ownership: the operator owns these requirements. The effort lead owns the HLA, plan and LLDs and
  records operator rulings here verbatim or as close transcription.
- Origin: the operator's direction of 2026-11-22 (ruling 1). Agention as released in 0.6.0 is the
  baseline; this effort's release mechanics land after 0.6.0 ships.

## Why this exists

Agention ships three things: the server (with the web UI it serves), the agent bridge, and the
Claude Code and Codex plugins that run the bridge. Today one version covers all three, so every
release gives the plugins a new version and pins a new bridge, even when only the server changed.
Each operator is then asked to update the plugin, and to restart their agent sessions to pick it up,
or to work out for themselves whether they can skip it.

As the bridge settles, most changes will land in the server alone. Releasing the server separately
from the bridge and plugins means a plugin update always carries a change, and the operator should
never have to work out whether they need one: Agention tells them.

## Who this is for

- **The operator**, the one human, who runs the server and installs the plugin on each agent host,
  and who should be able to keep both current without reading release notes to decide.
- **Agents**, which run whatever bridge their plugin pins and relay what the operator must fix.
- **Maintainers**, who release Agention and need the release process to stay as hands-off as it is
  today: merge a release pull request, and CI publishes.

## Functional requirements

### Release lines

**R1. Two release lines.** Agention releases on two lines, each with its own version: the server
line, which is the `@wayfarerlabs/agention` package and the web UI it serves, and the agent line,
which is the `@wayfarerlabs/agention-mcp` bridge and the Claude Code and Codex plugins. The bridge
and the plugins share one version, and each plugin release runs the bridge of the same version.

**R2. A line releases only when what it ships changes.** A change that affects only the server
releases only the server line; one that affects only the bridge or the plugins (their tools, the
usage skill, the plugin definition) releases only the agent line; one that changes what both share,
such as the API contract, releases both, in the order C2 sets.

**R3. Releasing stays one approval.** As today, merging a release pull request is a release's one
human approval, after which CI publishes what released and nothing else. Each release is tagged and
described as its line's, with a changelog per line.

**R4. Continuity from 0.6.0.** 0.6.0 is the last release covering all three. Both lines continue
from it, so the first release on each line follows 0.6.0 in version order, and nothing an operator
installed at 0.6.0 or earlier stops working because of the split.

### Knowing when to update

**U1. One rule for the operator.** The operator upgrades the server whenever they choose, and
updates the plugin when Agention tells them to. The operator guide says so, and says how to do each.

**U2. The sessions view says when a plugin is behind.** A session's plugin is behind when its bridge
speaks an older agent API version than the server, so the server offers something it cannot use, or
when it is an older release than the newest bridge the server knows of, so a fix has shipped since.
The sessions view marks such a session and says what to do: update the Agention plugin on that
agent's host and restart the session. A session whose bridge is current shows nothing. The operator
API's read of the sessions view carries the same information.

**U3. The agent hears it at registration.** When a session registers, or checks its registration,
with a bridge that is behind in the sense of U2, the answer tells the agent so, in words it can
relay to the operator, without failing the call or holding up the work.

**U4. What reaches which bridge.** The sessions view's mark (U2) covers every released bridge: an
older agent API version is recognized from the version every released bridge already states or,
before the header existed, does not. An older release is recognized for bridges released from this
effort on, which state their release; earlier bridges do not, so they are marked only by their agent
API version. The register answer (U3) reaches agents whose bridge is released from this effort on,
since every earlier bridge writes its register answer itself and relays nothing the server adds.

### An older server

**C1. Old plugins keep working.** A server keeps serving every agent API version from its oldest, as
today, so an operator who upgrades the server and leaves a plugin as it was keeps a working session.

**C2. Release order.** No bridge is released before a server that serves its agent API version is
released, so updating the plugin when Agention says so never strands a session against the
operator's current server, as long as that server is the newest release.

**C3. A newer bridge against an older server fails clearly.** When a bridge meets a server that does
not serve its agent API version, every tool call fails before anything it sent could be dropped
silently, with a message the agent can relay that names the problem and the operator's fix in terms
that hold when the two lines have different versions: upgrade the server to its newest release, or
install an older Agention plugin.

**C4. A failed registration leaves nothing behind.** A session whose bridge is newer than the server
never leaves a pending registration the operator would see and could not match to a code, since the
agent never receives one to relay.

**C5. Tested against real releases.** The behavior of C3 and C4 is proved against every released
server it could meet, installed from npm as an operator would install it, as the agent compatibility
gate today proves every released bridge against the server at HEAD.

### Engineering

**E1. Collateral.** ADR 0001's "one version covers the server, the bridge and the plugins" is
superseded by a new ADR. The architecture document, CONTRIBUTING (releasing, checking a release, the
agent API), the operator guide (installing, upgrading, the sessions view), README and the
development contract describe the two lines.

**E2. Gates follow the lines.** The repository's checks, release workflow and agent compatibility
gate work with each line's tags, and a release refuses a tag that does not match its line's version.

## Out of scope

- Making the bridge a thin proxy that takes its tools from the server, and push (agention#16). This
  effort leaves room for it, and it would make agent-line releases rarer still.
- A bridge that falls back to an older server's agent API version instead of failing (ruling 1).
- A third, separate version for the plugins.
- Updating plugins for the operator, or changing how each agent host installs and updates plugins.
- Telling the operator that the server itself has a newer release.

## Operator rulings, 2026-11-22 onward

1. (2026-11-22) After the effort lead proposed separate release lines, the operator agreed that
   making the bridge a thin proxy (agention#16) would not remove the need: "Users would still see a
   release whenever the server bumps. If that bumps the bridge ane plugins, they'd still have to
   figure out if they need to upgrade. The thin proxy makes it far more likely that they don't but
   the friction and congnitive overhead remain, right?" Asked how to split releases, they chose "Two
   lines": the server on one version, the bridge and plugin sharing another. Asked how users learn
   that the plugin needs updating, they chose "Sessions view and register": the server flags
   sessions whose bridge is behind, and tells the agent once at register. Asked whether to handle a
   newer bridge against an older server now, they chose "Release-order rule only", leaving graceful
   fallback to agention#16, and added: "And ofc the bridge should fail with useful error messages if
   hitting an older server. This effort should ensure that is fully up to snuff and tested." Asked
   when and how, they answered: "After 0.6.0 with a proper design doc, but use the sdd process."
   Taken: R1 and R2, U1 to U3, C2 and C3 to C5, the out-of-scope fallback, and this SDD.

## Definition of done

- Every requirement above is implemented, tested at its boundary, and documented in permanent docs.
- After 0.6.0, at least one release ships on a line alone, and its tag, changelog and npm packages
  are that line's alone.
- A session running a 0.6.0 plugin against a server released after an agent API change is marked in
  the sessions view and told at register, live, on Claude Code.
- The repository passes its documented checks in CI.
