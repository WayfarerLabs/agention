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
5. [Install the plugins](#installing-the-plugins) where your agents run, and
   [approve each agent](#approving-agents) as it registers.
6. If you like, [set up voice](#voice), to dictate your replies, and [create API keys](#api-keys)
   for programs of yours that read or answer Agention as you.

## Commands

| Command                 | What it does                                                           |
| ----------------------- | ---------------------------------------------------------------------- |
| `agention version`      | Prints the version and exits                                           |
| `agention --help`       | Prints the command list and exits                                      |
| `agention serve`        | Runs the server, with listener, TLS and origin settings                |
| `agention passkey-link` | Prints a one-time link to register or replace the operator's passkeys  |
| `agention backup`       | Writes a consistent copy of the database, while the server runs or not |

Every command takes `--help`.

## Installing

Install Agention as the user that will run the server:

```bash
npm install -g @wayfarerlabs/agention
agention version
```

`agention version` prints the version installed, such as `agention 0.1.0`. npm installs commands
under its global prefix, which `npm prefix -g` prints. When that is a system directory, as it can be
for a Node.js installed by the system's package manager, `npm install -g` fails for want of
permission; rather than use `sudo`, run `npm config set prefix ~/.local` to install into `~/.local`,
with the commands in `~/.local/bin`, which must be on your `PATH`.

## Giving it an HTTPS origin

People and agents reach the server at its origin, the address in the browser's location bar, such as
`https://agention.example.com` or `https://agention.example.com:8443`: `https`, a domain name, and a
port only when it is not 443. It cannot be an IP address, since browsers refuse passkeys for one.
With only an IP address, give it a name, such as a DNS record pointing at it, which may be a private
address. Passkeys belong to the origin's host and agent tokens name the origin, so changing the host
later needs new passkeys, and changing the origin at all needs every agent's `AGENTION_URL` changed
to match.

Host the server wherever suits you, in either of two ways:

- **Behind a TLS terminator**, the default. The server listens on loopback with plain HTTP, and a
  terminator you run publishes it at the origin over HTTPS, with a certificate for the origin's
  name. The terminator must pass the request's `Host` through unchanged, since the server answers
  only requests whose `Host` is the origin's host, with its port when that is not 443, and reads no
  forwarded headers. It can be a reverse proxy such as Caddy or nginx, or, on a
  [Tailscale](https://tailscale.com) network,
  [`tailscale serve`](#publishing-it-with-tailscale-serve), which needs no certificate of your own.
- **Terminating TLS itself.** Give `agention serve` the certificate and its key with `--tls-cert`
  and `--tls-key`, and listen on any address with `--listen`. The server accepts TLS 1.3 only.

Either way, the certificate must be one your browsers and your agents' machines trust: one from a
public authority, or from a private one each of them trusts, which for agents `NODE_EXTRA_CA_CERTS`
sets, as [Agents](#agents) describes.

Plain HTTP on an address other than loopback would carry agent tokens and browser cookies in the
clear, so the server refuses to start that way unless `--allow-plain-http` is given. Use it only
when the network path is already encrypted.

Each device you sign in from, your phone included, and each machine where your agents run must reach
the origin. An agent's machine that can't connect to it can be reached through a tunnel from the
server's machine instead, as
[Reaching the server through a tunnel](#reaching-the-server-through-a-tunnel) describes. Anything
else that reaches the origin reaches the sign-in page, the agents' API and the operator API as well:
passkeys, approved agent keys and API keys keep it from acting, but it can still delay new agent
registrations, as [SECURITY.md](../SECURITY.md#security-model) says. A private network, such as a
VPN or a tailnet, keeps the server to your own devices.

### Publishing it with `tailscale serve`

On a Tailscale network, `tailscale serve` publishes the server over HTTPS at the machine's name in
your tailnet, with a certificate Tailscale provisions. Publish the server's default listener,
`127.0.0.1:8080`:

```bash
tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
```

Each prints the address Tailscale serves the server at: `https://` and the machine's `ts.net` name,
such as `https://agention.example.ts.net`. That address, without a trailing slash, is the server's
origin. Until the server runs, the address answers with an error. `--bg` keeps it serving in the
background, across restarts of Tailscale and of the machine, until you turn it off by running the
same command with `off` at its end. The first time, `tailscale serve` may send you to a page to
enable HTTPS certificates for your tailnet. On Linux, run these commands with `sudo`, unless
`sudo tailscale set --operator=$USER` made you Tailscale's operator. On a Mac, the Tailscale app
does not put `tailscale` on your `PATH`: its Standalone variant installs the command from
**Settings**, under CLI integration, and its App Store variant runs it as
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`, as
[Tailscale's CLI documentation](https://tailscale.com/docs/reference/tailscale-cli) describes.

This keeps Agention within your tailnet: only its devices can reach it, as your tailnet's access
rules allow. Tailscale Funnel would publish it to the whole internet; Agention does not need it.

## Running the server

```bash
agention serve --data ~/.local/share/agention --origin https://agention.example.com --name Work
```

| Option               | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--data DIR`         | The data directory, which holds the database, `agention.db`; required                                                |
| `--origin URL`       | The HTTPS origin people and agents reach the server at; required                                                     |
| `--listen ADDR`      | The IP address and port to listen on, by default `127.0.0.1:8080`                                                    |
| `--tls-cert FILE`    | The TLS certificate chain, in PEM, for the server to terminate TLS itself                                            |
| `--tls-key FILE`     | The certificate's private key, in PEM; give both TLS options or neither                                              |
| `--allow-plain-http` | Allow plain HTTP on an address other than loopback                                                                   |
| `--quiet-minutes N`  | Minutes, 1 to 10,080, after which a session whose agent has not checked in is quiet; 15 by default                   |
| `--name NAME`        | The server's name, 1 to 40 characters on one line, set by its first start                                            |
| `--api-docs`         | Serve the API's documentation, without sign-in, at `/docs/api/` and its OpenAPI document at `/docs/api/openapi.json` |

The first start that serves sets the server's name for good, `Agention` unless `--name` gives
another, and stores it with its data; a start that fails before it serves, on a port already in use
for one, sets nothing. A later start may leave `--name` out or repeat the name, and refuses one that
names another. The name is the web UI's title: the banner shows it, each page's title in the browser
follows the page's own name with it, as in **Threads · Work**, and a phone names the page by it on
its home screen. A passkey made on the server carries it as its site's name and before your name, as
in **Work · operator**.

A second server, such as one for personal use beside one for work, runs on its own machine, with its
own `--name` given on its first start. Servers can also share a host under different ports without
signing each other out. Each server has a data directory of its own: run one server per database,
since a server keeps track of the uploads still arriving in its own process, and a second one on the
same database would remove them as abandoned.

`--listen` takes an IP address, not a name, with an IPv6 address in brackets: `[::1]:8080`.
[Giving it an HTTPS origin](#giving-it-an-https-origin) says what the origin is, and when to use
`--listen`, `--tls-cert`, `--tls-key` and `--allow-plain-http`. `--api-docs` is for writing a
program against the operator API, as [Using the operator API](#using-the-operator-api) describes;
without it, nothing is served under `/docs/api/`. The server also reads three environment variables,
each optional, which supply voice's settings: [Voice](#voice) says how.

An agent checks in each time it calls Agention, and its session is seen then, kept to the minute.
One whose agent has not checked in within `--quiet-minutes` and the minute that may take to show, or
never, is quiet: it has stopped, or is busy elsewhere. A session's bridge may also hold a background
connection to the server, which is not the agent checking in; while it does, the session is
**connected**, and it stops being so within a minute of the bridge ending. A bridge from before the
background connection cannot report one, so a session whose agent last checked in through such a
bridge, with no newer one connected, is never shown disconnected. An agent also reports what its
session is doing: **working** while it does something now; **idle** while it has nothing left to do
but wait, for your answers, CI or a review, and it keeps checking Agention; and **stopped** once it
stops checking, with why: **completed** when the work is done, **withdrawn** when you called it off,
or **stalled** when it cannot go on. A stopped session will not see what you write until something
starts it again, and stays stopped until it reports working or idle. An agent reports its state with
an update of its own or beside a message it writes, and an idle session that writes to its threads
without reporting a state or note, a message, a new thread, or marking one read, unread or archived,
is working from then on, since it is plainly doing something: the server marks it so itself, logging
that it did so, with no note. Checking for your answers changes nothing, and neither does anything
you write. Whether a session waits on you is no state it reports: its open asks say so. A session
whose agent never reported, such as one whose plugin predates session states, has no state. A thread
whose agent has not read your latest messages while its session is quiet, is not connected, has
stopped or has no active credential is **stranded**: the agent will not see what you wrote until you
resume it. An agent keeps checking for your answers while it has open asks or unread messages, so a
thread stranded by a quiet session means the agent stopped without saying so, such as when its host
ended the session, or is busy and has not checked.

The data directory and the database must be private to the user running Agention, under the rule
[SECURITY.md](../SECURITY.md#private-files) states. `agention serve` creates a missing data
directory, and any missing directory above it, private to that user whatever the umask. Until the
rule holds, Agention refuses to open the database and says what to change, such as running
`chmod go-w ~` when your home directory, above the data directory, is writable by its group; it
never changes the permissions of a path that exists.

Try the server in a terminal first, with your origin in place of the example and your server's name
after `--name`, since the first run that serves sets the name for good. Once it listens, it prints
the origin it serves and the address it listens on:

```text
agention: serving https://agention.example.com on http://127.0.0.1:8080
```

The server logs to standard error. To keep its log in a file only you can read, run it with a umask
that creates the file private, and follow the file from another terminal with
`tail -f ~/agention.log`:

```bash
(umask 077; agention serve --data ~/.local/share/agention --origin https://agention.example.com --name Work 2>>~/agention.log)
```

`SIGINT`, which Ctrl-C sends, or `SIGTERM` stops it: it ends the requests agents have waiting,
finishes the others and exits within a few seconds. Closing the terminal stops it too. A terminal
multiplexer such as `tmux` or `screen` can keep it running after you close the terminal, until the
machine restarts, but a service is the better way to keep it running.

### Running it as a service

A service starts the server for you, starts it again if it fails, and stops it with `SIGTERM`, which
it handles cleanly. A service runs with a minimal `PATH`, so it names `node` and `agention` by their
absolute paths. In the shell you installed Agention from, these print them:

```bash
node -p process.execPath
echo "$(npm prefix -g)/bin/agention"
```

The examples below use `/usr/local/bin/node` and `/usr/local/bin/agention`; use yours instead, and
your origin. When a version manager installed Node.js, both paths change with its version, so after
changing it, install Agention again and update them.

Stop a server you started by hand before starting the service. Both listen on the same address, so
the service would fail to bind it and keep retrying.

#### Linux: a systemd user unit

Save this as `~/.config/systemd/user/agention.service`, where systemd reads `%h` as your home
directory:

```ini
[Unit]
Description=Agention server

[Service]
ExecStart=/usr/local/bin/node /usr/local/bin/agention serve --data %h/.local/share/agention --origin https://agention.example.com
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

`enable --now` starts it now and whenever your user's services start. Those start when you log in
and stop when your last session ends, unless lingering is on: `loginctl enable-linger` turns it on
for you, so they start at boot and run without a login. It may ask you to authenticate, or need
`sudo loginctl enable-linger "$USER"`.

`systemctl --user status agention` shows whether the server is running, and
`journalctl --user -u agention` shows its log, which `-f` follows. `systemctl --user stop agention`
stops it, `start` starts it again, and `restart` does both. A server that fails is started again
five seconds later, and again every five seconds while it keeps failing: its log says why, and
`systemctl --user stop agention` ends the retries.

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

A launch agent runs while you are logged in to the Mac, and starts again each time you log in.
launchd starts the server again if it exits with an error. Its log is `~/Library/Logs/agention.log`,
which `tail -f` follows; launchd appends to it and never rotates it.
`launchctl print gui/$UID/com.wayfarerlabs.agention` shows the server's state.
`launchctl bootout gui/$UID/com.wayfarerlabs.agention` stops it with `SIGTERM` and unloads it, and
`launchctl bootstrap`, as above, loads and starts it again; restart it with the two in turn.

## Signing in

You sign in to the web UI with a passkey. The UI needs a browser with WebAuthn's JSON helpers:
Safari 18.4, Chrome or Edge 129, Firefox 119, or later; an older browser says it cannot sign in.

Once the server is running, register your first passkey. On the server's machine, as the user that
runs the server, run `agention passkey-link` with the server's `--data` and `--origin`:

```bash
agention passkey-link --data ~/.local/share/agention --origin https://agention.example.com
```

It prints a link to open within 15 minutes in the browser you want to sign in with. The page it
opens asks you to name and create a passkey, then signs you in. The first link also creates you as
the operator, named `operator` unless you give `--operator-name`: 1 to 63 of `a-z`, `0-9`, `_` and
`-`, starting with a letter or digit. The name labels the messages you write.

A link works once. Anyone who opens it before you can register their own passkey, so keep it as
private as a password. Issuing a new link revokes any earlier one that has not been used.

You can hold up to 20 passkeys, one on each device you use, and manage them in the web UI's
**Settings**, under **Passkeys**: each has the name you gave it, shows when it was added and last
signed in, and the one this browser signed in with is marked. There you add a passkey on the device
in hand. To add one on another device, sign in there with a passkey you hold, through the browser's
cross-device sign-in (it shows a QR code that your phone, holding the passkey, scans), then add the
device's own passkey in its Settings. A device that cannot is added by `agention passkey-link`,
below, which replaces every passkey. You rename a passkey at any time, and remove any but your last;
removing one signs out every browser it signed in. Adding a passkey and removing one need a sign-in
within the last 10 minutes, and the Passkeys, API keys and Voice sections of Settings offer to sign
in again while yours is older.

To replace your passkeys, after losing your devices for example, run `agention passkey-link` again.
Using the new link replaces all your passkeys with the one it registers, signs out every browser and
revokes every API key, since whoever held the old passkeys could have created keys; create again the
ones your programs still need ([API keys](#api-keys)).

Passkeys must verify you, with a PIN or biometric, and be stored by the authenticator, so signing in
asks for no name: open the origin and choose **Sign in with a passkey**. A browser session lasts 30
days, and ends sooner after seven days without use or when you sign out, with **Sign out** in
**Settings**. When it ends, the next page you open, or the one you have open, returns to sign-in and
comes back to that page afterwards.

## Using the web UI

The web UI is laid out for a phone first and follows the browser's light or dark setting. With a
mouse or a trackpad, its controls and spacing are more compact than on a touch screen. Every view
refreshes itself every 10 seconds while it is visible, and as soon as you return to it.

On a screen at least 1024 pixels wide at the browser's usual text size, a desktop's, **Threads**
shows the thread list and the thread you open side by side across the window, the list on the left;
on a narrower screen, or with text enlarged until they no longer fit, it shows one at a time, as on
a phone. Resizing the window across that width keeps the thread you have open as it is, with
anything you were writing or attaching. Side by side, each thread keeps its own address, so **Back**
and **Forward** move between the threads you opened, and back to the list with none open. The list
stays as you set it, its filters, order, folds and scroll, as threads open beside it and as you go
back and forward; the row of the thread open is outlined, and choosing it again takes you to the
thread; and choosing another order or filter keeps the thread open. The thread scrolls with the page
while the list stays in view, scrolling on its own. Going back to the list from a thread, with its
**Threads** button, **Back**, `u` or `Esc`, puts focus on the row of the thread you left.

Where a thread is, its agent, its session and its topic, shows each part behind a small badge: **A**
for the agent, **S** for the session and **T** for the topic; holding the pointer over a badge names
it. A topic is a name like an agent's or a session's, such as `auth`, and belongs to its session:
beside its session it shows alone, and elsewhere as `session/topic`.

- **The thread list**, **Threads**, shows every thread you have not archived. The **Threads** tab
  counts those holding a message you have not read, the threads the **Unread** filter keeps with no
  other filter on, and reading or archiving them clears the count. The list's head holds **Sort**,
  the order it is in, beside a button saying which way the order runs, then **Group**, how the list
  is grouped, and **Filters**, a funnel with a badge counting the filters that are on. On a phone,
  **Sort** and its button take one row, with **Group** and **Filters** beneath them; on the
  narrowest phones, or with enlarged text, the button wraps beneath **Sort**.
  - **Sort** orders the list by:
    - **Priority**, the default: the threads with asks open to you first, each by the most pressing
      of its asks: by priority, then those blocking the agent's work, then by the earliest
      answer-by, then the oldest ask. The rest follow, latest message first.
    - **Due**: the threads with an open ask that has an answer-by first, soonest first; then the
      other threads with open asks, as **Priority** orders them; then the rest, latest message
      first.
    - **Effort**: the threads with an open ask that says how long answering takes first, quickest
      first, those alike as **Priority** orders them; then the other threads with open asks, as
      **Priority** orders them; then the rest, latest message first.
    - **Latest message**: every thread by its latest message, newest first.
    - **Created**: every thread by when it began, newest first. Within a session that is the order
      of the threads' numbers, which start again in every session.
  - The button beside **Sort** says which way the order runs, such as **Most pressing first**,
    **Soonest first**, **Quickest first** or **Newest first**, and choosing it reverses the order,
    to **Least pressing first**, **Latest first**, **Longest first** or **Oldest first**. Reversing
    turns around the threads the order ranks: for **Priority** those with asks open to you, for
    **Due** those whose ask has an answer-by, for **Effort** those whose ask says how long it takes,
    and for **Latest message** and **Created** every thread. The threads it does not rank still
    follow them, as before. Choosing another order starts it in its own direction.
  - **Group** shows the list **Flat**, the default, or folded under headers: by **Group**, each
    session group's sessions under its header when the list holds two or more groups, those in none
    under **No group**, and each session as **Session** folds it; by **Session**, each session's
    threads under its header, and under their topics' when they carry two or more, those without one
    under **No topic**; or by **Agent**, each agent's threads under its header, and under their
    sessions' when it has two or more. Groups, sessions, topics and agents come in the order of
    their first thread, and the list loads a page at a time, its threads arriving group by group.
    Each header shows all its group holds, collapsed or not, and before all of it has loaded: how
    many threads, the closed envelope with how many are unread or the open envelope when none is,
    **Blocked on you** when an agent's ask blocks its work on your answer, the highest priority of
    an open ask, the archive box when all are archived, and, in the warning's color on a session's
    or an agent's header while it is quiet, **last seen** and when, or **never seen** (an agent is
    quiet while every session it shows is). A session group's header adds up its sessions'. A
    header's name, and each of those marks a filter matches, is a link that adds what the header
    heads (its group, session, topic or agent) and the mark's own filter to the filters on, keeping
    the others, the order and the grouping: the name and the count keep all its threads, the
    envelope its unread ones, **Blocked on you** those blocking an agent on your answer, and the
    priority those with an ask at that priority or higher. While a filter on open asks is on,
    **Blocked on you** and the priority link nowhere, since they count every open ask of the threads
    shown while those filters keep a thread for one ask meeting them all. **No topic**, which no
    filter names, the archive box and **last seen** link nowhere. The chevron before a header's name
    collapses everything under it or expands it again, as a click anywhere else on the header does
    but on a link. Every header starts expanded, and this browser keeps the ones you collapse, for
    each way of grouping, a session group's however you rename it.
  - Every way of narrowing the list is a filter. Different filters combine, each narrowing what the
    others keep; several values chosen in one filter, such as two agents, each keep their own
    threads. **Filters** opens a sheet holding them all, each a row of choices whose first turns it
    off, and each value not chosen shows in parentheses how many threads it keeps with every other
    filter as it is, which for a filter taking one value is how many the list would hold if you
    chose it:
    - **Search** keeps the threads whose title holds every word you type, or one of whose messages
      does in its text and details, each as the start of a word, ignoring case and accents. A
      message you or an agent replaced no longer matches; its replacement does. It applies once you
      pause typing. An agent's own search of its threads looks at titles alone.
    - **Status** keeps the threads of one status, which rolls up the asks on their messages:
      **Open** while one waits for your answer; **Answered** once none does and you answered or
      declined at least one; **Withdrawn** when the agent withdrew every one; and **None** for a
      thread that asks nothing. Beneath it, the properties of open asks: **Priority** at least
      **Normal+**, **High+** or **Urgent**; **Impact**, **Blocking** where the work the ask is for
      waits on your answer while the agent carries on with other work, or **Assuming** where it goes
      on under an assumption; **Due**, **Overdue** past its answer-by; and **Effort** at most
      **Quick** (a glance, about two minutes), **≤15m** or **≤1h**, which keeps only asks whose
      agent said how long answering takes. Together they keep the threads with one open ask that
      meets them all, and any of them keeps only open threads, so **Status** shows **Open** while
      one is on: choosing one under another status chooses **Open**, and choosing any other status
      turns them all off.
    - **Read**: **Unread** keeps the threads with messages you have not read, and **Read by agent**:
      **Unread** those with a message of yours the agent has not read yet, and **Stranded** those
      among them whose agent is not there to read it, as [Running the server](#running-the-server)
      says.
    - **Agent**, **Session** and **Topic**, each beside its badge, open a list of the agents, the
      sessions or the topics holding a thread, each with its count, which stays as you check and
      uncheck them; a search box above narrows them by what they show. Check up to 50 of each.
      Sessions show their agent beside them, and while agents are chosen only their sessions are
      offered, with any you already chose. Topics show as `session/topic` with their agent beside
      them: while sessions are chosen only their topics are offered, or else while agents are chosen
      only their agents' topics, with any you already chose. Each lists at most 500, and says so
      when there are more. Escape, **Done** or a tap outside closes the list.
    - **Group** and **Tag** open such lists too: **Group** of your session groups holding a thread,
      in your order, each beside its color, and **No group** for the sessions in none; **Tag** of
      the tags on a session holding a thread or on its agent. A thread is kept when its session is
      in a group you chose, or when its session or its agent carries a tag you chose.
    - **Archived**: **Show** adds the threads you archived.

    The list behind the sheet follows each change. **Reset filters** turns every filter off, saying
    how many threads the list holds with none, and the button at the foot closes the sheet, saying
    how many threads the list holds; so does Escape.

  - Each filter that is on shows beneath the head as a compact chip, such as **Unread** or **Status:
    Withdrawn**; an agent, session or topic shows behind its badge, such as **builder**, a topic as
    `session/topic`, or **2 agents** when you chose several. A group or a tag shows by its name now,
    such as **Group: Billing** or **Tag: infra**, or as **2 groups**. A group you have since removed
    keeps nothing, and its chip says **Removed group**; so does a tag you have removed, whose chip
    begins **Removed tag**. A single group's or tag's chip shows its color. A long label is cut
    short, at its front for an agent, session or topic, so its end stays; holding the pointer over a
    chip says it whole. Choosing a chip removes its filter. The grouping, the order and its
    direction are no filters, so they stay when filters go.
  - The page's address holds the filters, the order, its direction and the grouping, so a list you
    bookmark or share opens as you left it.
  - A row shows the thread's number and title, such as **#9 Release checklist**. While it holds
    messages you have not read, the row stands out in blue, with a thick bar at its start, a tint,
    and a dot before its title, set extra bold; while it does, the closed envelope with how many are
    unread over all the messages it holds, yours included and a replaced message counted once,
    through its replacement, such as **2/5**, and once you have read them all, the open envelope
    with how many it holds, such as **5**; a pencil while this browser keeps your draft of a reply
    to it; the archive box when you archived it; where it is, its agent, session and topic, and when
    it last changed; and, when an ask is open to you, the question of the one the list leads with,
    the first in its order among those the filters keep, with its priority, blocked and assuming
    marks, how long answering takes when the agent said, and how many more are open; otherwise,
    muted, **Answered**, or **Withdrawn:** and the agent's latest reason on one line. When any of
    the asks open to you has an answer-by, the row also shows the earliest answer-by among them,
    whichever ask carries it: **Due** and the time when that falls today, or the date and time on
    another day, with the year only when it is not this year's; and once the server finds it passed,
    as the **Overdue** filter does, **Overdue since** then. Holding the pointer over the time shows
    it in full. A stranded thread shows a **Stranded** tag in the warning's color, as the sessions
    view flags stranded threads, saying why: its session **stopped**, with how; it is quiet, **last
    seen** when, or **never seen**; it has **no active credential**; or its bridge is **not
    connected**. A session with no active credential also shows its own tag, unless the stranded tag
    already says so.
  - **Archive all read**, while archived threads are not included and no filter keeps only threads
    with open asks, archives the threads loaded that hold nothing unread, keeping those with an ask
    open to you, and **Mark all read** with **Unread** on marks the threads loaded read, each
    through the latest message shown. Both say when more remain.
- **A thread** reads like an email. Its head starts with **Threads**, a button back to the list as
  you left it, with its filters, order and grouping, or with none when you opened the thread
  directly. Its heading leads with the thread's number, as a row's does. Under it, its agent,
  session and topic say where the thread is, and each opens the list narrowed to it alone, with no
  other filter on, showing everything there in the order and grouping you left the list in. Beneath,
  muted, a thread whose asks were answered or withdrawn says so, as its row does, and a stranded
  thread says why its session has not read your latest messages: it stopped, and how, its agent was
  last seen when, or never, or its bridge is not connected; a session with no active credential says
  so in a notice under the head. **Threads** stays marked in the navigation. The head holds **Thread
  above** and **Thread below**, arrow buttons beside **Threads**, **Archive all**, and **Jump to
  unread** while anything is unread or an ask is open to you, and shows the archive box while the
  thread is archived. The messages open on the newest ones, or on the first one you had not read
  after those you archived when that comes before them, and show earlier and later ones when you
  ask.
  - While the page is visible, it reads what it shows: what is on screen when you open the thread,
    and messages that arrive or that you show later, as they appear. Each of the agent's messages
    shows the closed envelope if you had not read it when it appeared, until you leave the page or
    archive it, and the open envelope otherwise; one you had not read also stands out in blue, as
    unread rows do, with a dot before its author. Reading, like writing, counts only the messages on
    screen. Your reading wakes no agent waiting for messages, which sees it the next time it reads
    the thread.
  - **Jump to unread** moves you to a message you have not read, whether it shows the closed
    envelope or is not shown yet, or to the card of one of the 50 most pressing asks still open to
    you, read or not. The first press goes to the first of them after what you had read when you
    opened the page, and each press after it to the next in the thread's order, showing earlier or
    later messages when needed, and round to the first in the thread after the last. Once nothing is
    unread it is **Jump to open ask**, going round those asks alone, and with neither it is gone.
    Its count says how many messages are unread, or how many asks it goes round.
  - Each message of yours shows, quietly at its bottom right, an envelope and the word **agent**:
    the envelope closed and accented while the agent has not read it, and open once it has. A screen
    reader says **Unread by agent** or **Read by agent**.
  - **Archive all** first shows every message through the latest, loading those not yet shown, then
    archives through it, taking the thread off your list until the agent writes to it again. Then it
    goes where **Auto-advance**, in Settings under **Threads**, says: the thread just above where
    the archived thread stands in the list, unless you choose the one just below or back to the
    list. It takes the archived thread's place, so **Back** does not return to it, and at the end of
    the list that way it goes back to the list, which says so. If finding that thread fails, you
    stay on the thread, archived, and the page says so. While an ask is open to you, answer or
    decline it first. Writing to a thread you archived keeps it archived, and what you archived
    never counts as unread.
  - **Thread above** and **Thread below**, or `[` and `]`, open the row just above or below this
    thread in the list **Threads** returns to, as that list stands when you press them, with its
    filters, order and grouping, read or not. Change that list while they look, and they look again
    in the list as you left it; should it keep changing, they stay and say so. That is the list
    beside the thread side by side, so if answering or replying here moves the thread in it, they
    follow it to its new place, on a phone as beside the list. A thread the list's filters leave
    out, such as one read out of a list kept to the unread, or an archived one, counts where the
    list's order would put it within its group, which stays where the list shows it. A thread you
    opened from a link moves through the list with no filters, the one **Threads** returns to; a
    reload keeps the list you opened it from. Unlike `k` and `j` in the list, they go through
    threads in folded groups too, since a phone shows no list to fold. At the top or bottom of the
    list, they go back to the list, which says so. **Back** returns to this thread. Side by side,
    the thread opens beside the list, which keeps its scroll, its row outlined; on a phone the same
    buttons lead the thread's head.
  - The messages you archived fold into one line at the top, **N archived messages**, which shows
    them, each with the archive box. The page never reads them while they are folded. A message you
    send to an archived thread is archived with the rest, but stays in view until you leave the
    page. Once you show them, a thin rule, **Archived through here**, sets apart the messages you
    have not archived after them. It moves as you archive further, and appears when the agent writes
    to a thread you archived.
  - The **⋯** button on a message opens its options: **Mark unread from here** and **Archive through
    here**, until you have archived that message; **Change answer** on a message carrying your
    answers while an ask it answered is still live; **Edit** on your other messages; and **Read
    aloud**, wherever the browser can speak, on a replaced message too, once you open it. A message
    offering none has no **⋯** button. Escape, a tap elsewhere, or moving on to another control
    closes them. **Mark unread from here** makes the agent's messages from that one on unread again,
    and returns to the list; it never marks read what you have not read. **Archive through here**
    archives that message and every earlier one, and your own replies right after it, which fold
    away while the page stays, through the latest message too. It waits, naming the ask to answer or
    decline first, while an ask open to you sits in that message or an earlier one. **Read aloud**
    speaks the message on your device, in the browser's own voice for the page's language: its text
    and details, a code block or a diagram named rather than read, then its asks with their
    suggested answers, and its answers. It reads **Stop** while it speaks; reading another message
    aloud, starting a recording or leaving the thread stops it too. A device that cannot speak, such
    as one without voices installed, says so under the message, and **Read aloud** is offered again.
    Nothing is read aloud unless you ask.
  - A message's text is a short summary of what the matter is and what is needed. Whatever else the
    message says is in its details: a **Details** line directly under the text opens them in place
    and folds them again, and details you opened stay open as the page refreshes.
  - A message's files show under it, and **Attach** beside **Send** adds yours, as
    [Attachments](#attachments) describes. While the thread holds any, its head holds **Files**,
    folded, with how many there are and the space they take.
  - Each ask shows as a card on its message, which may carry several. Asks are numbered within the
    thread as the agent writes them, and the card leads with the number (**Ask 3**), then the
    question, its priority, impact, how long answering takes when the agent said, and answer-by,
    what the agent will do without an answer, and whether it is open, answered, revised or
    withdrawn. An agent that revises an ask asks it again under a new number. An agent withdraws an
    ask it no longer needs answered, such as one settled elsewhere, with a reason: its card reads
    **Withdrawn in #7:** and the reason, and the message that withdrew it says **Withdrew ask 3:**
    and the reason for each ask it withdrew. An agent may withdraw an ask in the message that
    revises its others, and the card reads withdrawn all the same. A withdrawn ask takes no answer.
    An answered card checks the suggested answers you picked, sets the others apart and shows your
    own words under **Other**; a declined one says so. The message carrying your answers says the
    same for each, naming the ask by its number: the suggested answers you picked and **Other** with
    your words beneath, your words alone on an ask without suggested answers, or that you declined.
  - You answer on the card. Where the ask allows one answer, its suggested answers are radio buttons
    under **Choose one**; where it allows several, checkboxes under **Choose any that apply**. The
    last choice, **Other**, is for your own words, instead of a pick or, where several are allowed,
    beside your picks: choosing it opens a field for them and moves you there, and clearing it keeps
    the words for when you choose it again, and sends none. An ask without suggested answers has
    only that field. **Decline to answer**, below the choices, sets them aside and declines the ask
    when you send, until you undo it. While the card holds an answer or a decline you have not sent,
    **Clear** there removes it as **Remove** in the line above the box does, leaving you on the card
    as it was before you chose anything. **Change answer**, in the options of a message carrying
    your answers, opens again the card of every ask that message answered that is still live, with
    your answers, moves you to the first, unfolding the archived messages when it is among them, and
    puts that message's text and details in their boxes. An answer to an ask the agent since revised
    or retracted stays with that message, and the line above the box says so. When the asks it
    changes have to load first, and the page learns meanwhile that the message was replaced, nothing
    is staged.
  - **Edit** in the options of your other messages changes their text and details, and drops their
    answers to asks the agent since revised or retracted. **Change answer** and **Edit** replace the
    whole message, so they need empty boxes with nothing staged. A replaced message folds into one
    line naming its replacement, and opens to show what it said; one replaced by a message carrying
    nothing reads **retracted in** that message, which says **Retracted #** and the number.
  - At the foot is a box labelled **Additional information** while you write answers and **Message**
    otherwise, a **Details** line under it that opens a second box for the message's details, and
    one **Send** button. The message box holds a summary of up to 1,000 characters, and **Details**
    up to 20,000; neither cuts what you type or paste, but while either is over, or there are
    details and no message, **Send** waits and the box says why. You can answer several asks at
    once, up to ten, and **Send** sends the answers, the text or both as one message. A line above
    the box names each answer or decline by its ask's number (**Ask 3: “Postgres”**), each with
    **Remove** to drop it, which also clears its card, as **Clear** on the card does; a change of
    answers or an edit shows as one line, removed whole there, and the cards of a change offer no
    **Clear**. **Send** is available only when there is something complete to send: **Other**
    without words is not, and its field says so once you leave it. Once ten cards hold answers, the
    other asks' choices are unavailable until you send or remove one. While a change or an edit is
    staged, nothing else can be started until you send or remove it, and removing it empties both
    boxes. An edit needs text.
  - This browser keeps your draft's text and details as you type, one draft for each thread, so
    leaving the thread or reloading the page loses nothing: the composer opens with them when you
    come back, and counts from where the draft started, so a message the agent wrote while you were
    away makes sending stale, as below. With the thread open in two tabs, the draft typed last is
    the one kept. What you staged, the files you attached and a recording are not kept: the composer
    says so when the draft it opens with had them, and sending it then posts its text as a new
    message. The text a change or an edit loads is kept only once you change it. **Discard draft**,
    under the boxes while they hold anything, asks once, then empties the composer and forgets the
    draft; a message that is sent forgets it, and one that fails to send keeps it. Reloading the
    page while a message is being sent brings its text back as the draft; if the message landed,
    sending the draft again fails as stale, with your message among those missed, so nothing is sent
    twice unseen. The browser forgets a draft 30 days after you last opened its thread or typed in
    it, keeps the latest 50, and forgets them all when you sign out here or remove the passkey it
    signed in with. A browser that refuses storage, as a private window may, keeps none, and the
    composer works as before.
  - Beside **Send**, **After sending** chooses where sending takes you once a message is sent:
    **Back to the list**, as **Threads** does, where the list says what was sent; **Stay here**;
    **Archive**, which archives this thread once the message lands and then goes where
    **Auto-advance** says, as **Archive all** does, so a reply that answers the last ask open to you
    can archive the thread too; or **Thread above** or **Thread below**, as their buttons do. The
    thread it takes you to says beside its **Send** what you sent, or the list does, saying too when
    you reached its end. If an ask is still open to you, the archive is refused and you stay on the
    thread, and beside **Send**, after what was sent, the page says which ask to answer or decline
    first; when the thread to open cannot be found, it says that there instead. While a message that
    will take you somewhere is on its way, **Thread above**, **Thread below** and **Archive all**
    wait for it, and while the page is moving to another thread or the list, **Send** and **After
    sending** wait for it. A message that fails to send stays on the page with your draft. It is
    **Back to the list** until you choose otherwise, and this browser keeps your choice. While you
    write, **Send** and its option stay at the foot of the screen, above a phone's keyboard, with
    what answers **Send** beside it: why a message failed to send above it, and what was sent after
    it. While voice is on, **Dictate** sits there too, and what it says goes in the same places: why
    dictation failed above, and anything else after. While a recording, its transcription or its
    **Retry** is there, **After sending** moves just below the row, so the row stays short above a
    phone's keyboard.
  - Under them, **Threads** again takes you back to the list as the head's does, so you can leave a
    thread you read without replying, and without scrolling back up.
  - While [voice](#voice) is on and the browser can record, **Dictate** sits beside **Send**. It
    records, showing how long against its limit of five minutes, until you choose **Stop**; then
    **Transcribing**, with **Cancel**, and the text goes in where the cursor was, in the box you
    were last in, with a space where it meets other text, for you to read and change. Nothing is
    sent until you send it. A transcript of nothing, or a recording too short to hold any, says
    **Nothing heard**. A transcription that fails says why and keeps your draft as it was, and the
    recording for **Retry**, beside **Discard**. A recording also stops when it reaches 1.9 MiB, or
    when you switch away from the page, so the microphone never runs while you are not looking, and
    what it recorded is transcribed as usual; if you are still away from the page when the
    microphone opens, it closes without recording, and leaving the thread discards a recording.
    Starting a recording counts as seeing the thread then: a message the agent writes while you
    record makes sending stale, as below.

  If the agent writes to the thread while you are writing, sending fails as stale: your draft stays,
  the messages you missed appear above it, and **Mark these read and send again** sends it, as it
  stands then, once you have read them. When those messages answered, revised or withdrew asks you
  were answering, the page says which and drops only those answers, clearing their cards; an answer
  your change held to an ask they revised or retracted stays with the message you are changing. When
  they replaced the message you were changing or editing, it drops the whole change or edit. Either
  way your text and details stay, and **Mark these read** leaves the rest for you to choose again.
  Once a message is sent, what you staged since that it made impossible to send goes the same way,
  without a word: an answer you changed meanwhile to an ask it answered, or a change or edit of the
  message it replaced.

- **The sessions view**, **Sessions**, shows every session of your agents in one place, and is also
  what `/registrations` shows, the page an agent waiting for approval sends you to. From the top:
  - **Waiting for approval** holds the registrations to approve, as
    [Approving agents](#approving-agents) describes. The **Sessions** tab counts them, and approving
    or rejecting them clears the count.
  - Everything in the view that stands for threads is a link opening the thread list on those
    threads alone, with no other filter on: a group's, an agent's or a session's name, a count of
    threads, the envelope, **Blocked on you**, open asks and stranded threads, each within the
    header or row it sits on, and a group's or a tag's chip, on the threads in that group or
    carrying that tag wherever they are. Following one never folds anything: the chevron before a
    name folds what it heads, as a click anywhere else on the header or the row does but on a link
    or a button.
  - **Agents** holds each agent under a header that folds, as the thread list's group headers do,
    with how many sessions it has and what they add up to: their threads' roll-up and unread updates
    as each session's row shows them, their open asks as each row shows its own, their stranded
    threads, and the agent's tags. At the header's end, its threads open the thread list on the
    agent's threads; how many of them are stranded, flagged while any are, opens it on those, as the
    **Stranded** filter does; and the **⋯** button opens **Tags**. Once you have put any session in
    a group, the agents fold under their groups, groups in your order and **No group** last, each
    group's head showing what its sessions add up to, with **Blocked on you** when an ask in them
    blocks an agent's work on your answer, and a link opening the thread list on the group's
    threads. An agent with sessions in two groups shows under each with that group's sessions, and
    its threads' links open its threads, and its stranded threads, in that group. This browser keeps
    the groups you fold, a group however you rename it. Under each agent, each session is a folded
    row, so that many fit on a screen. Its first line holds the session's name, the title its agent
    gave this line of work, cut to fit, and its percent toward the goal; the second, **Last seen**
    and when, or **Never seen**, in the warning's color while the session is quiet and has not
    stopped, and once it has reported a status, how long ago it last updated it, such as **status
    updated 2 hours ago**, since a session can go on checking Agention long after its status stopped
    saying what it does; a session marked working because it wrote counts as an update then. While a
    session is **Working**, its bridge reminds it to update its status once it has sent none for 20
    minutes, counting a write that marked it working. The bridge counts from the session's own last
    update through it, not from the age you see, so the two differ when the bridge has restarted or
    another bridge shares the session. The third line, wrapping on a phone:
    - what the session reports it is doing: **Working** while it does something; **Idle** while it
      has nothing left to do but wait, for your answers, CI or a review, and still checks Agention;
      **Stopped** once it stops checking, with why, such as **Stopped · completed**; or **No
      status** when it has never reported, such as one whose plugin predates session status;
    - its open asks, while it has any, whatever it is doing: a session working on one thing can wait
      on your answer about another. In the thread list's words, **Blocked on you** in red while any
      of them blocks its work on your answer, opening the thread list on the session's threads that
      do, then how many are open, such as **2 open asks**, opening it on the session's open threads;
    - **No credential**, when it has no active credential;
    - its group, in a chip with a dashed border, and its tags, each led by **#**;
    - its threads' roll-up, as the thread list's headers show theirs: how many threads you have not
      archived, which opens the thread list on the session; how many are stranded, flagged as on an
      agent's header, which opens it on those alone; the closed envelope with how many are unread,
      or the open envelope when none is, the closed one opening it on the session's unread threads.
      **Blocked on you** shows once, before its open asks, as on an agent's header;
    - its unread updates, such as **2 new updates**;
    - and its latest update's note, cut to fit, with none after the server marked it working.

    Choosing a row's chevron, or anywhere on it but its links and buttons, lets its title wrap whole
    and unfolds it to its goal over a bar of how far it has come, its credentials and its log: what
    each update changed, newest first, with its note, and **inferred from a write** on one the
    server logged when the idle session wrote. Consecutive updates that changed only the percent
    show as one line, such as **Progress 20% → 60%**, and **Older** shows the updates before.
    Unfolding reads the updates it shows, which stay marked unread until you fold the row again.
    Rows start folded each time you open the view, and a row under an agent or a group you folded
    reads nothing, since it is not shown. This browser keeps the agents you fold, under each group
    apart.

    A row's **⋯** button opens its options: **New thread**; **Group** and **Tags**, each naming what
    the session has now; and **Revoke** for each of the session's credentials, which asks once more.
    **New thread** opens a sheet for a title, the message and its details, as a thread's composer
    takes them, and **Send** starts the thread and opens it. The session's agent reads it as your
    words at its terminal and replies in it; the thread asks you nothing, since only agents ask.
    When the session has stopped, is quiet, has no active credential or is not connected, the sheet
    says it is not likely to see the thread, and why: a stopped session not until it is started
    again, a quiet one not soon, one without a credential not until you approve a registration for
    it, and one whose bridge is not connected not until it connects again. The thread is stranded
    until the session reads it.

  - Above the agents, as on the thread list, **Sort** and **Group** choose how they show, and the
    page's address keeps your choice, so going back to the view or a link to it shows it the same.
    **Group** folds them by **Group**, the default, as above; by **Agent**, each agent over its
    sessions, whether or not any is in a group; or by **Session**, each session's row on its own,
    named with its agent, such as **builder/main**, with no agent's header, so an agent's tags, its
    roll-up and its **Tags** option show only grouped by **Group** or **Agent**. **Sort** puts every
    level in order: **Alphabetic** by name; **Registration time** by when each session was first
    approved, a group or an agent by its earliest session; or **Manual**, offered only grouped by
    **Group**, which keeps your groups in your order and their agents and sessions in name order.
    The button beside **Sort** says which way it runs, **A to Z** or **Newest first**, and choosing
    it reverses it; **Manual** has no direction, and **No group** comes last whichever way. Choosing
    another sort starts it in its own direction, and grouping by **Agent** or **Session** while
    sorted **Manual** sorts **Alphabetic**. In **Manual**, each group's head ends in **Move up** and
    **Move down**, and, with a mouse, a handle to drag it onto another group's head and put it in
    that one's place, which changes your groups' order everywhere, as
    [Groups and tags](#groups-and-tags) does in Settings. While a move is under way, the groups take
    no other; one another browser made stale is refused, and the groups show as they are.

  - **Credentials and past requests**, folded until you open it, holds every registration already
    decided.

- **Settings** is in sections, each at its own address under `/settings/`: under **Access**, your
  **Passkeys** (`/settings/passkeys`), as [Signing in](#signing-in) describes, and **API keys**
  (`/settings/api-keys`), as [API keys](#api-keys) describes; under **Features**, **Threads**
  (`/settings/threads`), whose **Auto-advance** chooses where archiving a thread takes you, as
  [Using the web UI](#using-the-web-ui) describes, **Groups and tags**
  (`/settings/groups-and-tags`), as [Groups and tags](#groups-and-tags) describes, **Voice**
  (`/settings/voice`), as [Voice](#voice) describes, **Storage** (`/settings/storage`), as
  [Attachments](#attachments) describes, and **Keyboard** (`/settings/keyboard`), as
  [Keyboard shortcuts](#keyboard-shortcuts) describes; and **Sign out** (`/settings/sign-out`),
  which signs this browser out, forgetting the drafts it kept, and leaves your others signed in. On
  a wide screen the sections are listed beside the one open; on a phone Settings opens on the list,
  and each section has a link back to it. `/passkeys` leads to Passkeys. While your sign-in is too
  old for a change to passkeys, API keys or voice, those sections offer **Sign in again** first.

A message's text and details are Markdown with GitHub's tables, task lists and strikethrough, shown
inert: raw HTML shows as text, an image written in Markdown shows as a link and never loads, unlike
a file attached to the message, and only absolute `https` links are live, opening in a new tab. A
link whose text is not its own address shows the address's host after it. Titles, questions,
suggested answers, the own words of an answer and other fields show exactly as written, as plain
text.

A fenced code block whose language is `mermaid` shows as a diagram, drawn by
[Mermaid](https://mermaid.js.org/) in isolation from the page, as an image at its natural size, no
wider than the column. Its alternative text is the title the diagram declares with `accTitle`, or
"Diagram" without one, and a description it declares with `accDescr` describes it to a screen
reader. **Source** under the diagram shows the text it was drawn from. A diagram over 10,000
characters shows its source instead, with a note that it is too long to draw; one Mermaid cannot
draw, and one not drawn within 10 seconds, show their source with a note that it could not be drawn.
The first diagram on a page also waits for the drawing script to download, for up to a minute on a
slow connection. Diagrams follow the light or dark color scheme, and are drawn again when it
changes.

Tap a diagram to open it full screen. Pinch or use the mouse wheel to zoom, drag to move it, and
double-tap to zoom in on a point or back out to fit; the buttons and the keys `+` and `-` zoom, `0`
fits it to the screen and `1` shows it at its actual size. Escape or **Close** returns to the
message. Outside the viewer, the browser's own zoom works on the page as usual.

### Groups and tags

Session groups and tags organize your views, nothing else: agents never see them, and they grant
nothing. A session sits in at most one group, such as **Billing migration** or **Personal:
website**, and you can tag agents and sessions across groups, such as **infra**; a tag on an agent
counts for each of its sessions. The thread list filters by both and, grouped by **Group**, folds
the sessions under their groups, and the sessions view folds the agents under their groups, as
[Using the web UI](#using-the-web-ui) says.

Each group and each tag has a color, one of gray, red, orange, yellow, green, teal, blue and purple,
which its chip shows wherever it appears; a new one takes the next color in turn until you choose
another. Your groups keep the order you give them, here or in the sessions view sorted **Manual**,
which the sessions view and the thread list's **Group** filter follow; a new group goes last.

- **Group**, in a session's options, opens a picker beside the menu, or rising from the bottom on a
  phone: a search box over your groups in your order, each a chip, the session's own checked.
  Choosing one puts the session in it at once and closes the picker; there is no **Save**. **Clear
  group**, shown while the session is in one, puts it in none. Typing a name no group has offers
  **Create group** with it, which creates the group and puts the session in it. A group's name is up
  to 100 characters on one line and unique, whatever the case of its letters, and you can have up to
  200 groups.
- **Tags**, in a session's options or at the end of an agent's header, opens a picker of every tag,
  those it carries checked. Choosing a tag puts it on or takes it off at once, and the picker stays
  open for more, taking your next choice once that one has applied. When one fails, the picker says
  why and shows the tags as they are. Typing a name no tag has offers **Create tag** with it. A tag
  is a name like a topic's: up to 63 lowercase letters, digits, `-` and `_`, starting with a letter
  or digit. An agent or a session carries up to 20 tags, and you can keep up to 500 tags in all.
- In either picker the arrow keys move through the list from the search box and Enter chooses.
  Escape clears what you typed, or, with nothing typed, closes the picker, as **Done** or a tap
  outside does, every choice already made.
- **Settings**, under **Groups and tags** (`/settings/groups-and-tags`), lists your groups in your
  order and your tags in name order, each list with a search box and **New**. Each shows as its chip
  with what it holds, how many sessions a group holds or how many agents and sessions carry a tag,
  which opens the thread list on those threads, and with **Rename**, its color and **Remove**.
  Renaming keeps a group's sessions, and the thread list's filters and folds on it keep working; a
  name another group or tag has is refused. Renaming a tag renames it everywhere it is carried.
  Choosing a color applies it at once. **Remove** asks first, saying what it takes the group or tag
  off: removing a group leaves its sessions in no group, and removing a tag takes it off everything
  that carries it. A tag nothing carries stays until you remove it. Each group's **Move up** and
  **Move down** buttons move it in the order, and with a mouse you can drag a group by its handle
  onto another to put it in that one's place; while a search narrows the list, groups do not move.
  When another browser changed the groups since the list loaded, the move is refused and the list
  shows them as they are.

### Keyboard shortcuts

With a keyboard, single keys do the everyday things, in the manner of mail and code-review tools.
They act only while focus is outside a text field, an open menu and a dialog, and never with Ctrl,
Alt or Cmd held unless the key needs it; AltGr, which types a key such as `]` on many keyboards,
counts as none for the punctuation it types, though Ctrl and Alt with a letter, a digit or a key
that types nothing, such as Esc, never act. On a phone without a keyboard nothing changes. Press `?`
anywhere to list them all.

| Where           | Key                         | What it does                                                                                                              |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Anywhere        | `?`                         | Lists the shortcuts                                                                                                       |
| Anywhere        | `g` then `t`, `s` or `,`    | Goes to Threads, Sessions or Settings, the second key within 1.5 seconds; any other key after `g` does what it does alone |
| The thread list | `j` and `k`                 | Moves to the next or previous thread, stopping at either end                                                              |
| The thread list | `n` and `N`                 | Moves to the next or previous thread that is unread or blocked on you, going round                                        |
| The thread list | `o`                         | Opens the thread, as `Enter` on its row does                                                                              |
| The thread list | `/`                         | Opens **Filters** on its search box                                                                                       |
| A thread        | `u` or `Esc`                | Returns to the thread list                                                                                                |
| A thread        | `r`                         | Puts focus in the composer's message box                                                                                  |
| A thread        | `e`                         | **Archive all**, while it is available, then where **Auto-advance** says                                                  |
| A thread        | `[` and `]`                 | **Thread above** and **Thread below**                                                                                     |
| A thread        | `n`                         | **Jump to unread**, or **Jump to open ask**                                                                               |
| A thread        | `1` to `9`                  | Chooses that suggested answer on the ask that has focus, or else the first open ask                                       |
| The composer    | `Ctrl+Enter` or `Cmd+Enter` | **Send**, once there is something to send                                                                                 |
| The composer    | `Esc`                       | Leaves the composer for its heading, where the thread's keys act again                                                    |

Leaving a thread with `u`, `Esc` or a `g` key keeps its draft, as leaving it any other way does.
Moving through the list moves focus from row to row, so a screen reader reads each row as it is
reached. With the list and a thread side by side, the list's keys act wherever focus is, and moving
through the list starts from the open thread's row and opens nothing until `o`; the thread's keys
act only while focus is outside the list, as after clicking the thread; and `n`, which both use,
acts in the list while focus is in it, and in the thread otherwise. A screen reader in its browse
mode keeps single keys for its own navigation, so the shortcuts act only once it passes keys
through, as in its focus mode. To turn the shortcuts listed here off in this browser, if they get in
the way of a screen reader, voice control or another tool, clear **Keyboard shortcuts** in
**Settings**, under **Keyboard**, which also lists them. The diagram viewer's own keys stay on.

## Voice

Voice lets you dictate a reply in a thread instead of typing it, and is off until you set it up. A
transcription provider turns your recording into text: you choose it in **Settings**, under
**Voice**, and the server sends it each recording with a key it holds, and returns only the text.
The provider receives your recordings, so turning voice on means choosing who does, under their
terms. Agention keeps neither the recording nor the text, and agents never see either: they read
only what you send. Reading a message aloud needs none of this: the browser speaks on your device.

**Set up** shows the form:

- **Provider**: **OpenAI**, **Groq**, each filling in its base URL and model, or **Your own
  server**, any service speaking the OpenAI-compatible transcription API, such as a Whisper server
  on your own network.
- **Base URL**: the address the API is under, such as `https://api.openai.com/v1`; the server sends
  recordings to `audio/transcriptions` beneath it. It must use `https`, unless it is `localhost` or
  an IP address on your own network (loopback, a private range, a tailnet's `100.64.0.0/10` or a
  unique local IPv6 address), which may use plain `http`; then your key and your recordings cross
  that network unencrypted, and Settings say so. A local server can also be reached over `https`
  through `tailscale serve`. It carries no user name, query or fragment, and the server follows no
  redirect from it: a provider that answers with one fails, saying it tried to redirect, so give the
  address it redirects to instead. It never names a link-local address, nor a cloud's metadata
  address outside one (`100.100.100.200`, `fd00:ec2::254` and `fd20:ce::254`), nor a local-use NAT64
  address (`64:ff9b:1::/48`); a host name over `https` is not checked by its address, since the
  provider's certificate is what proves where it goes.
- **Model**: as the provider names it, such as `gpt-transcribe` or `whisper-large-v3-turbo`.
- **Additional context**: optional, up to 500 characters of background the transcription can use,
  such as what you talk about, names and terms. Whisper models read only its last 224 tokens, so a
  long context can lose its start. A transcript that only repeats the context, as Whisper sometimes
  answers silence, says **Nothing heard**.
- **Key**: the provider's key, up to 1,024 characters. OpenAI and Groq need one; your own server may
  not. It is kept on the server and never shown again whole: once saved, its field shows it masked
  but for its last four characters, so you can tell which key it is, with **Replace** to enter
  another. A key shorter than 16 characters shows masked throughout. A key goes only to the base URL
  it was entered for, so changing the base URL clears it: as you change it, the key's field shows
  again, saying so, for you to enter it.

Below the form, Settings say where your recordings go, with a link to what OpenAI or Groq say about
keeping them and training on them. **Save** turns voice on, or saves your changes; **Turn off**
deletes the settings and the key; **Cancel**, while you set voice up, leaves it off. Saving and
turning off need a sign-in within the last 10 minutes. Settings saved by an earlier release that the
rules now refuse show as no longer valid, and voice does not use them until you clear them, with
**Clear saved settings**, or save new ones. Once voice is on, **Try it** records a few words and
shows the text, through the same path dictation takes.

A recording is at most five minutes, and must reach the server within 30 seconds, which for five
minutes asks about 330 kbit/s of upload; a slower connection fails with the recording kept for a
retry. The provider has a minute to answer.

### Voice from the environment

The server can also take the base URL, the model and the key from its environment, each exactly as
if entered in Settings and under the same rules:

| Variable                       | Supplies     |
| ------------------------------ | ------------ |
| `AGENTION_TRANSCRIPTION_URL`   | The base URL |
| `AGENTION_TRANSCRIPTION_MODEL` | The model    |
| `AGENTION_TRANSCRIPTION_KEY`   | The key      |

`agention serve` reads them once, at start. A value that breaks the rules stops it with a message
that names the variable and never shows the value. An empty value is such a value, not the variable
left unset, so delete a line rather than blank it. `AGENTION_TRANSCRIPTION_KEY` without
`AGENTION_TRANSCRIPTION_URL` stops it too, so a key from the environment only goes to an address
from it. In Settings, what the environment supplies shows as set there and cannot be changed: the
base URL and the model as their values, and a key masked but for its last four characters. A key
saved in Settings is used only while the base URL in effect is the one it was entered for, so a new
`AGENTION_TRANSCRIPTION_URL` leaves it unused until you enter it again. With both the base URL and
the model from the environment, **Turn off** reads **Clear saved settings**, and voice stays on
until you remove the variable and restart the server. With only the base URL from it, the model is
saved in Settings, so **Turn off** still turns voice off: it deletes the saved model, additional
context and key, and the base URL stays.

Keep them in an environment file only you can read, not in the unit or the plist itself, each value
in single quotes:

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

launchd has no environment file of its own, so have the plist start a shell that reads the file and
then runs the server, in place of starting `node` directly: its `ProgramArguments` become these
three strings, with your paths, origin and home directory, then `bootout` and `bootstrap` it again
as [macOS: a launchd agent](#macos-a-launchd-agent) shows. Like the rest of the launchd setup, this
is untested.

```xml
<string>/bin/sh</string>
<string>-c</string>
<string>set -a; . /Users/you/.config/agention/voice.env; exec /usr/local/bin/node /usr/local/bin/agention serve --data /Users/you/.local/share/agention --origin https://agention.example.com</string>
```

A backup holds what Settings saved, a key among it, but never the environment, which stays with the
service.

## Attachments

You and your agents can attach files to messages: a screenshot, a log, a report, a photo from your
phone. A file belongs to the message that brought it, under its name, for good; editing that message
carries its files to the new version unless you remove them, and the earlier version keeps them too.

- **Attaching.** **Attach**, the paper clip beside **Send**, opens your device's file picker. On a
  phone or a tablet it opens a menu instead: **Take a photo** and **Record a video** open the
  camera, **Photos and videos** your device's photos and videos, and **Other files** documents and
  text, such as PDFs, office files and archives. A laptop whose screen also takes touch keeps the
  file picker. Pasting a screenshot or another image into the message box or **Details** attaches
  it, named by when you pasted it, such as `pasted-20261122-143005.png`; a paste that carries text,
  as from a spreadsheet, pastes the text. Each file uploads as soon as you add it, one at a time,
  with its progress in the list above the box. **Remove** takes a file off the message, stopping its
  upload or removing it from the server; **Retry** sends again one that failed, and **Upload again**
  one the server no longer holds. **Send** waits until every file has uploaded, and says what it
  waits on. A message may be files alone. A file you upload and never send is removed a day later.
- **What shows in place.** Each file shows its name, type and size, and **Download**. An image up to
  2 MiB shows at once, and a larger one, such as a phone's photo, behind **Show image**. Video and
  audio play in the page, loading nothing until you play them. Text, code and logs show behind
  **Show text**, the first 256 KiB of them. A PDF opens in a new tab, in the browser's own viewer.
  Anything else downloads. A file whose bytes are gone shows as **Missing**. A message's text can
  link to one of its own files as `[the log](attachment:build.log)`, or
  `[the log](<attachment:build log.txt>)` for a name with spaces, which opens it as its entry does.
  Media opened in a tab of its own, as from a context menu's **Open video in new tab**, does not
  play there, by design: a file opened on its own runs as nothing of Agention's, without your
  sign-in, so play it in the page or download it.
- **The thread's files.** **Files** in the thread's head, folded on every visit, lists every file
  the thread holds, newest first, each with who attached it, when, and a link to its message.
- **Limits.** A file is at most 100 MiB, and a message carries at most 10. You, with whatever your
  API keys upload, and each agent session, can hold at most 20 files, and 1 GiB, uploaded and not
  yet sent, so a program of yours that uploads files and never sends them can use up your share
  until they expire a day later; a file you remove before sending stops counting at once, unless you
  remove it the instant its last bytes leave or the connection fails as you remove it, when it
  counts until it is removed a day later. The server refuses an upload, saying its disk is too full,
  unless the disk holding its data directory keeps 1 GiB free beyond the files arriving. An upload
  has no time limit as long as its bytes keep moving, but stops after 30 seconds without any, so a
  slow link finishes and a dead one fails.
- **Photos keep their metadata.** Agention changes nothing in a file, so a photo keeps what its
  camera recorded, its location among it, and an agent that fetches it can read that. Remove the
  location before attaching a photo you would not share it with, or turn it off in the camera.
- **Storage.** **Settings** shows, under **Storage**, how much space attachments take, in how many
  files. Files live in the database, so every backup copies them all, and grows as they do
  ([Backing up](#backing-up)).
- **Your browser keeps them.** A browser keeps the files it showed in its cache for up to a year,
  after signing out too, so on a shared device clear its data for the server's site.

Agents attach and fetch files with the bridge's `file_upload` and `file_get` tools, as
[Agents](#agents) describes.

## API keys

An API key lets a program you run, such as a tool that already shows your agents, call Agention's
operator API as you, within the scopes you give it. You create and revoke keys in **Settings**,
under **API keys**. **Create an API key** asks for:

- **Name**: up to 50 characters on one line, such as the program that will hold the key.
- **Scopes**: what the key may do, as you, at least one of them:

  | Scope              | What it grants                                                                                                                                                                                                                                    |
  | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `threads:read`     | Reading the thread list and its counts, the threads above and below one in it, any thread with its messages and its files, and waiting for new messages in any session                                                                            |
  | `threads:write`    | Also starting threads, writing in them, answering asks, uploading files to attach and removing those not yet sent, and marking threads read, unread or archived, one at a time or in bulk                                                         |
  | `sessions:read`    | Reading the sessions view with its agents, groups and tags, each session's log, and agents' registrations                                                                                                                                         |
  | `sessions:write`   | Also marking a session's log read, and managing groups and tags: creating, renaming, recoloring, ordering and removing groups, creating, renaming, recoloring and removing tags, and setting a session's group and an agent's or a session's tags |
  | `sessions:approve` | Also approving, rejecting and revoking agents' registrations; with `sessions:write` too, an approval can also set the session's group and tags                                                                                                    |

  A write or approve scope includes its resource's read, so choosing `threads:write` chooses
  `threads:read` with it; `sessions:write` and `sessions:approve` include neither the other.
  `sessions:approve` lets whoever holds the key let an agent into your sessions, where it writes to
  you as any agent does, so give it only to a program that decides registrations for you. Whatever
  its scopes, no key can manage keys, passkeys or Settings, Storage among them, or dictate: those
  need your passkey.

- **Expiry**: 7, 30 (the default), 60 or 90 days; a date you choose, up to a year away, through
  whose end the key works; or no expiry. A key without an expiry works until you revoke it, so if it
  leaks, whoever holds it can act as you, within its scopes, until you notice: Settings warn when
  you choose it, and the list marks such a key **No expiry**. Choose an expiry unless the program
  truly needs a key that lasts.

**Create key** then shows the key, `agention_` and 43 more letters, digits, `-` and `_`, once:
**Copy** copies it, or selects it where the browser will not copy, and **Done** puts it away. The
server keeps only a hash of the key, so Agention can never show it again: keep it as you would a
password, in your password manager or the program's own secret store, and if you lose it, revoke it
and create another.

The list shows each key's name and scopes, when it was created, when it expires and when it was last
used, to within an hour. **Revoke**, which asks first, ends a key at once: the program's next
request is refused, and so is a wait it holds. Replacing your passkeys with `agention passkey-link`
revokes every key ([Signing in](#signing-in)). A revoked or expired key stays listed, marked so,
until you next create or revoke a key. Creating and revoking a key need a sign-in within the last 10
minutes, and the section offers **Sign in again** while yours is older. You can hold up to 20 keys
that are neither revoked nor expired.

### Using the operator API

The operator API is at your origin under `/api/operator/v1/`. Every request carries an API key as a
bearer token, `Authorization: Bearer agention_...`, and no cookie, since a request carrying one is
refused. A key that is mistyped, revoked or expired is refused as `unauthenticated`, status 401, and
an operation outside the key's scopes answers `not_found`, status 404, as if it did not exist.
`GET /api/operator` lists the versions the server serves. A version changes only by additions, so a
program written against version 1 keeps working while the server serves it, as long as it ignores
fields it does not know.

To see every operation, with its scope, parameters and answer, start the server with `--api-docs`:
it then serves the documentation at `/docs/api/`, and the OpenAPI document that client generators
read at `/docs/api/openapi.json`, both without sign-in, so anyone who reaches the origin can read
them; they describe the API, never your data. The same document is in Agention's repository, at
`docs/api/openapi.json`.

For example, in bash, with your origin in `origin` and a key holding `sessions:read` and
`threads:read` read into `key` from a file only you can read, so it stays out of your shell's
history:

```bash
origin=https://agention.example.com
key="$(cat ~/.config/my-tool/agention-key)"
auth() { printf 'Authorization: Bearer %s\n' "$key"; }
curl -sS -H @<(auth) "$origin/api/operator/v1/sessions"
curl -sS -H @<(auth) "$origin/api/operator/v1/wait?wait=25"
```

`-H @<(auth)` has curl read the header from a file that bash's own `printf` writes, so the key is
never among a command's arguments, which anyone on the machine can read in its process list for as
long as the command runs.

The first lists your agents with their sessions. Each session's `presence` says when its agent last
checked in (`last_seen_at`), whether it is quiet, and whether its bridge is `connected`, absent for
a bridge from before the background connection; while it is connected, `monitor` holds what its
bridge last reported of the terminal it runs in: whether it watches one at all and, if it does, the
session's `condition` and `since` when, what `stopped_by` it where the bridge can tell, and the
`profile` it reads the terminal with. The second answers at once with the threads, in any session,
holding messages you have not read, each naming its agent and session; with none, it waits up to 25
seconds for one. Its answer also holds a `since`: pass that back, as `wait?wait=25&since=...`, to be
told only of messages newer than those it covered, so a program that waits in a loop hears of each
new message once, as soon as it arrives, without polling. Each key has a rate budget of its own
([Rate budgets](#rate-budgets)).

Files work as they do in the web UI ([Attachments](#attachments)): a key holding `threads:write`
uploads a file to a session, then names the upload in a message, and a key holding `threads:read`
lists a thread's files and reads them. An upload is yours, as the key's messages are, so it counts
against your own pending uploads, and you can name it in a message from the web UI too. Continuing
the example, with a key holding `threads:write`:

```bash
s="$origin/api/operator/v1/s/builder/main"
curl -sS -H @<(auth) -H 'Content-Type: text/plain' --data-binary @build.log \
  "$s/uploads?name=build.log"
curl -sS -H @<(auth) -H 'Content-Type: application/json' \
  -d '{"request_id":"log-1","seen_through":4,"attachments":[{"upload":"<upload>"}]}' \
  "$s/threads/12/messages"
curl -sS -H @<(auth) "$s/threads/12/files"
curl -sS -H @<(auth) -o fetched.log "$s/threads/12/messages/5/files/build.log"
curl -sS -H @<(auth) -H 'Range: bytes=-4096' "$s/threads/12/messages/5/files/build.log"
```

The first uploads `build.log`, its bytes as they are, declaring its type in `Content-Type`, and
answers with its reference, `upload`, which the second names in a message to thread 12 of
`builder/main`, with `seen_through` the latest message you have seen there. Until a message names
it, `POST $s/uploads/<upload>/remove` removes it; once a message carries a file it stays with that
message for good, and removing it is refused. The third lists the thread's files, each with the
message that carries it, and the fourth reads one by that message and its name there, here message
5, into `fetched.log`. The last reads only its final 4 KiB, answered `206`; the server answers one
range as asked, a range outside the file `416`, and any other `Range` with the whole file.

## Agents

Agents reach Agention through the agent bridge, `agention-mcp`, an MCP server that the Agention
plugin for Claude Code or Codex starts for each agent session. The bridge reads its settings from
the environment the agent host gives it:

| Variable                   | Meaning                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `AGENTION_URL`             | The server's origin, spelled as `--origin` gives it; required                                                       |
| `AGENTION_CONNECT`         | A host and port to connect to in place of the origin's, such as a tunnel's; optional                                |
| `AGENTION_TMUX_SOCKET`     | The socket of the tmux server this session's agent host runs in, set per session, to monitor its terminal; optional |
| `AGENTION_HARNESS_PROFILE` | How to read that terminal, `auto` by default ([Monitoring a session's terminal](#monitoring-a-sessions-terminal))   |
| `AGENTWORKS_AGENT`         | The agent's name, unless the agent's `register` call gives one                                                      |
| `AGENTWORKS_SESSION`       | The session's name, unless the agent's `register` call gives one                                                    |
| `NODE_EXTRA_CA_CERTS`      | Node's own setting: a file of certificate authorities to trust, for a server with a private one                     |

Names are 1 to 63 of `a-z`, `0-9`, `_` and `-`, starting with a letter or digit. The bridge needs
Node.js 24 or later, and refuses to work while `NODE_TLS_REJECT_UNAUTHORIZED` is `0`, which would
let its tokens cross TLS that Node has not verified.

An agent session registers by calling the bridge's `register` tool. The first time, the bridge makes
a key for the session, keeps it in `~/.config/agention/<server>/<agent>/<session>/key.pem`, and
gives the agent a code, such as `7KQ2M-X9D4R`, to relay to you. Approving the registration with that
code lets the key act as the agent and session you choose; approve only a code an agent relayed, as
[Approving agents](#approving-agents) describes. A registration not approved within an hour expires.
If you reject or revoke a session's key, its next `register` call makes a new key with a new code.
Sessions run by the same operating-system user can use each other's keys, so run agents that must
not act as each other as different users; [SECURITY.md](../SECURITY.md#the-agent-bridge) says what
the bridge keeps and sends.

The key file is private to the agent's user, under the rule
[SECURITY.md](../SECURITY.md#private-files) states, as the server's database is. That user's home
directory must exist, and the bridge creates only the directories below it. Until the rule holds,
the bridge's tools answer with what to change, such as running `chmod go-w ~`; the bridge changes
nothing that exists.

An agent sends a file with `file_upload`, by its path on the agent's machine, then names the upload
in a message. The bridge sends only a regular file of up to 100 MiB, and never a file in its own key
directory. `file_get` fetches a file a message carries into `~/.cache/agention/files/`, private to
the agent's user like the key directory, named by the file's reference rather than its sender's
name, and removes what it fetched more than a week ago; you may clear that directory whenever you
like. A fetched PNG, JPEG, GIF or WebP image of up to 3.5 MiB also reaches the agent's model as an
image; a larger one, or an image of another type, reaches it by its path alone. Given an image it
cannot read, such as one whose bytes are broken, Claude Code leaves its note in its place, and the
call still succeeds.

Each upload is one request of the agent session's [rate budget](#rate-budgets), as every call is, so
an agent sending many files in a burst can be refused as `rate_limited`; the refusal says how many
seconds to wait, as its `Retry-After` header does, and `file_upload`'s description tells the agent
to wait that long and call it again. Your own uploads spend no budget.

An agent host limits how long one tool call may take, and a large file on a slow link can take
longer than a host allows. The Codex plugin sets Codex's limit to 10 minutes for the bridge's tools,
in place of its default of one minute. Claude Code's own limit is long enough by default; it reads
it from the `MCP_TOOL_TIMEOUT` environment variable, in milliseconds, should you have set a shorter
one.

### Installing the plugins

Install the Agention plugin on each machine where your agents run, from the plugin marketplace in
Agention's repository. Pinning the marketplace to a release's tag is the safer choice: the plugin's
skill then describes exactly the bridge it runs. Between releases, `main`'s skill can describe what
the bridge it pins does not do yet, so install from `main`, unpinned, only to follow changes as they
merge.

To pin it to a release, here 0.1.0, in Claude Code:

```bash
claude plugin marketplace add WayfarerLabs/agention#v0.1.0
claude plugin install agention@agention
```

In Codex:

```bash
codex plugin marketplace add WayfarerLabs/agention --ref v0.1.0
codex plugin add agention@agention
```

To install from `main` instead, leave out `#v0.1.0` or `--ref v0.1.0`.

Sessions started after that have the plugin. It carries the skill that tells an agent how to use
Agention, and runs the bridge with `npx` at the version it pins, which npm fetches the first time.
With the plugin, an agent asks you everything through Agention, never waiting at its terminal, and
also shows at its terminal whatever it sends you in Agention, so you can follow either one. It takes
what you write in Agention as it takes what you type at its terminal, brings its threads in line
with what you tell it at its terminal, and keeps checking for your answers while any are open.

Then give the bridge the server's origin in `AGENTION_URL`. Claude Code gives the bridge its whole
environment, and Codex gives it only a few common variables and those the plugin lists, which
include the bridge's settings above, so a variable set in your shell profile, such as `~/.bashrc` or
`~/.zshrc`, reaches the bridge in either host started from that shell:

```bash
export AGENTION_URL=https://agention.example.com
```

Claude Code also passes the `env` of its
[settings](https://code.claude.com/docs/en/settings-reference#env) to the processes it starts, the
bridge among them, so `"env": { "AGENTION_URL": "https://agention.example.com" }` in
`~/.claude/settings.json` reaches the bridge in Claude Code without a shell profile.

An agent's first call to Agention registers its session, which then waits for your approval. When
the bridge can't work, because a setting is missing or wrong or the server can't be reached, the
agent tells you at its terminal what to change. The agent host gives the bridge its settings when
the session starts, so after changing one, restart the session from a shell that has the change, a
new terminal if you changed a shell profile; resuming it, with `claude --continue` or
`codex resume --last`, keeps its conversation.

### Monitoring a session's terminal

Once you approve a session, its bridge holds a background connection to the server, so the operator
API's session reads say whether the session's bridge is connected, apart from when its agent last
checked in ([Using the operator API](#using-the-operator-api)). Given the tmux server its agent host
runs in, the bridge also monitors the session's terminal and reports its condition: unknown, at a
permission prompt or another prompt, running, at its prompt, or waiting, and since when. It reads
the screen of that server's one pane on the agent's machine and sends only the condition and its
time, never the screen's text.

The bridge takes the tmux server's socket and how to read the terminal from options or variables, an
option winning over its variable:

| Option              | Variable                   | Value                                                                                                                                                          |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tmux-socket`     | `AGENTION_TMUX_SOCKET`     | The tmux server's socket path. Without it the bridge monitors no terminal.                                                                                     |
| `--harness-profile` | `AGENTION_HARNESS_PROFILE` | `auto`, the default, for the agent host the bridge runs under; `claude-code` or `codex` to name one; or `generic-strict` or `generic-lenient` for another host |

Monitoring needs Linux, for `/proc`, and tmux 3.3 or later on the agent's machine.

The socket names one session's tmux server, so set `AGENTION_TMUX_SOCKET` in that session's own
environment, never globally (in a shell profile beside `AGENTION_URL`, say): the plugins start the
bridge without options and pass it both variables, so every session started from that shell would
name the same pane. The bridge never guesses the socket from the tmux it runs in. The tmux server
must hold just the agent host's pane, as each Agentworks session's does; with more than one pane,
the condition is unknown. Inside the session's tmux, `tmux display-message -p '#{socket_path}'`
prints the socket's path. Agentworks runs every session in a tmux server of its own, and until it
sets `AGENTION_TMUX_SOCKET` itself, set it by hand in the session's shell before starting the agent
host there:

```sh
export AGENTION_TMUX_SOCKET="${TMUX%%,*}"
claude
```

The bridge reads the pane only while the pane's first process is an ancestor of the bridge, which
the agent host started, so a socket that names another session's pane reads as unknown. The host
must hold the pane's terminal itself: started in the pane directly, or by a wrapper that execs it,
such as `exec claude`. A wrapper that runs the host as its child instead, such as a script without
`exec`, keeps the terminal's foreground from the pane's first process, and the condition reads as
unknown.

`auto` reads the terminal with what Agention knows of the host that started the bridge, Claude Code
or Codex, and with the strict generic profile for any other. The generic profiles tell only whether
the host is running or waiting at what looks like its input line, the strict one more cautiously,
and never name a prompt.

The condition is advisory: whatever runs in the pane draws the screen it is read from, so a screen
can imitate a dialog, and an agent can report its own session's condition, or keep it connected,
with its own key, as it reports its status, on the honor system of [SECURITY.md](../SECURITY.md).
Use it to find the sessions to look at, not as proof of what one is doing.

A setting monitoring can't use never stops the bridge or its tools. The bridge logs it to its
standard error, once each time the problem begins, and reports the condition as unknown: a socket no
tmux server listens on, a path too long for a socket, no `tmux` command, a machine without `/proc`,
a tmux that leaves the pane's formats empty, a pane that does not run the bridge's host, more than
one pane, or a pane whose first process no longer holds the terminal. A profile name it doesn't know
is logged once, and the strict generic profile reads the terminal instead.

Several bridges can run for one session, as Codex starts a new one without ending the old; only the
one the agent called last reports.

### Reaching the server through a tunnel

Some machines where agents run accept connections but can't open one to the server, such as virtual
machines on another network, or another tailnet, whose rules let connections reach them but not
leave for the server. The server's machine can then hold an SSH reverse tunnel into each of them: a
forward from a port on the agent machine's loopback, such as `127.0.0.1:8443`, to the server's
origin. The bridge there opens its connections at that port, set in `AGENTION_CONNECT`, while
everything else still names the origin.

TLS stays end to end. The tunnel carries the bridge's TLS connection to whatever serves the origin,
and the bridge checks the certificate against the origin's host name, as it does without a tunnel.
Authentication is unchanged: agents register, and you approve them, as anywhere else. While the
tunnel is up, every user on the agent machine can reach the server's sign-in page and agent API
through its port, even a server otherwise reachable only on a private network; as from anywhere
else, a registration still waits for your approval, and nothing can be read without an approved key
or your passkey. While the tunnel is down, anyone on the agent machine can listen at its port, but
can't present the server's certificate, so the bridge sends them nothing, and its agent tells you
that the server can't be reached at the address in `AGENTION_CONNECT`.

What the tunnel adds is the server machine's SSH key on each agent machine, which the steps below
limit to that one forward. The key's options and the `Match` block below have been tested with
OpenSSH 9.2; the rest of these steps have not been run yet. They use port 8443 on the agent
machine's loopback; any free port works, the same one in the key's line, the tunnel and
`AGENTION_CONNECT`.

On each agent machine, with `sudo`:

1. Create a user for the tunnel alone, which needs no shell, and its `authorized_keys` file. The
   file and its directory must belong to that user and be writable by it alone, or the SSH server
   ignores them:

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin agention-tunnel
   sudo install -d -m 700 -o agention-tunnel -g agention-tunnel /home/agention-tunnel/.ssh
   sudo install -m 600 -o agention-tunnel -g agention-tunnel /dev/null /home/agention-tunnel/.ssh/authorized_keys
   ```

2. Put this line in that file, such as with `sudoedit /home/agention-tunnel/.ssh/authorized_keys`,
   with the public key the server's machine makes below in place of `ssh-ed25519 AAAA...`:

   ```text
   restrict,port-forwarding,permitlisten="127.0.0.1:8443",command="false" ssh-ed25519 AAAA... agention-tunnel
   ```

   `restrict` turns off everything the key could do beyond logging in, `port-forwarding` turns
   forwarding back on, `permitlisten` lets the key's forwards listen only at the tunnel's port, and
   `command` replaces any shell or command the key asks for.

3. Turn off the forwards that a key's options can't: those into this machine, which `ssh -L` and
   `ssh -D` make, and those of Unix sockets. Keep the tunnel's port on loopback whatever the rest of
   the file says, since `GatewayPorts yes` would otherwise open it on every address. Have the SSH
   server also drop a tunnel's connection that stops answering, which frees its port for the next
   connection within about two minutes. Add this at the end of `/etc/ssh/sshd_config`, check it with
   `sudo sshd -t`, and reload the SSH server, with `sudo systemctl reload ssh` on Debian and Ubuntu
   or `sudo systemctl reload sshd` elsewhere:

   ```text
   Match User agention-tunnel
       AllowTcpForwarding remote
       AllowStreamLocalForwarding no
       GatewayPorts no
       ClientAliveInterval 15
       ClientAliveCountMax 3
   ```

On the server's machine, as the user that runs the server:

1. Make a key for the tunnels, without a passphrase, since nobody is there to type it, and use its
   public half, `~/.ssh/agention-tunnel.pub`, in the line above:

   ```bash
   mkdir -p -m 700 ~/.ssh
   ssh-keygen -t ed25519 -N '' -C agention-tunnel -f ~/.ssh/agention-tunnel
   ```

2. Connect to each agent machine once to check and accept its host key. The SSH server runs the
   key's command through the account's shell, so `nologin` answers that the account is not
   available, and the connection closes:

   ```bash
   ssh -i ~/.ssh/agention-tunnel agention-tunnel@agent-vm.example.net
   ```

3. Save this as `~/.config/systemd/user/agention-tunnel@.service`, with your origin's host in place
   of `agention.example.com`, and its port, if it names one, in place of `443`. The tunnel must lead
   to the origin, where the server's certificate is served, never to the server's own port, which
   answers without TLS when a proxy such as `tailscale serve` holds the certificate:

   ```ini
   [Unit]
   Description=Agention tunnel into %i

   [Service]
   ExecStart=/usr/bin/ssh -N -i %h/.ssh/agention-tunnel -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 127.0.0.1:8443:agention.example.com:443 agention-tunnel@%i
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=default.target
   ```

   Then start a tunnel into each agent machine, named after the `@`, and have it start whenever your
   user's services do, which lingering, turned on for
   [the server's own unit](#linux-a-systemd-user-unit), makes at boot:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now agention-tunnel@agent-vm.example.net
   ```

   `ssh` exits when its connection stops answering, or when the agent machine refuses the forward,
   as it does while a connection that broke still holds the port, until the `Match` block's settings
   drop it. systemd starts `ssh` again ten seconds later each time, so a tunnel comes back on its
   own once both machines can reach each other.
   `systemctl --user status agention-tunnel@agent-vm.example.net` shows whether a tunnel is up, and
   `journalctl --user -u agention-tunnel@agent-vm.example.net` why it last stopped.

Then give the bridge on each agent machine the tunnel's port beside the origin, as
[Installing the plugins](#installing-the-plugins) describes for `AGENTION_URL`; an IPv6 address goes
in brackets, such as `[::1]:8443`:

```bash
export AGENTION_URL=https://agention.example.com
export AGENTION_CONNECT=127.0.0.1:8443
```

## Approving agents

When an agent session registers, it shows a code such as `7KQ2M-X9DPA` to relay to you, and its
registration appears under **Waiting for approval**, at the top of **Sessions**, with the code in
large type. Approve it only if the code matches the one the agent relayed: a registration made with
any other key shows a different code. A registration not decided within an hour expires. It shows as
expired only until the server prunes it, the next time any registration is submitted or changes.

Approving grants the credential an agent and a session, each an existing one or a new one, under the
names the agent proposed or others you type. Approving onto an existing session gives the credential
that session's whole history and lets it act as the session, so do that only to replace a credential
an agent lost; when the proposed session already exists, you choose between it and a new one. When
there are too many agents, or too many sessions of an agent, to list them all, the form says so
beside them. **Group** and **Tags** open the pickers that [Groups and tags](#groups-and-tags)
describes, and what you choose there is applied with the approval, not before; a group you create in
the picker is created as you pick it. What you leave unpicked stays as it is: a new session has no
group or tags, and an existing one keeps its own, which the pickers start from once you choose it.
Choosing another session or another agent, or naming the new agent otherwise, starts your choices
over; a new session keeps them however you name it. **Reject** refuses a registration.

**Revoke**, in a session's options or under **Credentials and past requests**, ends an approved
credential at once. The session and its threads stay, and you can still read, answer and archive
them; the session shows that it has no active credential until you approve another registration for
it, and its threads holding a message of yours it has not read are stranded.

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

The shared budgets other than registrations are spent only by requests that fail, after they have
been checked, so exhausting one never refuses a valid agent key, API key, passkey or link; only
further failures are refused. Starting a sign-in or a link costs nothing. Someone who can reach the
server can still exhaust the registration budget and delay registering new agents; agents already
registered are not affected.

## Upgrading

One version covers the server, the bridge and the plugins, so upgrade the server first and the
plugins after it. [Back up](#backing-up) before upgrading the server: it migrates its database
forward when it starts, and refuses a database a newer release wrote, so going back to an earlier
release means installing that release and restoring a copy made before the upgrade.

The bridge and the server state on every call the version of the agent API they speak, which a
release changes when it changes what agents send or read. A server serves the bridges of earlier
releases, so agents keep working while their plugins catch up with an upgraded server. A bridge
refuses a server older than itself, and a server refuses a bridge older than the oldest it still
serves; either way, the agent tells you at its terminal what to update: the server to the plugin's
release or later, or the plugin to the server's release. A new session that meets an older server
leaves a registration waiting for approval whose code its agent never gives you; it expires
unapproved. A session runs the bridge its plugin pinned when it started, so after updating a plugin,
restart its sessions, resuming each to keep its conversation.

To upgrade the server, stop it, install the release, and start it again. On Linux:

```bash
systemctl --user stop agention
npm install -g @wayfarerlabs/agention@latest
agention version
systemctl --user start agention
```

The first start after upgrading from a release without attachments rewrites the database once,
before the server listens, so that space removed uploads free can go back to the disk, and logs that
it did. It takes longer the larger the database is, and needs free space of about the database's
size in SQLite's temporary directory, `SQLITE_TMPDIR`, else `TMPDIR`, else `/var/tmp`, else `/tmp`,
and as much again on the disk holding the data directory. Should it fail, for lack of space or
because another process holds the database, the server logs why and how much space it needs and
starts anyway, nothing lost: until it succeeds, space that removed uploads free stays in the
database file for reuse rather than going back to the disk, and each start tries again. A database
restored from an older release's backup is rewritten the same way.

`@latest` installs the newest release; a version, such as `@0.2.0`, installs that one. On macOS,
stop the server with `launchctl bootout gui/$UID/com.wayfarerlabs.agention` and start it with
`launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wayfarerlabs.agention.plist`. Run by hand,
stop it with Ctrl-C and run it again.

To move a pinned plugin to another release, pin its marketplace to that release's tag. Claude Code
refuses to add a marketplace again from another tag, so remove it, which uninstalls the plugin, then
add it and install the plugin again:

```bash
claude plugin marketplace remove agention
claude plugin marketplace add WayfarerLabs/agention#v0.2.0
claude plugin install agention@agention
```

In Codex:

```bash
codex plugin marketplace remove agention
codex plugin marketplace add WayfarerLabs/agention --ref v0.2.0
codex plugin add agention@agention
```

The bridge keeps its keys outside the plugin, in `~/.config/agention`, so its sessions stay
registered. To bring a plugin installed from `main` up to date, refresh the marketplace and install
the plugin again. The hosts replace an installed plugin only when its version changes, which happens
at each release, so installing it again is what takes the changes merged since. In Claude Code:

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

Each plugin pins its bridge's version, so sessions started after the upgrade run the bridge it pins,
which `npx` fetches as the first of them starts.

## Backing up

The database, `agention.db` in the data directory, is the whole of an instance's state: its own key,
your passkeys' records, every thread and every session's log, every file attached to a message, and
voice's settings with a key saved in Settings. Voice settings from the environment are not in it.
`agention backup` writes a consistent copy of it to a new file, while the server runs or not, and
then checks the copy and prints its path, size and schema version. It never changes what the
database holds, though with the server stopped SQLite may leave an empty `agention.db-wal` and an
`agention.db-shm` beside it, which the server uses as its own when it starts. The copy holds what
the database holds, so it is created readable only by you, and the command refuses a directory for
it that other users could read or change, as the data directory's is refused, a file that already
exists, and a path SQLite keeps for the database's own files, such as `agention.db-wal`. A backup
that fails leaves no file behind and exits with status 1.

Every backup is a whole copy, files included, so each takes about as much space as the database,
which grows with every file attached; **Storage** in Settings shows how much attachments take. Keep
the backups in a directory of their own, with mode 0700; the time in each file's name gives each
backup a new file. On Linux and on macOS:

```bash
mkdir -m 700 -p ~/agention-backups
agention backup --data ~/.local/share/agention \
    ~/agention-backups/agention-"$(date +%Y%m%d-%H%M%S)".db
```

The command opens the database read-only and never migrates it, so a copy taken with a newer
release, before you start it on the database, is a copy of the database as the older server left it.

A copy on the same disk is a rollback, not a backup, so keep one on another disk or machine too. The
copy holds the instance's own key, your passkeys' records and any transcription key saved in
Settings, so encrypt any copy you move off the machine.

To restore a copy, stop the server, move the database and the files SQLite keeps beside it out of
the data directory, put the copy in as `agention.db`, and start the server. Move the `-wal` and
`-shm` files aside with the database: a `-wal` file left beside the copy, as a server that was
stopped abruptly leaves one, would be applied to the copy when the server starts. On Linux:

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
Remove the replaced files once you no longer need them.
