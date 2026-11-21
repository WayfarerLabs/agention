# Operator guide

This guide is for the person who runs an Agention instance. It takes you from nothing to agents
asking what they need and you answering, on a machine of your own with Node.js 24 or later. Agention
v1 is under development, and the guide grows as Agention does.

To set up an instance:

1. [Install Agention](#installing).
2. [Give it an HTTPS origin](#giving-it-an-https-origin), the address you and your agents reach it
   at.
3. [Run the server](#running-the-server) in a terminal to try it, then
   [as a service](#running-it-as-a-service).
4. [Register your first passkey](#signing-in) and sign in.
5. [Install the plugins](#installing-the-plugins) where your agents run, and
   [approve each agent](#approving-agents) as it registers.

## Commands

| Command                 | Status    | What it does                                                          |
| ----------------------- | --------- | --------------------------------------------------------------------- |
| `agention version`      | Available | Prints the version and exits                                          |
| `agention --help`       | Available | Prints the command list and exits                                     |
| `agention serve`        | Available | Runs the server, with listener, TLS and origin settings               |
| `agention passkey-link` | Available | Prints a one-time link to register or replace the operator's passkeys |
| `agention backup`       | Planned   | Writes a consistent copy of the database from a running instance      |

Every command takes `--help`. Planned commands do not exist yet, and their names and options may
change before they ship.

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
the origin. Anything else that reaches the origin reaches the sign-in page and the agents' API as
well: passkeys and approved keys keep it from acting, but it can still delay new agent
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

| Option               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `--data DIR`         | The data directory, which holds the database, `agention.db`; required        |
| `--origin URL`       | The HTTPS origin people and agents reach the server at; required             |
| `--listen ADDR`      | The IP address and port to listen on, by default `127.0.0.1:8080`            |
| `--tls-cert FILE`    | The TLS certificate chain, in PEM, for the server to terminate TLS itself    |
| `--tls-key FILE`     | The certificate's private key, in PEM; give both TLS options or neither      |
| `--allow-plain-http` | Allow plain HTTP on an address other than loopback                           |
| `--quiet-minutes N`  | Minutes, 1 to 10,080, after which a session not seen is quiet; 15 by default |
| `--name NAME`        | The server's name, 1 to 40 characters on one line, set by its first start    |

The first start that serves sets the server's name for good, `Agention` unless `--name` gives
another, and stores it with its data; a start that fails before it serves, on a port already in use
for one, sets nothing. A later start may leave `--name` out or repeat the name, and refuses one that
names another. The name is the web UI's title: the banner shows it, each page's title in the browser
follows the page's own name with it, as in **Threads · Work**, and a phone names the page by it on
its home screen. A passkey made on the server carries it as its site's name and before your name, as
in **Work · operator**.

A second server, such as one for personal use beside one for work, runs on its own machine, with its
own `--name` given on its first start. Servers can also share a host under different ports without
signing each other out.

`--listen` takes an IP address, not a name, with an IPv6 address in brackets: `[::1]:8080`.
[Giving it an HTTPS origin](#giving-it-an-https-origin) says what the origin is, and when to use
`--listen`, `--tls-cert`, `--tls-key` and `--allow-plain-http`.

An agent session is seen each time it calls the server, kept to the minute. One not seen within
`--quiet-minutes` and the minute that may take to show, or never, is quiet: it has stopped, or is
busy elsewhere. An agent also reports what its session is doing: **working** while it does something
now; **idle** while it has nothing left to do but wait, for your answers, CI or a review, and it
keeps checking Agention; and **stopped** once it stops checking, with why: **completed** when the
work is done, **withdrawn** when you called it off, or **stalled** when it cannot go on. A stopped
session will not see what you write until something starts it again, and stays stopped until it
reports working or idle. Whether a session waits on you is no state it reports: its open asks say
so. A session whose agent never reported, such as one whose plugin predates session states, has no
state. A thread whose agent has not read your latest messages while its session is quiet, has
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

You can hold up to 20 passkeys, one on each device you use, and manage them under **Passkeys** in
the web UI: each has the name you gave it, shows when it was added and last signed in, and the one
this browser signed in with is marked. There you add a passkey on the device in hand. To add one on
another device, sign in there with a passkey you hold, through the browser's cross-device sign-in
(it shows a QR code that your phone, holding the passkey, scans), then add the device's own passkey
on its passkeys page. A device that cannot is added by `agention passkey-link`, below, which
replaces every passkey. You rename a passkey at any time, and remove any but your last; removing one
signs out every browser it signed in. Adding a passkey and removing one need a sign-in within the
last 10 minutes, and the page offers to sign in again.

To replace your passkeys, after losing your devices for example, run `agention passkey-link` again.
Using the new link replaces all your passkeys with the one it registers and signs out every browser.

Passkeys must verify you, with a PIN or biometric, and be stored by the authenticator, so signing in
asks for no name: open the origin and choose **Sign in with a passkey**. A browser session lasts 30
days, and ends sooner after seven days without use or when you sign out. When it ends, the next page
you open, or the one you have open, returns to sign-in and comes back to that page afterwards.

## Using the web UI

The web UI is laid out for a phone first and follows the browser's light or dark setting. Every view
refreshes itself every 10 seconds while it is visible, and as soon as you return to it.

Where a thread is, its agent, its session and its topic, shows each part behind a small badge: **A**
for the agent, **S** for the session and **T** for the topic; holding the pointer over a badge names
it. A topic is a name like an agent's or a session's, such as `auth`, and belongs to its session:
beside its session it shows alone, and elsewhere as `session/topic`.

- **The thread list**, **Threads**, shows every thread you have not archived. Its head holds
  **Sort**, the order it is in, beside a button saying which way the order runs, then **Group**, how
  the list is grouped, and **Filters**, a funnel with a badge counting the filters that are on. On a
  phone, **Sort** and its button take one row, with **Group** and **Filters** beneath them; on the
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
  - **Group** shows the list **Flat**, the default, or folded under headers: by **Session**, each
    session's threads under its header, and under their topics' when they carry two or more, those
    without one under **No topic**; or by **Agent**, each agent's threads under its header, and
    under their sessions' when it has two or more. Sessions, topics and agents come in the order of
    their first thread, and the list loads a page at a time, its threads arriving group by group.
    Each header shows all its group holds, collapsed or not, and before all of it has loaded: how
    many threads, the closed envelope with how many are unread or the open envelope when none is,
    **Blocked** when an agent's ask blocks its work on your answer, the highest priority of an open
    ask, the archive box when all are archived, and, muted on a session's or an agent's header while
    it is quiet, **last seen** and when, or **never seen** (an agent is quiet while every session it
    shows is). Choosing a header collapses everything under it or expands it again. Every header
    starts expanded, and this browser keeps the ones you collapse, for each way of grouping.
  - Every way of narrowing the list is a filter. Different filters combine, each narrowing what the
    others keep; several values chosen in one filter, such as two agents, each keep their own
    threads. **Filters** opens a sheet holding them all, each a row of choices whose first turns it
    off, and each value not chosen shows in parentheses how many threads it keeps with every other
    filter as it is, which for a filter taking one value is how many the list would hold if you
    chose it:
    - **Search titles** keeps the threads whose title holds every word you type, each as the start
      of a word, ignoring case and accents; it applies once you pause typing.
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
    - **Archived**: **Show** adds the threads you archived.

    The list behind the sheet follows each change. **Reset filters** turns every filter off, saying
    how many threads the list holds with none, and the button at the foot closes the sheet, saying
    how many threads the list holds; so does Escape.

  - Each filter that is on shows beneath the head as a compact chip, such as **Unread** or **Status:
    Withdrawn**; an agent, session or topic shows behind its badge, such as **builder**, a topic as
    `session/topic`, or **2 agents** when you chose several. A long label is cut short, at its front
    for an agent, session or topic, so its end stays; holding the pointer over a chip says it whole.
    Choosing a chip removes its filter. The grouping, the order and its direction are no filters, so
    they stay when filters go.
  - The page's address holds the filters, the order, its direction and the grouping, so a list you
    bookmark or share opens as you left it.
  - A row shows the thread's number and title, such as **#9 Release checklist**, the title bold
    while it holds messages you have not read; while it does, the closed envelope with how many are
    unread over all the messages it holds, yours included and a replaced message counted once,
    through its replacement, such as **2/5**, and once you have read them all, the open envelope
    with how many it holds, such as **5**; the archive box when you archived it; where it is, its
    agent, session and topic, and when it last changed; and, when an ask is open to you, the
    question of the one the list leads with, the first in its order among those the filters keep,
    with its priority, blocked and assuming marks, how long answering takes when the agent said, and
    how many more are open; otherwise, muted, **Answered**, or **Withdrawn:** and the agent's latest
    reason on one line. When any of the asks open to you has an answer-by, the row also shows the
    earliest answer-by among them, whichever ask carries it: **Due** and the time when that falls
    today, or the date and time on another day, with the year only when it is not this year's; and
    once the server finds it passed, as the **Overdue** filter does, **Overdue since** then. Holding
    the pointer over the time shows it in full. A stranded thread shows a muted **Stranded** tag
    saying why: its session **stopped**, with how; it is quiet, **last seen** when, or **never
    seen**; or it has **no active credential**. A session with no active credential also shows its
    own tag, unless the stranded tag already says so.
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
  thread says why its session has not read your latest messages: it stopped, and how, or its agent
  was last seen when, or never; a session with no active credential says so in a notice under the
  head. **Threads** stays marked in the navigation. The head holds **Archive all**, and **Jump to
  unread** while anything is unread or an ask is open to you, and shows the archive box while the
  thread is archived. The messages open on the newest ones, or on the first one you had not read
  after those you archived when that comes before them, and show earlier and later ones when you
  ask.
  - While the page is visible, it reads what it shows: what is on screen when you open the thread,
    and messages that arrive or that you show later, as they appear. Each of the agent's messages
    shows the closed envelope if you had not read it when it appeared, until you leave the page, and
    the open envelope otherwise, and **New** comes before the first you had not read. Reading, like
    writing, counts only the messages on screen. Your reading wakes no agent waiting for messages,
    which sees it the next time it reads the thread.
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
    archives through it, taking the thread off your list until the agent writes to it again, and
    returns to the list; while an ask is open to you, answer or decline it first. Writing to a
    thread you archived keeps it archived, and what you archived never counts as unread.
  - The messages you archived fold into one line at the top, **N archived messages**, which shows
    them, each with the archive box. The page never reads them while they are folded. A message you
    send to an archived thread is archived with the rest, but stays in view until you leave the
    page.
  - The **⋯** button on a message that has not been replaced opens its options: **Mark unread from
    here** and **Archive through here**, until you have archived that message; **Change answer** on
    a message carrying your answers while an ask it answered is still live; **Edit** on your other
    messages. A message offering none has no **⋯** button. Escape, a tap elsewhere, or moving on to
    another control closes them. **Mark unread from here** makes the agent's messages from that one
    on unread again, and returns to the list; it never marks read what you have not read. **Archive
    through here** archives that message and every earlier one, and your own replies right after it,
    which fold away while the page stays, through the latest message too. It waits, naming the ask
    to answer or decline first, while an ask open to you sits in that message or an earlier one.
  - A message's text is a short summary of what the matter is and what is needed. Whatever else the
    message says is in its details: a **Details** line directly under the text opens them in place
    and folds them again, and details you opened stay open as the page refreshes.
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
    or retracted stays with that message, and the line above the box says so.
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
  - Beside **Send**, **Go back after sending** returns you to the list, as **Threads** does, once a
    message is sent, and the list says what was sent; a message that fails to send stays on the page
    with your draft. It is checked until you uncheck it, and this browser keeps your choice.

  If the agent writes to the thread while you are writing, sending fails as stale: your draft stays,
  the messages you missed appear above it, and **Mark these read and send again** sends it, as it
  stands then, once you have read them. When those messages answered, revised or withdrew asks you
  were answering, the page says which and drops only those answers, clearing their cards; an answer
  your change held to an ask they revised or retracted stays with the message you are changing. When
  they replaced the message you were changing or editing, it drops the whole change or edit. Either
  way your text and details stay, and **Mark these read** leaves the rest for you to choose again.

- **The sessions view**, **Sessions**, shows every session of your agents in one place, and is also
  what `/registrations` shows, the page an agent waiting for approval sends you to. From the top:
  - **Waiting for approval** holds the registrations to approve, as
    [Approving agents](#approving-agents) describes.
  - **Agents** holds each agent under a header that folds, as the thread list's group headers do,
    with how many sessions it has and what they add up to: their open asks, unread updates and
    stranded threads. Under it, each session is a folded row, so that many fit on a screen. Its
    first line holds the session's name, the title its agent gave this line of work, cut to fit, and
    its percent toward the goal; the second, wrapping on a phone:
    - what the session reports it is doing: **Working** while it does something; **Idle** while it
      has nothing left to do but wait, for your answers, CI or a review, and still checks Agention;
      **Stopped** once it stops checking, with why, such as **Stopped · completed**; or **No
      status** when it has never reported, such as one whose plugin predates session status;
    - **Waiting on you** with its open asks and how many are blocking, while it has any, whatever it
      is doing: a session working on one thing can wait on your answer about another. It opens the
      thread list on the session's open threads;
    - **Quiet**, with when it was last seen, unless it stopped, and **No credential**, when it has
      no active credential;
    - its unread updates, the closed envelope with how many;
    - its threads, which opens the thread list on the session, with how many are stranded;
    - and its latest note, cut to fit.

    Choosing a row lets its title wrap whole and unfolds it to its goal over a bar of how far it has
    come, when it was last seen, its credentials and its log: what each update changed, newest
    first, with its note. Consecutive updates that changed only the percent show as one line, such
    as **Progress 20% → 60%**, and **Older** shows the updates before. Unfolding reads the updates
    it shows, which stay marked unread until you fold the row again. Rows start folded each time you
    open the view, and a row under an agent you folded reads nothing, since it is not shown. This
    browser keeps the agents you fold.

    A row's **⋯** button opens its options: **New thread**, and **Revoke** for each of the session's
    credentials, which asks once more. **New thread** opens a sheet for a title, the message and its
    details, as a thread's composer takes them, and **Send** starts the thread and opens it. The
    session's agent reads it as your words at its terminal and replies in it; the thread asks you
    nothing, since only agents ask. When the session has stopped, is quiet or has no active
    credential, the sheet says it is not likely to see the thread, and why: a stopped session not
    until it is started again, a quiet one not soon, and one without a credential not until you
    approve a registration for it. The thread is stranded until the session reads it.

  - **Credentials and past requests**, folded until you open it, holds every registration already
    decided.

A message's text and details are Markdown with GitHub's tables, task lists and strikethrough, shown
inert: raw HTML shows as text, an image shows as a link and never loads, and only absolute `https`
links are live, opening in a new tab. A link whose text is not its own address shows the address's
host after it. Titles, questions, suggested answers, the own words of an answer and other fields
show exactly as written, as plain text.

## Agents

Agents reach Agention through the agent bridge, `agention-mcp`, an MCP server that the Agention
plugin for Claude Code or Codex starts for each agent session. The bridge reads its settings from
the environment the agent host gives it:

| Variable              | Meaning                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `AGENTION_URL`        | The server's origin, spelled as `--origin` gives it; required                                   |
| `AGENTWORKS_AGENT`    | The agent's name, unless the agent's `register` call gives one                                  |
| `AGENTWORKS_SESSION`  | The session's name, unless the agent's `register` call gives one                                |
| `NODE_EXTRA_CA_CERTS` | Node's own setting: a file of certificate authorities to trust, for a server with a private one |

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
beside them. **Reject** refuses a registration.

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

The shared budgets other than registrations are spent only by requests that fail, after they have
been checked, so exhausting one never refuses a valid agent key, passkey or link; only further
failures are refused. Starting a sign-in or a link costs nothing. Someone who can reach the server
can still exhaust the registration budget and delay registering new agents; agents already
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

Until `agention backup` exists, back up by stopping the server, copying the whole data directory,
and starting the server again. `cp -a` keeps the permissions, so the copy is private too, and the
time in its name gives each copy a new directory of its own. On Linux:

```bash
systemctl --user stop agention
cp -a ~/.local/share/agention ~/agention-backup-"$(date +%Y%m%d-%H%M%S)"
systemctl --user start agention
```

On macOS, wait until launchd no longer finds the server before copying:

```bash
launchctl bootout gui/$UID/com.wayfarerlabs.agention
while launchctl print gui/$UID/com.wayfarerlabs.agention >/dev/null 2>&1; do sleep 1; done
cp -a ~/.local/share/agention ~/agention-backup-"$(date +%Y%m%d-%H%M%S)"
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.wayfarerlabs.agention.plist
```

Run by hand, stop the server with Ctrl-C and wait for your prompt before copying.

A copy on the same disk is a rollback, not a backup, so keep one on another disk or machine too. The
copy holds the instance's own key and your passkeys' records, so encrypt any copy you move off the
machine.

To restore a copy, stop the server, put the copy in place of the data directory, and start the
server again. On Linux:

```bash
systemctl --user stop agention
mv ~/.local/share/agention ~/.local/share/agention-replaced-"$(date +%Y%m%d-%H%M%S)"
cp -a ~/agention-backup-20261106-120000 ~/.local/share/agention
systemctl --user start agention
```

On macOS, stop and start the server as for a backup. The server opens a copy made by its own release
or an earlier one. Remove the replaced directory once you no longer need it.
