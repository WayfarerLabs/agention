# Operator guide

This guide is for the person who runs an Agention instance. It takes you from nothing to agents
asking what they need and you answering, on a machine of your own with Node.js 24 or later.

To set up an instance:

1. [Install Agention](#installing).
2. [Give it an HTTPS origin](#giving-it-an-https-origin), the address you and your agents reach it
   at.
3. [Run the server](#running-the-server) in a terminal to try it, then
   [as a service](#running-it-as-a-service).
4. [Register your first passkey](#signing-in) and sign in.
5. [Connect your agents](#agents): install the plugin where they run, and
   [approve each session](#approving-agents) as it registers.
6. [Back it up](#backing-up), and read [Upgrading](#upgrading) before your first upgrade.

[Voice](#voice), to dictate your replies, [API keys](#api-keys), for programs of yours that read or
answer Agention as you, and delivering the [audit log](#audit-log) to your log tooling are optional.
[Commands](#commands) lists every command.

Two pages go further: [The web UI](web-ui.md) describes the views control by control, and
[Operator API](operator-api.md) says how your programs call Agention.

## Installing

Install Agention as the user that will run the server:

```bash
npm install -g @wayfarerlabs/agention
agention version
```

`agention version` prints the version installed.

If `npm install -g` fails for want of permission, npm's global prefix (`npm prefix -g`) is a system
directory. Rather than use `sudo`, run `npm config set prefix ~/.local` and put `~/.local/bin` on
your `PATH`.

## Giving it an HTTPS origin

The origin is the address in the browser's location bar, such as `https://agention.example.com` or
`https://agention.example.com:8443`: `https`, a domain name, and a port only when it is not 443.
You, on every device you sign in from, and every machine your agents run on must be able to reach
it.

- **It cannot be an IP address**, since browsers refuse passkeys for one. With only an IP address,
  give it a name, such as a DNS record pointing at it; the address may be private.
- **Choose it once.** Passkeys belong to the origin's host and agent tokens name the origin, so
  changing the host later needs new passkeys, and changing the origin at all needs every agent's
  `AGENTION_URL` changed to match.

Serve it in either of two ways:

- **Behind a TLS terminator**, the default. The server listens on loopback with plain HTTP, and a
  terminator you run publishes it at the origin over HTTPS: a reverse proxy such as Caddy or nginx,
  or, on a [Tailscale](https://tailscale.com) network,
  [`tailscale serve`](#publishing-it-with-tailscale-serve), which needs no certificate of your own.
  The terminator must pass the request's `Host` through unchanged: the server answers only requests
  whose `Host` is the origin's host, with its port when that is not 443, and reads no forwarded
  headers.
- **Terminating TLS itself.** Give `agention serve` the certificate and its key with `--tls-cert`
  and `--tls-key`, and listen on any address with `--listen`. The server accepts TLS 1.3 only.

Either way, your browsers and your agents' machines must trust the certificate: one from a public
authority, or from a private one each of them trusts, which for agents `NODE_EXTRA_CA_CERTS` sets
([Agents](#agents)).

Plain HTTP on an address other than loopback would carry agent tokens and browser cookies in the
clear, so the server refuses to start that way unless `--allow-plain-http` is given. Use it only
when the network path is already encrypted.

Anything that can reach the origin reaches the sign-in page, the agents' API and the operator API.
Passkeys, approved agent keys and API keys keep it from acting, but it can still delay new agent
registrations, as [SECURITY.md](../SECURITY.md#security-model) says. A private network, such as a
VPN or a tailnet, keeps the server to your own devices. An agent's machine that cannot connect to
the origin can reach it [through a tunnel](tunnel.md) from the server's machine.

### Publishing it with `tailscale serve`

On a Tailscale network, `tailscale serve` publishes the server over HTTPS at the machine's name in
your tailnet, with a certificate Tailscale provisions. Publish the server's default listener,
`127.0.0.1:8080`:

```bash
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Each prints the address Tailscale serves the server at, such as `https://agention.example.ts.net`.
That address, without a trailing slash, is the server's origin; until the server runs, it answers
with an error. `--bg` keeps it serving across restarts of Tailscale and of the machine, until you
run the same command with `off` at its end. The first time, `tailscale serve` may send you to a page
to enable HTTPS certificates for your tailnet.

- On Linux, run these commands with `sudo`, unless `sudo tailscale set --operator=$USER` made you
  Tailscale's operator.
- On a Mac, the Tailscale app does not put `tailscale` on your `PATH`.
  [Tailscale's CLI documentation](https://tailscale.com/docs/reference/tailscale-cli) says how to
  run it for each variant of the app.

This keeps Agention within your tailnet: only its devices can reach it, as your tailnet's access
rules allow. Tailscale Funnel would publish it to the whole internet; Agention does not need it.

## Running the server

```bash
agention serve --data ~/.local/share/agention --origin https://agention.example.com --name Work
```

| Option                     | Meaning                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--data DIR`               | The data directory, which holds the database, `agention.db`; required                                                    |
| `--origin URL`             | The HTTPS origin people and agents reach the server at; required                                                         |
| `--listen ADDR`            | The IP address, never a name, and port to listen on, by default `127.0.0.1:8080`; IPv6 goes in brackets, as `[::1]:8080` |
| `--tls-cert FILE`          | The TLS certificate chain, in PEM, for the server to terminate TLS itself                                                |
| `--tls-key FILE`           | The certificate's private key, in PEM; give both TLS options or neither                                                  |
| `--allow-plain-http`       | Allow plain HTTP on an address other than loopback                                                                       |
| `--quiet-minutes N`        | Minutes, 1 to 10,080, after which a session not seen is quiet; 15 by default                                             |
| `--name NAME`              | The server's name, 1 to 40 characters on one line, set by its first start                                                |
| `--api-docs`               | Serve the API's documentation, without sign-in, under `/docs/api/`, for [writing programs against it](operator-api.md)   |
| `--audit-stdout`           | Deliver the [audit log](#sinks) to standard output                                                                       |
| `--audit-dir DIR`          | Deliver the audit log to files in `DIR`                                                                                  |
| `--audit-group NAME`       | Share `--audit-dir` with a group, for a collector that runs as its own user                                              |
| `--audit-keep-days N`      | The renamed audit files to keep, 1 to 3,650; 30 by default                                                               |
| `--audit-retention-days N` | Days, 1 to 36,500, to keep audit events, or 0 to keep them forever; 365 by default                                       |

[Giving it an HTTPS origin](#giving-it-an-https-origin) says when to set `--listen` and the TLS
options. Three optional environment variables
[supply voice's settings](#voice-from-the-environment).

The name is set for good by the first start that serves: `Agention`, unless `--name` gives another.
A start that fails before it serves, such as on a port already in use, sets nothing. Later starts
may leave `--name` out or repeat it, and refuse any other. The name is the web UI's title, and your
passkeys carry it (**Work · operator**).

Run one server per database: a second one on the same database would remove the uploads still
arriving at the first as abandoned. Give a second server, say a personal one beside one for work,
its own data directory and `--name`. Two can share a host, under different ports, without signing
each other out.

A session is seen each time its agent calls the server. One not seen within `--quiet-minutes`, plus
the minute that may take to show, or never seen, is quiet: it has stopped, or is busy elsewhere. A
thread is **stranded** when its agent has not read your latest messages and its session is quiet,
stopped or without an active credential. A session that reports it stopped says how, as
**completed**, **withdrawn** (you called it off) or **stalled** (it cannot go on), and stays stopped
until it reports working or idle. An idle session that writes to its threads without reporting a
state or note, by a message, a new thread, or marking one read, unread or archived, is working from
then on: the server marks it so itself and logs that it did, with no note. Checking for your answers
changes nothing, and neither does anything you write.

The data directory and the database must be private to the user running Agention, under the rule in
[SECURITY.md](../SECURITY.md#private-files). `agention serve` creates a missing data directory, and
any missing directory above it, private whatever the umask. Until the rule holds, it refuses to open
the database and says what to change, such as `chmod go-w ~` for a home directory its group can
write. It never changes the permissions of a path that exists.

Try the server in a terminal first, with your own origin and name. Once it listens, it says so:

```text
agention: serving https://agention.example.com on http://127.0.0.1:8080
```

It logs to standard error. To keep the log in a file only you can read, start it under a umask of
077, and follow it from another terminal with `tail -f ~/agention.log`:

```bash
(umask 077; agention serve --data ~/.local/share/agention --origin https://agention.example.com --name Work 2>>~/agention.log)
```

Ctrl-C (`SIGINT`) or `SIGTERM` stops it: it ends the requests agents have waiting, finishes the
others and exits within a few seconds. Closing the terminal stops it too. `tmux` or `screen` keeps
it running after that, until the machine restarts, but a service is the better way.

### Running it as a service

A service starts the server for you, restarts it if it fails, and stops it cleanly with `SIGTERM`.
It runs with a minimal `PATH`, so it names `node` and `agention` by absolute path. In the shell you
installed Agention from, print the two:

```bash
node -p process.execPath
echo "$(npm prefix -g)/bin/agention"
```

In the examples below, put your own paths, origin and name in place of `/usr/local/bin/node`,
`/usr/local/bin/agention`, `https://agention.example.com` and `Work`; a server that has already run
keeps its name, so give the name it has or leave `--name` out. Under a version manager both paths
change with the Node.js version: after changing it, install Agention again and update them. Stop a
server you started by hand before you start the service: both listen on the same address, so the
service would fail to bind it and keep retrying.

#### Linux: a systemd user unit

Save this as `~/.config/systemd/user/agention.service`, where systemd reads `%h` as your home
directory:

```ini
[Unit]
Description=Agention server

[Service]
ExecStart=/usr/local/bin/node /usr/local/bin/agention serve --data %h/.local/share/agention --origin https://agention.example.com --name Work
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Then start it, and have it start whenever the machine does:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agention
loginctl enable-linger
```

Your user's services start when you log in and stop when your last session ends;
`loginctl enable-linger` starts them at boot instead, with no login. It may ask you to authenticate,
or need `sudo loginctl enable-linger "$USER"`.

- `systemctl --user status agention` shows whether the server is running.
- `journalctl --user -u agention` shows its log, which `-f` follows.
- `systemctl --user stop agention` stops it, and ends the retries of a server that keeps failing,
  whose log says why.

#### macOS: a launchd agent

This setup has not been tested yet; the Linux one has.

Save this as `~/Library/LaunchAgents/com.wayfarerlabs.agention.plist`, with your home directory in
place of `/Users/you`, since launchd expands neither `~` nor variables:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.wayfarerlabs.agention</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/bin/agention</string>
    <string>serve</string>
    <string>--data</string>
    <string>/Users/you/.local/share/agention</string>
    <string>--origin</string>
    <string>https://agention.example.com</string>
    <string>--name</string>
    <string>Work</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/agention.log</string>
</dict>
</plist>
```

Then load it, which starts it:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wayfarerlabs.agention.plist
```

A launch agent runs while you are logged in to the Mac, starting at each login, and launchd starts
the server again if it exits with an error.

- `launchctl print gui/$UID/com.wayfarerlabs.agention` shows the server's state.
- `~/Library/Logs/agention.log` is its log, which `tail -f` follows. launchd appends to it and never
  rotates it.
- `launchctl bootout gui/$UID/com.wayfarerlabs.agention` stops it and unloads it, and
  `launchctl bootstrap`, as above, loads and starts it again.

## Signing in

You sign in to the web UI with a passkey, in a browser with WebAuthn's JSON helpers: Safari 18.4,
Chrome or Edge 129, Firefox 119, or later. An older browser says it cannot sign in.

To register your first passkey, run `agention passkey-link` on the server's machine, as the user
that runs the server, with the server's `--data` and `--origin`:

```bash
agention passkey-link --data ~/.local/share/agention --origin https://agention.example.com
```

Open the link it prints within 15 minutes, in the browser you want to sign in with. The page asks
you to name and create a passkey, then signs you in.

- **Keep the link as private as a password.** It works once, and whoever opens it first registers
  their own passkey. A new link revokes any unused earlier one.
- **The first link also creates you as the operator**, named `operator` unless you give
  `--operator-name`: 1 to 63 of `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. The name
  labels the messages you write.

You can hold up to 20 passkeys, one for each device. In **Settings**, under **Passkeys**, you:

- **Add a passkey** on the device in hand. For another device, sign in there with a passkey you
  hold, through the browser's cross-device sign-in (a QR code your phone scans), then add the
  device's own passkey in its Settings. A device that cannot needs `agention passkey-link`, which
  replaces every passkey, as below.
- **Rename a passkey** at any time.
- **Remove any passkey but your last**, which signs out every browser it signed in.

Adding or removing a passkey needs a sign-in within the last 10 minutes, as do changes to API keys
and voice; Settings offers to sign in again while yours is older.

To replace your passkeys, after losing your devices for example, run `agention passkey-link` again.
Using the new link replaces all your passkeys with the one it registers, signs out every browser and
revokes every API key, since whoever held the old passkeys could have created keys. Create again the
keys your programs still need.

Passkeys must verify you, with a PIN or biometric, and be stored by the authenticator, so signing in
asks for no name: open the origin and choose **Sign in with a passkey**. A browser session lasts 30
days, or seven days without use, or until you **Sign out** in **Settings**. When it ends, the page
you open next, or have open, returns to sign-in and comes back afterwards.

## Agents

Agents reach Agention through the agent bridge, `agention-mcp`, a standard MCP server that the
agent's harness starts for each session, so any harness that speaks MCP can use Agention. To connect
your agents on Claude Code or Codex, [install the plugin](#installing-the-plugins) where they run
and give the bridge the server's origin; on anything else,
[add the bridge yourself](#other-harnesses). Each session then registers and waits for your
approval. The bridge needs Node.js 24 or later, and reads its settings from the environment the
agent host gives it:

| Variable              | Meaning                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTION_URL`        | The server's origin, spelled as `--origin` gives it; required                                                                      |
| `AGENTION_CONNECT`    | A host and port to connect to in place of the origin's, such as a tunnel's; optional                                               |
| `AGENTION_AGENT`      | The agent's name, unless the agent's `register` call gives one                                                                     |
| `AGENTION_SESSION`    | The session's name, unless the agent's `register` call gives one; set by whatever starts each session, so each session has its own |
| `NODE_EXTRA_CA_CERTS` | Node's own setting: a file of certificate authorities to trust, for a server with a private one                                    |

Names are 1 to 63 of `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. The bridge also
reads `AGENTWORKS_AGENT` and `AGENTWORKS_SESSION`, which Agentworks sets, for a name whose
`AGENTION_` variable is unset or empty. The bridge refuses to work while
`NODE_TLS_REJECT_UNAUTHORIZED` is `0`, which would let its tokens cross TLS that Node has not
verified.

### Installing the plugins

Install the Agention plugin on each machine where your agents run, from the plugin marketplace in
Agention's repository. Pin the marketplace to a release's tag, so the plugin's skill describes
exactly the bridge it runs. Between releases, `main`'s skill can describe what its pinned bridge
does not do yet, so install from `main`, unpinned, only to follow changes as they merge.

To pin it to a release, the latest in this example, in Claude Code:

<!-- x-release-please-start-version -->

```bash
claude plugin marketplace add WayfarerLabs/agention#v0.8.0
claude plugin install agention@agention
```

In Codex:

```bash
codex plugin marketplace add WayfarerLabs/agention --ref v0.8.0
codex plugin add agention@agention
```

<!-- x-release-please-end -->

To install from `main` instead, leave the tag out of either command.

Sessions started after that have the plugin. It carries the skill that tells an agent how to use
Agention, and runs the bridge with `npx` at the version it pins, which npm fetches the first time.
With the plugin, an agent:

- asks you everything through Agention, never waiting at its terminal;
- shows at its terminal whatever it sends you in Agention, so you can follow either;
- takes what you write in Agention as it takes what you type at its terminal, and brings its threads
  in line with what you tell it at its terminal;
- keeps checking for your answers while any are open.

Then give the bridge the server's origin in `AGENTION_URL`. Set in your shell profile, such as
`~/.bashrc` or `~/.zshrc`, it reaches the bridge in either host started from that shell: Claude Code
gives the bridge its whole environment, and Codex a few common variables and those the plugin lists,
the bridge's settings among them.

```bash
export AGENTION_URL=https://agention.example.com
```

Claude Code also passes the `env` of its
[settings](https://code.claude.com/docs/en/settings-reference#env) to the processes it starts, so
`"env": { "AGENTION_URL": "https://agention.example.com" }` in `~/.claude/settings.json` works
without a shell profile.

When the bridge can't work, because a setting is missing or wrong or the server can't be reached,
the agent tells you at its terminal what to change. The host gives the bridge its settings when the
session starts, so after changing one, restart the session from a shell that has the change (a new
terminal, after editing a shell profile). Resuming it, with `claude --continue` or
`codex resume --last`, keeps its conversation.

An agent host limits how long one tool call may take, and a large file on a slow link can take
longer. The Codex plugin raises Codex's limit for the bridge's tools from its default of one minute
to 10. Claude Code's default is long enough; if you set `MCP_TOOL_TIMEOUT`, in milliseconds, make it
long enough too.

### Other harnesses

A harness without an Agention plugin runs the same bridge. It must be able to start a local MCP
server over standard input and output, one process for each agent session, on a machine with Node.js
24 or later that can reach your server. Add this command to its MCP servers under the name
`agention`, at your server's release, with `AGENTION_URL` in the environment the harness gives it:

<!-- x-release-please-start-version -->

```bash
npx -y @wayfarerlabs/agention-mcp@0.8.0
```

[skill]:
  https://github.com/WayfarerLabs/agention/blob/v0.8.0/apps/agent-plugin/skills/agention/SKILL.md

<!-- x-release-please-end -->

Then give the agent the usage skill the plugins carry, [`SKILL.md`][skill] at the same release, as a
skill or as instructions. The bridge's tools describe themselves, but the skill is what tells an
agent to ask you through Agention and to keep checking for your answers.

If the harness limits how long one tool call may take, the limit must be at least a minute, and
longer for large files, as [Installing the plugins](#installing-the-plugins) says. Claude Code and
Codex are the harnesses Agention is tested on; no other has been tried.

### Session keys

An agent's first call to Agention registers its session, with the bridge's `register` tool. The
first time, the bridge makes a key for the session, keeps it in
`~/.config/agention/<server>/<agent>/<session>/key.pem`, and gives the agent a code, such as
`7KQ2M-X9D4R`, to relay to you. The session then waits for you to [approve it](#approving-agents) by
that code. After you reject or revoke a session's key, its next `register` call makes a new key with
a new code.

The key file must be private to the agent's user, under the same
[rule](../SECURITY.md#private-files) as the server's database. That user's home directory must
exist; the bridge creates only the directories below it. Until the rule holds, the bridge's tools
answer with what to change, such as `chmod go-w ~`. The bridge changes nothing that exists.

Sessions of one operating-system user can use each other's keys, so run agents that must not act as
each other as different users. [SECURITY.md](../SECURITY.md#the-agent-bridge) says what the bridge
keeps and sends.

### Reaching the server through a tunnel

A machine where agents run that accepts connections but cannot open one to the server can reach it
through an SSH reverse tunnel from the server's machine, with the tunnel's port in the bridge's
`AGENTION_CONNECT`. [Reaching the server through a tunnel](tunnel.md) describes the setup.

## Approving agents

A session that registers appears as a row under **Waiting for approval**, at the top of
**Sessions**, named by the agent and the session it proposes and marked as a new agent, a new
session, or an existing session. Choosing the row opens its page, beside the sessions' rows on a
desktop's screen and on its own on a phone: its code, such as `7KQ2M-X9D4R`, in large type, then
what it proposes, with the credentials of an existing session it proposes, whose name opens that
session, and when it was submitted and when it expires. Approve it only if the code matches the one
the agent relayed to you: a registration made with any other key shows a different code. A
registration not decided within an hour expires.

**Approve** grants the credential the agent and the session it proposes, as its **Approve grants**
line says, and opens that session. **Change agent or session** shows the other choices: an agent and
a session, each existing or new, under the names the agent proposed or others you type. Approving
onto an existing session grants its whole history and lets the credential act as the session, so do
that only to replace a credential an agent lost. When the proposed session already exists, as when
an agent that lost its credential registers again, nothing is chosen for you: **Approve as**
followed by the session's name grants that session, with the warning about its history, and
**Approve as a new session** grants a new one under the name above it, which you can change; Enter
in a field grants the new one. That session's own row also says **Registration waiting**, leading to
the request. **Group** and **Tags** open the pickers that
[Groups and tags](web-ui.md#groups-and-tags) describes, and what you choose there is applied with
the approval, not before; a group you create in the picker is created as you pick it. What you leave
unpicked stays as it is: a new session has no group or tags, and an existing one keeps its own,
which the pickers start from once you choose it. When the proposed session already exists, the
pickers start from its own group and tags, and either button gives the session it approves what they
show: **Approve as** keeps them as shown for that session, and **Approve as a new session** gives
the new session the same. Choosing another session or another agent, or naming the new agent
otherwise, starts your choices over; a new session keeps them however you name it. **Reject**,
beside **Approve**, refuses a registration and returns to the rows. While an approval or a rejection
is on its way, neither can be sent again.

**Revoke**, in a session's options or under **Credentials and past requests**, ends an approved
credential at once. The session and its threads stay for you to read, answer and archive. The
session shows that it has no active credential until you approve another registration for it, and
its threads holding a message of yours it has not read are stranded.

## Using the web UI

The web UI has four views:

- **Threads** lists every thread you have not archived, the most pressing first: those with asks
  open to you lead, by priority, then by whether they block the agent's work. You can sort, group,
  filter and search it, by pull request and branch among the filters, and select several threads to
  mark or archive together. The page's address keeps what you chose, so a bookmark reopens it. On a
  desktop's screen the list stays beside the thread you open.
- **A thread** reads like an email. Each ask is a card you answer on, by picking its suggested
  answers, writing your own words or declining. You can edit what you sent, attach files, and
  archive what you are done with; a thread you archived comes back when its agent writes again.
- **Sessions** shows every agent and session with what it reports, holds the registrations
  [waiting for your approval](#approving-agents), and is where you sort sessions into groups and
  give them tags. On a desktop's screen the sessions' rows stay beside the session you open.
- **Settings** holds your passkeys, [API keys](#api-keys), your
  [groups and tags](web-ui.md#groups-and-tags), [voice](#voice), storage and the
  [keyboard shortcuts](web-ui.md#keyboard-shortcuts).

[The web UI](web-ui.md) describes the first three control by control, and the keyboard shortcuts.

### Adding it to a phone or a desktop

You can install the web UI as an app, which opens in a window of its own, without the browser's
address bar, from an icon on your phone's home screen or your desktop. Open the server's origin in
the browser, then:

- **Android, in Chrome:** open the menu and choose **Add to home screen**, then **Install** rather
  than a shortcut; some versions name the menu's item **Install app**.
- **A desktop, in Chrome or Edge:** open the menu and choose the item that installs the page as an
  app (Chrome lists it under **Cast, save, and share**, Edge under **Apps**).

The browser may not offer to install it on its own, but its menu can. The app carries the server's
name, so a work server and a personal one installed on one device are told apart, and each server's
origin installs as an app of its own. It is the same web UI, signed in as the browser is, and loads
the server's current UI each time it opens, so it needs no upgrading of its own. Safari on an iPhone
or iPad adds it from **Share**, **Add to Home Screen**, which is untested.

## Attachments

You and your agents can attach files to messages. A file belongs to the message that brought it,
under its name, for good. Editing the message carries its files to the new version unless you remove
them, and the earlier version keeps them too.

Wherever you write and send a message, a thread's composer or a new thread's sheet, **Attach**, the
paper clip beside **Send**, opens your device's file picker. On a phone or a tablet it opens a menu
instead: **Take a photo** and **Record a video** open the camera, **Photos and videos** your
device's library, and **Other files** documents such as PDFs, office files and archives. A laptop
with a touch screen keeps the file picker. Pasting an image into the message box or **Details**
attaches it, named by when you pasted it, such as `pasted-20261122-143005.png`; a paste that carries
text, as from a spreadsheet, pastes the text.

Each file uploads as soon as you add it, one at a time. **Remove** takes a file off the message and
the server; **Retry** sends again one that failed, and **Upload again** one the server no longer
holds. **Send** waits until every file has uploaded. A message may be files alone. A file you upload
and never send is removed from the server when you go to another of Agention's pages or close the
sheet without sending it; one left by closing or reloading the tab, or whose removal fails, the
server removes a day later.

Every file can be downloaded. An image up to 2 MiB shows at once, a larger one behind **Show
image**. Video and audio play in the page, loading nothing until you play them. Text, code and logs
show their first 256 KiB behind **Show text**, which says when there is more. A PDF opens in a new
tab, in the browser's viewer. Anything else downloads. A file whose bytes are gone shows as
**Missing**. Media does not play in a tab of its own, as from a context menu's **Open video in new
tab**: a file opened on its own runs without your sign-in, for the reasons in
[SECURITY.md](../SECURITY.md#attachments), so play it in the page or download it.

A message's text can link to one of its own files as `[the log](attachment:build.log)`, or
`[the log](<attachment:build log.txt>)` for a name with spaces, which opens it as its entry does.
**Files** in the thread's head, folded on every visit, lists the files the thread's current messages
carry, newest first, each with who attached it, when its message was written, and a link to that
message. A file that only the earlier version of an edited message carries stays on that version,
and leaves the thread's files and their count.

The limits:

- A file is at most 100 MiB, and a message carries at most 10.
- An upload has no time limit while its bytes keep moving, but stops after 30 seconds without any.
- The server refuses an upload, saying its disk is too full, unless the disk holding its data
  directory keeps 1 GiB free beyond the files arriving.
- You, with whatever your API keys upload, and each agent session, can hold at most 20 files, and 1
  GiB, uploaded and not yet sent. A file you remove, or leave unsent by going to another page or
  closing the sheet, stops counting at once. One never sent and never removed is removed a day
  later, so a program of yours that uploads files and never sends them can use up your share until
  then.

Agention changes nothing in a file, so a photo keeps what its camera recorded, its location
included, and an agent that fetches it can read that. Remove the location before attaching a photo
you would not share it with, or turn it off in the camera.

**Settings** shows, under **Storage**, how much space attachments take, in how many files. Files
live in the database, so every backup copies them all ([Backing up](#backing-up)). A browser caches
the files it showed for up to a year, after sign-out too, so on a shared device clear its data for
the server's site.

Agents attach a file with the bridge's `file_upload` tool, by its path on the agent's machine. The
bridge sends only a regular file of up to 100 MiB, and never a file in its own key directory. Each
upload is one request of the session's [rate budget](#rate-budgets), and one the budget refuses says
how many seconds to wait, which the tool tells the agent to do before trying again; what you upload
in the web UI spends no budget.

Agents fetch a file a message carries with `file_get`, into `~/.cache/agention/files/`, private to
the agent's user, named by the file's reference, not its sender's name. It removes what it fetched
more than a week ago, and you may clear the directory at any time. A fetched PNG, JPEG, GIF or WebP
image of up to 3.5 MiB also reaches the agent's model as an image; any other image reaches it by its
path alone. Given an image it cannot read, such as one whose bytes are broken, Claude Code leaves
its note in its place, and the call still succeeds.

## Voice

Voice lets you dictate a message instead of typing it, and is off until you set it up. Wherever you
write one, in a thread's composer, an ask's **Notes** or a new thread, **Dictate** puts what you say
in the box you were last in. You choose a transcription provider in **Settings**, under **Voice**;
the server sends it each recording, with a key it holds, and returns only the text.

- **The provider receives your recordings**, so turning voice on means choosing who does, under
  their terms.
- **Agention keeps neither the recording nor the text**, and agents never see either: they read only
  what you send.
- **Reading a message aloud needs none of this**: the browser speaks on your device.

**Set up** shows the form:

- **Provider**: **OpenAI** or **Groq**, each filling in its base URL and model, or **Your own
  server**, any service speaking the OpenAI-compatible transcription API, such as a Whisper server
  on your own network.
- **Base URL**: the address the API is under, such as `https://api.openai.com/v1`; the server sends
  recordings to `audio/transcriptions` beneath it.
  - It must use `https`, unless it is `localhost` or an IP address on your own network (loopback, a
    private range, a tailnet's `100.64.0.0/10` or a unique local IPv6 address), which may use plain
    `http`. Your key and your recordings then cross that network unencrypted, and Settings say so.
    `tailscale serve` can put a local server behind `https` instead.
  - It carries no user name, query or fragment. The server follows no redirect: a provider that
    answers with one fails, saying it tried to redirect, so give the address it redirects to
    instead. It never reaches the addresses [SECURITY.md](../SECURITY.md#voice) rules out.
- **Model**: as the provider names it, such as `gpt-transcribe` or `whisper-large-v3-turbo`.
- **Additional context**: optional, up to 500 characters of background the transcription can use,
  such as what you talk about, names and terms. Whisper models read only its last 224 tokens, so a
  long context can lose its start. A transcript that only repeats the context, as Whisper sometimes
  answers silence, says **Nothing heard**.
- **Key**: the provider's key, up to 1,024 characters. OpenAI and Groq need one; your own server may
  not. The server keeps it and never shows it whole again: only its last four characters, or none of
  a key shorter than 16. A key goes only to the base URL it was entered for, so changing the base
  URL clears it, for you to enter again.

Below the form, Settings link to what OpenAI or Groq say about keeping your recordings and training
on them. Once voice is on, **Try it** records a few words and shows the text, through the same path
dictation takes, and **Turn off** deletes the settings and the key. Saving and turning off need a
sign-in within the last 10 minutes.

Settings saved by an earlier release that the rules now refuse show as no longer valid, and voice
ignores them until you clear them, with **Clear saved settings**, or save new ones.

A recording is at most five minutes, and must reach the server within 30 seconds, which for five
minutes takes about 330 kbit/s of upload; a slower connection fails, with the recording kept for a
retry. The provider has a minute to answer.

### Voice from the environment

The server can also take the base URL, the model and the key from its environment, each as if
entered in Settings, under the same rules:

| Variable                       | Supplies     |
| ------------------------------ | ------------ |
| `AGENTION_TRANSCRIPTION_URL`   | The base URL |
| `AGENTION_TRANSCRIPTION_MODEL` | The model    |
| `AGENTION_TRANSCRIPTION_KEY`   | The key      |

`agention serve` reads them once, at start, and refuses to start on:

- **A value that breaks the rules**, with a message that names the variable and never shows the
  value. An empty value is such a value, not the variable left unset, so delete a line rather than
  blank it.
- **`AGENTION_TRANSCRIPTION_KEY` without `AGENTION_TRANSCRIPTION_URL`**, so a key from the
  environment only goes to an address from it.

What the environment supplies, Settings can neither change nor turn off. Voice is on while a base
URL and a model are both in effect, from either source, so **Turn off**, which deletes what Settings
saved, turns voice off only when one of the two was saved there. To turn off what the environment
supplies, remove its variables, turn off anything Settings saved, and restart the server; a start
with `AGENTION_TRANSCRIPTION_KEY` still set and `AGENTION_TRANSCRIPTION_URL` removed is refused, as
above. A key saved in Settings is used only while the base URL in effect is the one it was entered
for, so a new `AGENTION_TRANSCRIPTION_URL` leaves it unused until you enter it again. Settings show
what the environment supplies as set there, the key masked as a saved one is. With both the base URL
and the model from the environment, **Turn off** reads **Clear saved settings**.

Keep the variables in an environment file only you can read, not in the unit or the plist itself,
each value in single quotes:

```bash
mkdir -p ~/.config/agention
(umask 077; cat >~/.config/agention/voice.env) <<'END'
AGENTION_TRANSCRIPTION_URL='https://api.openai.com/v1'
AGENTION_TRANSCRIPTION_MODEL='gpt-transcribe'
AGENTION_TRANSCRIPTION_KEY='your-key'
END
```

With systemd, add `EnvironmentFile=%h/.config/agention/voice.env` to the unit's `[Service]` section,
and run `systemctl --user daemon-reload` and `systemctl --user restart agention`.

launchd has no environment file, so have the plist start a shell that reads the file and then runs
the server: its `ProgramArguments` become these three strings, with your paths, origin, name and
home directory. Then `bootout` and `bootstrap` it again
([macOS: a launchd agent](#macos-a-launchd-agent)). Like the rest of the launchd setup, this is
untested.

```xml
<string>/bin/sh</string>
<string>-c</string>
<string>set -a; . /Users/you/.config/agention/voice.env; exec /usr/local/bin/node /usr/local/bin/agention serve --data /Users/you/.local/share/agention --origin https://agention.example.com --name Work</string>
```

## API keys

An API key lets a program you run, such as a tool that already shows your agents, call the operator
API as you, within the scopes you give it. You create and revoke keys in **Settings**, under **API
keys**. **Create an API key** asks for:

- **Name**: up to 50 characters on one line, such as the program that will hold the key.
- **Scopes**: what the key may do, as you, at least one of them:

  | Scope               | What it grants                                                                                                                                                                                                                                                                                       |
  | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `threads:read`      | Reading the thread list and its counts, the threads above and below one in it, any thread with its messages and its files, and waiting for new messages in any session                                                                                                                               |
  | `threads:write`     | Also starting threads, writing in them, answering asks, uploading files to attach and removing those not yet sent, and marking threads read, unread or archived, one at a time or in bulk                                                                                                            |
  | `sessions:read`     | Reading the sessions view with its agents, groups and tags, each session's log, and agents' registrations                                                                                                                                                                                            |
  | `sessions:write`    | Also marking a session's log read, and managing groups and tags: creating, renaming, recoloring, ordering and removing groups, creating, renaming, recoloring and removing tags, a tag's rename reaching the saved views naming it, and setting a session's group and an agent's or a session's tags |
  | `sessions:approve`  | Also approving, rejecting and revoking agents' registrations; with `sessions:write` too, an approval can also set the session's group and tags                                                                                                                                                       |
  | `saved-views:read`  | Reading your saved views, each with its thread list                                                                                                                                                                                                                                                  |
  | `saved-views:write` | Also saving, renaming, replacing and removing saved views                                                                                                                                                                                                                                            |

  A write or approve scope includes its resource's read; `sessions:write` and `sessions:approve`
  include neither the other. `sessions:approve` lets whoever holds the key let an agent into your
  sessions, where it writes to you as any agent does, so give it only to a program that decides
  registrations for you. No key, whatever its scopes, can manage keys, passkeys or Settings, Storage
  among them, or dictate: those need your passkey.

- **Expiry**: 7, 30 (the default), 60 or 90 days; a date you choose, up to a year away, through
  whose end the key works; or no expiry. A key without an expiry works until you revoke it, so if it
  leaks, whoever holds it acts as you, within its scopes, until you notice. Choose an expiry unless
  the program truly needs a key that lasts.

**Create key** then shows the key, `agention_` and 43 more letters, digits, `-` and `_`, once. The
server keeps only a hash and can never show the key again, so keep it as you would a password, in
your password manager or the program's secret store. If you lose it, revoke it and create another.

The list shows when each key was last used, to within an hour, and flags a live key that has no
expiry. A revoked or expired key stays listed, marked so, until you next create or revoke a key.

**Revoke**, which asks first, ends a key at once: the program's next request is refused, and so is a
wait it holds. Creating and revoking a key need a sign-in within the last 10 minutes. You can hold
up to 20 keys that are neither revoked nor expired. Replacing your passkeys with a new passkey link
revokes every key ([Signing in](#signing-in)).

[Operator API](operator-api.md) says how a program calls it, and where its reference is.

## Audit log

The server records every change made to it in an audit log: each write, sign-in and credential
change, which credential made it, from where, and when. The log lives in the database, written with
each change in the same transaction, so a change is never saved without its event. The server can
also deliver it to standard output and to files, for the log pipeline or security tooling you
already run.

### What it records

- **Every write**, on the web UI, the operator API and the agent API: starting threads, messages and
  answers, archiving, files uploaded and removed, groups and tags and their assignment, saved views,
  a session's status updates, voice settings set and cleared, and the decisions on agents'
  registrations. Marking threads read or unread and marking a session's log read are not recorded.
- **Sign-ins**: a passkey's sign-in, a sign-out, and a passkey link's use, with the browser sessions
  each ended. A failed sign-in or link is recorded with no one as its actor.
- **Credentials**: an API key created, revoked, or revoked by a passkey link, and its first use; a
  passkey added, renamed, removed, or replaced by a link; an agent's registration submitted,
  approved, rejected, or revoked; a link issued by `agention passkey-link`; and a sink forgotten by
  `agention audit forget-sink`.
- **Refused API keys**: a key the server knows, refused as revoked or expired, or for lacking an
  operation's scope. A key the server does not know records nothing. The answer the program gets is
  the same as before. A key refused partway through a download, which cuts the download short, is
  recorded with no answer status, since the program had already been answered.

Each event names its credential by an id that is not secret: a browser session by its own id and the
passkey that signed it in, an API key by its id and name, and an agent by its registration's id,
with its agent and session. It names what was acted on by id, with the names you and your agents
chose for agents, sessions, groups, tags, saved views, keys, and passkeys. It names a thread by its
agent, session and number, never its title, a file by its id, never its name, and a saved view by
its id and name, never its list. No event holds a message's or an answer's text, a file's bytes, a
transcription, or any secret.

The address recorded is the connection's peer. Behind `tailscale serve` or a platform's router that
is the proxy's address, often the loopback, since the server reads no forwarded header. The user
agent is kept to 256 characters.

Not recorded: reads, the audit log's own included; transcriptions; the server's own housekeeping,
such as a session's idle expiry moving on, a key's hourly last use, or the upload sweep; and failed
agent authentication.

Anyone who can reach the server can cause failed sign-ins, so failures are counted rather than
recorded one by one: the first failure of a kind in a minute, per key for a key's refusals, records
an event, and each later one in that minute raises its `count` and moves its `end_time` on. Only
failures within the [rate budgets](#rate-budgets) are counted.

### The format

Each event is one JSON object in the [Open Cybersecurity Schema Framework](https://schema.ocsf.io/)
(OCSF), version 1.9.0, which Splunk, Datadog, Google SecOps and AWS Security Lake read natively and
any other SIEM or collector can query as JSON. Writes are API Activity (`class_uid` 6003), sign-ins
and refused keys Authentication (3002), and API keys, passkeys, registrations and links Entity
Management (3004). Fields worth knowing:

| Field                               | Holds                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `metadata.event_code`               | The action, under its stable name, such as `archiveThread` or `signIn`      |
| `metadata.uid`                      | The event's own random id, to tell an event delivered twice                 |
| `metadata.sequence`                 | Its place in this server's log, which counts up from 1 without gaps         |
| `metadata.reporter.uid`             | This server's id, to tell several servers' events apart in one destination  |
| `time`                              | When it happened, in Unix milliseconds                                      |
| `status_id`, `status_detail`        | 1 for a success, 2 for a failure, with a refused key's reason in the detail |
| `actor`                             | Who: you, an agent's session, or the command line's user, by credential     |
| `unmapped.credential`               | The credential in Agention's own terms: its kind, id and name               |
| `src_endpoint`, `http_request`      | The peer's address, and the request's method, path and user agent           |
| `resources` (6003), `entity` (3004) | What it acted on                                                            |

For example, an API key archiving a thread, on one line in a file:

```json
{
  "class_uid": 6003,
  "category_uid": 6,
  "activity_id": 3,
  "type_uid": 600303,
  "class_name": "API Activity",
  "activity_name": "Update",
  "time": 1795564800123,
  "severity_id": 1,
  "status_id": 1,
  "metadata": {
    "version": "1.9.0",
    "product": { "name": "Agention", "vendor_name": "Wayfarer Labs", "version": "0.8.0" },
    "reporter": { "uid": "8d0f5a523c1e4b7a9e246f1b0c9d2a37", "name": "Work" },
    "uid": "3f2b8c1e-5d4a-4e8f-9a61-0c7d2e9b4f15",
    "sequence": 4211,
    "log_name": "audit",
    "event_code": "archiveThread"
  },
  "actor": {
    "user": { "uid": "person:1", "name": "morgan", "type_id": 2 },
    "session": { "credential_uid": "api_key:7" }
  },
  "api": { "operation": "archiveThread", "service": { "name": "operator/v1" } },
  "resources": [
    { "type": "thread", "uid": "thread:118", "name": "claude/builder/42", "data": { "through": 9 } }
  ],
  "src_endpoint": { "ip": "127.0.0.1" },
  "http_request": {
    "http_method": "POST",
    "url": { "path": "/api/operator/v1/s/claude/builder/threads/42/archive" },
    "user_agent": "tmux-agents/0.3"
  },
  "http_response": { "code": 200 },
  "unmapped": { "credential": { "kind": "api_key", "id": 7, "name": "ci-deploy" } }
}
```

A failure's path is the route's pattern, such as `/api/operator/v1/s/:agent/:session/threads`, never
the path the client sent. A counted failure also carries `count`, `start_time` and `end_time`.

### Sinks

With no sink, the log is kept in the database alone. Each sink is a `serve` option, and changes only
when the server starts again:

| Option                     | What it does                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--audit-stdout`           | Writes each event as one JSON line to standard output, where systemd's journal, `docker logs` or a platform's log pipeline collects it. The server writes nothing else there; its own messages go to standard error                               |
| `--audit-dir DIR`          | Writes each event as one JSON line to `DIR/audit.jsonl` and syncs it to the disk. At the first write of a later UTC day, the file is renamed for the day it was written, `audit-2026-11-26.jsonl`, and a new one started, for a collector to tail |
| `--audit-group NAME`       | Shares `--audit-dir`'s directory and files with group `NAME`, for a collector that runs as its own user ([below](#a-collector-that-runs-as-its-own-user))                                                                                         |
| `--audit-keep-days N`      | How many renamed files `--audit-dir` keeps, 1 to 3,650; 30 by default. The oldest beyond that are removed                                                                                                                                         |
| `--audit-retention-days N` | How long the database keeps events, 1 to 36,500 days, or 0 to keep them forever; 365 by default ([Retention](#retention))                                                                                                                         |

`--audit-dir` makes the directory, and any missing directory above it, readable only by you, mode
0700, with files of mode 0600, as the data directory is
([SECURITY.md](../SECURITY.md#private-files)). It refuses a directory or file that exists with any
other mode, says what to change, and never changes it itself. A directory the server cannot reach,
such as the data directory under your home, is no use to a collector running as another user; give
the files a directory of their own.

Each sink receives every event at least once, in order, from where it left off: the server keeps how
far each has got in the database. A sink new to the database starts from the oldest event the
database holds. An event is delivered once standard output has taken it, or once it is written and
synced to the file; it has left the machine only once whatever reads it has carried it off. A
counted failure is delivered once its minute has ended, and the events after it wait for it.

A sink that fails, such as a full disk, is tried again every few seconds, and nothing else waits for
it. The server says so on standard error when it starts failing, every 15 minutes while it goes on
failing, with how far behind it is, and when it recovers. A delivery still under way after a minute,
such as to a pipe that nothing reads, is named on standard error as stalled, every 15 minutes while
it stays so, and once it completes. Undelivered events wait in the database meanwhile, on the same
disk as everything else.

Stopping the server gives the sinks 5 seconds to deliver what is pending. A file write that a
stalled disk holds keeps the server from exiting until the service manager kills it, as systemd does
once its stop timeout passes; no event is lost, since what it was writing is delivered again at the
next start.

The file holds whole lines only: one a crash left half written is ended before the next, and a write
that fails is cut back off. A file renamed or removed from under the server, as by logrotate or a
collector, is let go, and the next event starts a new `audit.jsonl`.

### A collector that runs as its own user

Packaged collectors such as Vector and Grafana Alloy run as users of their own, `vector` and
`alloy`, which cannot read a directory only you can. `--audit-group` gives one group read access,
never write: the directory becomes mode 0750 and its files 0640, in that group, and other users
still have no access. Make a group for the audit files alone, put your user and the collector's in
it, and make the directory:

```bash
sudo groupadd agention-audit
sudo usermod -aG agention-audit "$USER"
sudo usermod -aG agention-audit vector
sudo install -d -o "$USER" -g agention-audit -m 0750 /var/lib/agention-audit
sudo systemctl restart vector
```

Use `alloy` in place of `vector` for Grafana Alloy. The collector takes its new group when it starts
again, which the last line does. Then give the server the directory and the group:

```bash
agention serve ... --audit-dir /var/lib/agention-audit --audit-group agention-audit
```

- **Every directory above the audit directory** must belong to you or root, with no one else able to
  write to it, as for the data directory. `/var/lib` qualifies on Debian. `/var/log` does not on
  Ubuntu, whose group `syslog` can write to it.
- **The server's user must be in the group when it starts**, and the server refuses the option
  otherwise. Log in again after `usermod`. A [systemd user unit](#linux-a-systemd-user-unit) runs
  under your user's service manager, which takes a new group only when it starts again, and with
  lingering on it outlives your logins, so restart it with
  `sudo systemctl restart "user@$(id -u).service"`, or restart the machine.
- **Not `adm`.** Both collectors' Debian packages also put them in `adm`, so `--audit-group adm`
  would work with no change to the collector, but it would put your user in `adm`, which reads the
  system's logs.
- `--audit-group` needs `getent`, which finds the group as the system is set up to, LDAP included.
  Minimal and distroless container images have none, and refuse the option.

### Which sink fits which setting

| Setting                               | Sink                  | Notes                                                                  |
| ------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| Fly.io                                | stdout                | Fly Log Shipper (Vector) forwards it; watch it, as it can stall        |
| Render                                | stdout                | Render's log streams forward over syslog TLS or HTTPS                  |
| Railway                               | stdout                | No native drain; run a Vector forwarder                                |
| Cloud Run                             | stdout                | A JSON line becomes `jsonPayload` in Cloud Logging                     |
| Azure Container Apps                  | stdout                | Lands in Log Analytics, which Sentinel reads                           |
| Datadog, Elastic Cloud, Grafana Cloud | file, via their agent | The vendor's agent or a collector tails the file                       |
| Splunk, HEC-compatible SIEMs, Cribl   | file, via a forwarder | Universal Forwarder, or a collector's HEC exporter                     |
| Homelab, systemd, Docker              | file, or stdout       | stdout lands in the journal or `docker logs`                           |
| Homelab with Wazuh                    | file                  | `localfile` with `log_format json`                                     |
| Homelab with Loki or Graylog          | file, via a collector | Alloy, Vector or Fluent Bit tails the file and forwards it             |
| Syslog receivers (rsyslog, syslog-ng) | file, via a collector | Vector, Fluent Bit or the OpenTelemetry Collector forwards over syslog |

A destination keeps its own copy under its own access controls: it holds which credential did what
and when, never what was written.

### Retention

The database removes events older than `--audit-retention-days`, 365 by default, oldest first, and
only once every sink has received them; with no sink, by age alone. It checks as the server starts
and every 10 minutes after.

A sink you stop giving `serve` keeps its place in the database, so that one start without its option
cannot let retention remove what it never received. The server names it on standard error as it
starts and every 15 minutes, with how far behind it is, while its events wait. Once a sink is gone
for good, forget it, with the server running or not:

```bash
agention audit forget-sink --data ~/.local/share/agention file
```

Its `KIND` is `stdout` or `file`. Forgetting a sink records an event of its own. Forgetting one that
a running server still delivers to stops that sink at its next delivery, which goes out first,
saying so on standard error, until the server starts again and gives it a new place. A sink's place
is kept by its kind, so giving `--audit-dir` another directory carries on where the old one stopped.
To give a sink every event the database still holds instead, stop the server, forget the sink, and
start the server again.

### What the log proves

The copy of an event that has left the machine is the evidence: whoever controls the server cannot
change or remove it there. Each event's `metadata.uid` and `metadata.sequence` let the destination
see an event missing, or received twice. Events not yet delivered can be removed or rewritten unseen
by whoever can write the database ([ADR 0006](adrs/0006-audit-log.md) says why nothing on the
machine guards them).

Restoring a backup rolls the log back with everything else ([Backing up](#backing-up)).

## Upgrading

One version covers the server, the bridge and the plugins. Upgrade the server first, then the
plugins.

[Back up](#backing-up) before upgrading the server. It migrates its database forward when it starts,
and refuses a database a newer release wrote, so going back means installing the earlier release and
restoring a copy made before the upgrade.

To upgrade the server, stop it, install the release, and start it again. On Linux:

```bash
systemctl --user stop agention
npm install -g @wayfarerlabs/agention@latest
agention version
systemctl --user start agention
```

`@latest` installs the newest release; a version in its place installs that one. On macOS, stop and
start the server with the `launchctl bootout` and `launchctl bootstrap` commands of
[macOS: a launchd agent](#macos-a-launchd-agent). Run by hand, stop it with Ctrl-C and run it again.
A browser tab opened before the upgrade keeps running the web UI it loaded, so reload it.

The first start after upgrading from a release before 0.5.0, which brought attachments, rewrites the
database once, before the server listens, so that space removed uploads free can go back to the
disk, and logs that it did.

- It needs free space of about the database's size in SQLite's temporary directory (`SQLITE_TMPDIR`,
  else `TMPDIR`, else `/var/tmp`, else `/tmp`), and as much again on the disk holding the data
  directory.
- Should it fail, for lack of space or because another process holds the database, the server logs
  why and how much space it needs, and starts anyway, nothing lost. Each start tries again; until
  one succeeds, freed space stays in the database file for reuse.
- A database restored from a backup made before 0.5.0 is rewritten the same way.

Agents keep working while their plugins catch up. The bridge and the server state on every call the
version of the agent API they speak, which a release changes when it changes what agents send or
read:

- A server serves the bridges of earlier releases.
- A bridge refuses a server older than itself, and a server refuses a bridge older than the oldest
  it still serves. Either way, the agent tells you at its terminal what to update: the server to the
  plugin's release or later, or the plugin to the server's release.
- A new session that meets an older server leaves a registration waiting for approval whose code its
  agent never gives you; it expires unapproved.
- A session runs the bridge its plugin pinned when it started, so after updating a plugin, restart
  its sessions, resuming each to keep its conversation. `npx` fetches the new bridge as the first of
  them starts.

The bridge keeps its keys outside the plugin, in `~/.config/agention`, so its sessions stay
registered through a plugin's upgrade.

To move a pinned plugin to another release, the latest in this example, pin its marketplace to that
release's tag. Claude Code refuses to add a marketplace again from another tag, so remove it, which
uninstalls the plugin, then add it and install the plugin again:

<!-- x-release-please-start-version -->

```bash
claude plugin marketplace remove agention
claude plugin marketplace add WayfarerLabs/agention#v0.8.0
claude plugin install agention@agention
```

In Codex:

```bash
codex plugin marketplace remove agention
codex plugin marketplace add WayfarerLabs/agention --ref v0.8.0
codex plugin add agention@agention
```

<!-- x-release-please-end -->

To bring a plugin installed from `main` up to date, refresh the marketplace and install the plugin
again: the hosts replace an installed plugin only when its version changes, which happens at each
release. In Claude Code:

```bash
claude plugin marketplace update agention
claude plugin uninstall agention@agention
claude plugin install agention@agention
```

In Codex:

```bash
codex plugin marketplace upgrade agention
codex plugin remove agention@agention
codex plugin add agention@agention
```

## Backing up

The database, `agention.db` in the data directory, is the whole of an instance's state: its own key,
your passkeys' records, every thread and every session's log, every file attached to a message, and
voice's settings with a key saved in Settings. Voice settings from the environment are not in it.

`agention backup` writes a consistent copy of it to a new file, while the server runs or not, then
checks the copy and prints its path, size and schema version:

```bash
mkdir -m 700 -p ~/agention-backups
agention backup --data ~/.local/share/agention \
    ~/agention-backups/agention-"$(date +%Y%m%d-%H%M%S)".db
```

- **Keep backups in a directory of their own, with mode 0700.** The copy is created readable only by
  you, and the command refuses a directory other users could read or change, as it does for the data
  directory. It also refuses a file that already exists, which the time in the example's file name
  avoids, and a path SQLite keeps for the database's own files, such as `agention.db-wal`.
- **A copy on the same disk is a rollback, not a backup**, so keep one on another disk or machine
  too, and encrypt any copy you move off the machine: it holds everything the database does, its
  keys included.
- **Every backup is a whole copy**, attached files included, so each is about the size of the
  database.
- **It never changes what the database holds**, though with the server stopped SQLite may leave an
  empty `agention.db-wal` and an `agention.db-shm` beside it, which the server uses as its own when
  it starts. It opens the database read-only and never migrates it, so a copy taken with a newer
  release, before you start that release on the database, is a copy of the database as the older
  server left it.
- **A backup that fails** leaves no file behind and exits with status 1.

To restore a copy, stop the server, move the database and the files SQLite keeps beside it out of
the data directory, put the copy in as `agention.db`, and start the server. Move the `-wal` and
`-shm` files aside with the database: a `-wal` file left beside the copy, as an abruptly stopped
server leaves one, would be applied to the copy when the server starts. On Linux:

```bash
systemctl --user stop agention
replaced=~/.local/share/agention-replaced-"$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$replaced"
mv ~/.local/share/agention/agention.db* "$replaced"/
cp ~/agention-backups/agention-20261106-120000.db ~/.local/share/agention/agention.db
systemctl --user start agention
```

On macOS, wait until launchd no longer finds the server before moving the files:

```bash
launchctl bootout gui/$UID/com.wayfarerlabs.agention
while launchctl print gui/$UID/com.wayfarerlabs.agention >/dev/null 2>&1; do sleep 1; done
replaced=~/.local/share/agention-replaced-"$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$replaced"
mv ~/.local/share/agention/agention.db* "$replaced"/
cp ~/agention-backups/agention-20261106-120000.db ~/.local/share/agention/agention.db
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wayfarerlabs.agention.plist
```

Run by hand, stop the server with Ctrl-C and wait for your prompt first. `cp` gives the restored
database the copy's mode, 0600. The server opens a copy made by its own release or an earlier one.
Remove the replaced files when you no longer need them.

**Restoring rolls the audit log back** with the data: the events recorded after the backup are gone
from the database, though not from a destination that already received them. Each sink's place rolls
back too, so a sink receives again only the events the backup holds that it had received after the
backup was made, under the same `metadata.uid`, which lets a destination drop the copies. Events
recorded after the restore take the sequence numbers that followed the backup, under new ids, which
shows a destination the rollback ([ADR 0006](adrs/0006-audit-log.md)).

## Rate budgets

The server limits how fast each kind of request may arrive, so a flood of one kind cannot crowd out
the others. No limit depends on the requester's address, which behind a terminator is the same for
everyone. Each budget holds a burst of requests and refills at a steady rate; a request beyond it is
answered `rate_limited` with a `Retry-After` header.

| Requests                                               | Budget      | Burst | Refill             |
| ------------------------------------------------------ | ----------- | ----- | ------------------ |
| Signed by a registered agent key, pending or approved  | One per key | 60    | 1 per second       |
| Registrations of keys the server has not seen          | Shared      | 20    | 1 every 30 seconds |
| Agent requests that fail authentication                | Shared      | 60    | 1 per second       |
| Passkey sign-ins that fail                             | Shared      | 20    | 1 every 6 seconds  |
| Passkey links that fail, at the link or at the passkey | Shared      | 20    | 1 every 6 seconds  |
| Operator API requests with a live API key              | One per key | 60    | 1 per second       |
| Operator API requests that fail authentication         | Shared      | 60    | 1 per second       |

A key's budget counts every request its session makes, each upload, each file fetched and each read
a tool makes on the way included: a message of ten files is at least eleven requests.

Apart from these rates, an API key or a browser session holds at most 4 of the waits across sessions
(`GET /wait`) at once, however fast it starts them: one more is refused as `rate_limited`, with a
`Retry-After` of a second, and no held wait ends to make room for it. A wait gives its place back as
it ends, however it ends, and one of `wait=0`, which answers at once, is not counted.

The shared budgets other than registrations are spent only by requests that fail, after they have
been checked, so exhausting one refuses only further failures, never a valid agent key, API key,
passkey or link. Starting a sign-in or a link costs nothing. Only the registration budget lets an
outsider delay anything: exhausting it delays registering new agents, and never an agent already
registered.

## Commands

| Command                      | What it does                                                           |
| ---------------------------- | ---------------------------------------------------------------------- |
| `agention version`           | Prints the version and exits                                           |
| `agention --help`            | Prints the command list and exits                                      |
| `agention serve`             | Runs the server, with listener, TLS and origin settings                |
| `agention passkey-link`      | Prints a one-time link to register or replace the operator's passkeys  |
| `agention backup`            | Writes a consistent copy of the database, while the server runs or not |
| `agention audit forget-sink` | Removes an audit sink's place, so retention no longer waits for it     |

Every command takes `--help`.
