# The web UI

This page describes the web UI you answer your agents in, control by control: the thread list, a
thread, the sessions view and Settings, with the Markdown messages are written in, groups and tags,
and the keyboard shortcuts. The [operator guide](operator-guide.md) covers installing, running and
connecting an instance, and the settings each feature needs.

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
**Threads** button, **Back**, `u` or `Esc`, puts focus on the row of the thread you left. Opening a
thread, from the list, with **Thread above** or **Thread below**, or as archiving or sending moves
you on, puts focus on its heading once it has loaded, on a phone too, unless you have moved focus
elsewhere while it loaded.

Where a thread is, its agent, its session and its topic, shows each part behind a small badge: **A**
for the agent, **S** for the session and **T** for the topic; holding the pointer over a badge names
it. A topic is a name like an agent's or a session's, such as `auth`, and belongs to its session:
beside its session it shows alone, and elsewhere as `session/topic`.

## The thread list

**The thread list**, **Threads**, shows every thread you have not archived. The **Threads** tab
counts those holding a message you have not read, the threads the **Unread** filter keeps with no
other filter on, and reading or archiving them clears the count. The list's head is one row of icon
controls: **Search**, a magnifying glass; **Filters**, a funnel with a badge counting the filters
that are on; **Sort**, the order the list is in, beside a checkbox, an arrow pointing up, that
reverses it; and **Group**, how the list is grouped. Holding the pointer over one names it, and
**Search**, **Sort**, and **Group** each carry a dot while set to anything but their default. Where
the list has room, as in a tablet's window or beside a thread on a wide screen, **Sort** and
**Group** show their choice beside their icons, and with more room every button shows its words.
**Sort** and **Group** are pick lists, and here as everywhere in the web UI the lower corner of such
a compact control says what kind it is: a small down caret marks a pick list, which opens its
choices and changes nothing until you choose one; a small box marks a checkbox, hollow while it is
off and filled, with the control tinted and outlined, while it is on; and a button, which acts when
pressed or opens a dialog or a menu of things to do, has nothing there.

- **Search** opens the search field in the row's place, holding the search on, such as
  **"release"**, which its chip shows, with focus in it; this is where you change the search. Its
  cross, or Escape, closes it, applying what you typed at once, and so does Enter. Text the search
  cannot take keeps the field open on Enter, and closing the field puts back the search that was on.
- **Sort** orders the list by:
  - **Priority**, the default: the threads with asks open to you first, each by the most pressing of
    its asks: by priority, then those blocking the agent's work, then by the earliest answer-by,
    then the oldest ask. The rest follow, latest message first.
  - **Due**: the threads with an open ask that has an answer-by first, soonest first; then the other
    threads with open asks, as **Priority** orders them; then the rest, latest message first.
  - **Effort**: the threads with an open ask that says how long answering takes first, quickest
    first, those alike as **Priority** orders them; then the other threads with open asks, as
    **Priority** orders them; then the rest, latest message first.
  - **Latest message**: every thread by its latest message, newest first.
  - **Created**: every thread by when it began, newest first. Within a session that is the order of
    the threads' numbers, which start again in every session.
- The checkbox beside **Sort**, an arrow pointing up, reverses the order: it is on, its corner box
  filled, while the order is reversed. Its name, which it shows in words where there is room, is
  what turning it on gives, on or off: **Least pressing first** for **Priority**, **Latest first**
  for **Due**, **Longest first** for **Effort**, and **Oldest first** for **Latest message** and
  **Created**. Reversing turns around the threads the order ranks: for **Priority** those with asks
  open to you, for **Due** those whose ask has an answer-by, for **Effort** those whose ask says how
  long it takes, and for **Latest message** and **Created** every thread. The threads it does not
  rank still follow them, as before. Choosing another order starts it in its own direction.
- **Group** shows the list **Flat**, the default, or folded under headers: by **Group**, each
  session group's sessions under its header when the list holds two or more groups, those in none
  under **No group**, and each session as **Session** folds it; by **Session**, each session's
  threads under its header; by **Topic**, each session's threads under its header, and under their
  topics' when they carry two or more, those without one under **No topic**; or by **Agent**, each
  agent's threads under its header, and under their sessions' when it has two or more. Groups,
  sessions, topics and agents come in the order of their first thread, and the list loads a page at
  a time, its threads arriving group by group. Each header shows all its group holds, collapsed or
  not, and before all of it has loaded: how many threads, the closed envelope with how many are
  unread or the open envelope when none is, **Blocked on you** when an agent's ask blocks its work
  on your answer, the highest priority of an open ask, the archive box when all are archived, and,
  in the warning's color on a session's or an agent's header while it is quiet, **last check-in**
  and when, or **never checked in** (an agent is quiet while every session it shows is). A session
  group's header adds up its sessions'. A header's name, and each of those marks a filter matches,
  is a link that adds what the header heads (its group, session, topic or agent) and the mark's own
  filter to the filters on, keeping the others, the order and the grouping: the name and the count
  keep all its threads, the envelope its unread ones, **Blocked on you** those blocking an agent on
  your answer, and the priority those with an ask at that priority or higher. While a filter on open
  asks is on, **Blocked on you** and the priority link nowhere, since they count every open ask of
  the threads shown while those filters keep a thread for one ask meeting them all. **No topic**,
  which no filter names, the archive box and **last check-in** link nowhere. The chevron before a
  header's name collapses everything under it or expands it again, as a click anywhere else on the
  header does but on a link. Every header starts expanded, and this browser keeps the ones you
  collapse, for each way of grouping, a session group's however you rename it.
- Every way of narrowing the list is a filter. Different filters combine, each narrowing what the
  others keep; several values chosen in one filter, such as two agents, each keep their own threads.
  **Filters** opens a sheet holding them all, each a row of choices whose first turns it off, and
  each value not chosen shows in parentheses how many threads it keeps with every other filter as it
  is, which for a filter taking one value is how many the list would hold if you chose it:
  - **Search** keeps the threads whose title holds every word you type, or one of whose messages
    does in its text and details, each as the start of a word, ignoring case and accents. A message
    you or an agent replaced no longer matches; its replacement does. It applies once you pause
    typing, or at once on Enter or on choosing another filter, order, or grouping, which keeps it. A
    link or Back that shows another list before then drops it. The head's search field and this one
    are the same search: typing in either shows in both. Text the search cannot take, such as a tab
    or an invisible character, stays in the box, which says why, and the list stays as it was, until
    you choose another filter, order, or grouping, which drops it. An agent's own search of its
    threads looks at titles alone.
  - **Status** keeps the threads of one status, which rolls up the asks on their messages: **Open**
    while one waits for your answer; **Answered** once none does and you answered or declined at
    least one; **Withdrawn** when the agent withdrew every one; and **None** for a thread that asks
    nothing. Beneath it, the properties of open asks: **Priority** at least **Normal+**, **High+**
    or **Urgent**; **Impact**, **Blocking** where the work the ask is for waits on your answer while
    the agent carries on with other work, or **Assuming** where it goes on under an assumption;
    **Due**, **Overdue** past its answer-by; and **Effort** at most **Quick** (a glance, about two
    minutes), **≤15m** or **≤1h**, which keeps only asks whose agent said how long answering takes.
    Together they keep the threads with one open ask that meets them all, and any of them keeps only
    open threads, so **Status** shows **Open** while one is on: choosing one under another status
    chooses **Open**, and choosing any other status turns them all off.
  - **Read**: **Unread** keeps the threads with messages you have not read, and **Read by agent**:
    **Unread** those with a message of yours the agent has not read yet, and **Stranded** those
    among them whose agent is not there to read it, as
    [Running the server](operator-guide.md#running-the-server) says.
  - **Agent**, **Session** and **Topic**, each beside its badge, open a list of the agents, the
    sessions or the topics holding a thread, each with its count, which stays as you check and
    uncheck them; a search box above narrows them by what they show. Check up to 50 of each.
    Sessions show their agent beside them, and while agents are chosen only their sessions are
    offered, with any you already chose. Topics show as `session/topic` with their agent beside
    them: while sessions are chosen only their topics are offered, or else while agents are chosen
    only their agents' topics, with any you already chose. Each lists at most 500, and says so when
    there are more. One you chose that the list no longer holds, such as one in a shared address,
    stays offered with no threads, so you can uncheck it. Escape, **Done** or a tap outside closes
    the list.
  - **Group** and **Tag** open such lists too: **Group** of your session groups holding a thread, in
    your order, each beside its color, and **No group** for the sessions in none; **Tag** of the
    tags on a session holding a thread or on its agent. A thread is kept when its session is in a
    group you chose, or when its session or its agent carries a tag you chose.
  - **Pull request** and **Branch** open such lists too, of the GitHub pull requests and branches
    the threads' messages name, each by its short form, such as `owner/name#135` or
    `owner/name:branch`, as it was last written. A thread is kept when one of its messages names one
    you chose; a message you or an agent replaced no longer counts, unless its replacement names it
    again. The owner and repository match ignoring case, the number and the branch exactly. Since
    they gather without end, each lists only those the threads the other filters keep name, the most
    recently named first, at most 500, and says so when there are more.
  - **Archived**: **Show** adds the threads you archived.

  The list behind the sheet follows each change. **Reset filters** turns every filter off, saying
  how many threads the list holds with none, and the button at the foot closes the sheet, saying how
  many threads the list holds; so does Escape.

- Each filter that is on shows beneath the head as a compact chip, such as **Unread** or **Status:
  Withdrawn**; an agent, session or topic shows behind its badge, such as **builder**, a topic as
  `session/topic`, or **2 agents** when you chose several. A group or a tag shows by its name now,
  such as **Group: Billing** or **Tag: infra**, or as **2 groups**. A group you have since removed
  keeps nothing, and its chip says **Removed group**; so does a tag you have removed, whose chip
  begins **Removed tag**. A single group's or tag's chip shows its color. A pull request or a branch
  shows beside an icon of two lines merging into one, by its short form, or as **2 pull requests**
  or **2 branches**. A long label is cut short, at its front for an agent, session, topic, pull
  request, or branch, so its end stays; holding the pointer over a chip says it whole. Choosing a
  chip removes its filter. The grouping, the order and its direction are no filters, so they stay
  when filters go.
- The page's address holds the filters, the order, its direction and the grouping, so a list you
  bookmark or share opens as you left it.
- A row shows the thread's number and title, such as **#9 Release checklist**. While it holds
  messages you have not read, the row stands out in blue, with a thick bar at its start, a tint, and
  a dot before its title, set extra bold; while it does, the closed envelope with how many are
  unread over all the messages it holds, yours included and a replaced message counted once, through
  its replacement, such as **2/5**, and once you have read them all, the open envelope with how many
  it holds, such as **5**; a pencil while this browser keeps your draft of a reply to it; the
  archive box when you archived it; where it is, its agent, session and topic, and when it last
  changed; and, when an ask is open to you, the question of the one the list leads with, the first
  in its order among those the filters keep, with its priority, blocked and assuming marks, how long
  answering takes when the agent said, and how many more are open; otherwise, muted, **Answered**,
  or **Withdrawn:** and the agent's latest reason on one line. When any of the asks open to you has
  an answer-by, the row also shows the earliest answer-by among them, whichever ask carries it:
  **Due** and the time when that falls today, or the date and time on another day, with the year
  only when it is not this year's; and once the server finds it passed, as the **Overdue** filter
  does, **Overdue since** then. Holding the pointer over the time shows it in full. A stranded
  thread shows a **Stranded** tag in the warning's color, as the sessions view flags stranded
  threads, saying why: its session **stopped**, with how; it is quiet, **last check-in** when, or
  **never checked in**; it has **no active credential**; or its bridge is **not connected**. For a
  session its bridge can nudge, it says what came of the nudge instead: **not responding to the
  nudge at 14:05**, **nudge not sent at 14:05**, **checked in after the nudge at 14:05 without
  reading this**, or **not nudged**. Where the session's bridge monitors its terminal, the tag also
  says what the terminal shows, in the words of the sessions view's rows, such as **last check-in
  14:02 · stopped at a permission prompt**. A session with no active credential also shows its own
  tag, unless the stranded tag already says so. When the thread's messages name one GitHub pull
  request or branch, it shows beneath, beside the same icon of two lines merging into one, by its
  short form, which adds it to the filters on, keeping the others, the order and the grouping; its
  link to GitHub is on the thread's page. When they name two or more, that icon among the row's
  marks says how many, which a screen reader says in full, such as **2 pull requests, 1 branch**,
  and the thread's head lists them.
- A bar at the foot of the list, **List actions** to a screen reader, acts on every thread shown,
  leaving out those under a folded header, as **Select all** does. It stays in view as the list
  scrolls, below its last row once you reach it, and a row you move to with the keys scrolls into
  view above it. While you type in the list's search field, it waits at the end of the list instead.
  Its caption says how many threads are shown, such as **25 of 40 shown** while more match, and
  after an action, what that action did, as the status line does. Each of its buttons shows an icon
  over a short word and keeps its place: **Mark all read** marks read the threads shown that hold
  anything unread, and **Archive all read**, while archived threads are not included and no filter
  keeps only threads with open asks, archives those that hold nothing unread, keeping those with an
  ask open to you, each through the latest message shown. Neither asks first. Each is dimmed while
  it would act on no thread, **Archive all read** also while every thread it would archive holds an
  ask open to you. Once its action is done, focus stays on the one you pressed while it can act
  again, and otherwise moves to **Select all**, or, on a phone or a tablet, where **Select all**
  shows only while anything is selected, to the page's heading, without moving the list, so pressing
  again does nothing unasked. Both act on at most 500 threads at once, and say when more remain.
  While anything is selected, the same bar acts on the threads selected instead.
- **Selecting threads** acts on several at once. With a mouse or a trackpad, each row has a checkbox
  at its start; on a phone or a tablet, hold a row down, anywhere on it, its pull request or branch
  too, to select it, and then, while anything is selected, a tap selects or unselects a row rather
  than opening it or following its pull request or branch. `x` selects or unselects the row holding
  focus, on its link, its checkbox, or its pull request or branch. The checkbox above the list,
  **Select all**, selects every thread shown, leaving out those under a folded header; once it has,
  while the list holds more, a button beside it, such as **Select all 40 threads that match**,
  selects every thread the filters keep, up to 500 at once, and another, such as **Select only the
  25 shown**, goes back. While anything is selected, the bar at the foot of the list says how many
  and offers, after **Clear**, **Read**, which marks them read; **Unread**, which marks each thread
  unread from the agent's latest message, leaving out a thread holding none, so the count it gives
  is of the threads now unread; **Archive**, which marks them read and archives them, keeping each
  thread holding an ask open to you as it was and saying how many it kept; and **Decline**,
  available while a thread selected holds an ask open to you, which first declines every such ask in
  messages of yours, up to ten answers to a message, which the agent reads, then marks the thread
  read and archives it. A screen reader names them in full: **Clear selection**, **Mark read**,
  **Mark unread**, **Mark read and archive**, and **Decline, mark read and archive**. With more than
  500 selected, only **Clear** is available, and the bar says to select fewer. Declining asks first:
  for the threads selected, with how many asks and threads; for every thread that matches, with how
  many of them hold an ask open to you, as the counts of the filters give it. An action on the
  threads selected acts on at most 500 at once, each through the latest message the list showed; an
  action on every thread that matches asks first, with how many, and acts on the threads the filters
  keep, each through its latest message when the list was last loaded, leaving out a thread started
  since; when the threads that match have changed in number since, as when a deadline passed, it
  acts on none, and the list loads again and asks again. Either way a message that arrived since
  stays unread and brings its thread back, and declining leaves as it was a thread holding such a
  message, since you have not seen it. The status line says what the action did, and the selection
  clears. **Clear**, or `Esc` within the list, clears it too; with the question open, `Esc` answers
  it with **Cancel**. Focus that was in the bar as the selection clears moves to **Select all**, or
  on a phone or a tablet to the page's heading. The selection stays as the list refreshes and loads
  more, and a thread that leaves the list leaves it.

## A thread

**A thread** reads like an email. Its head starts with its heading, which leads with the thread's
number, as a row's does, and shows the archive box beside it while the thread is archived for you.
Under it, its agent, session and topic say where the thread is, and each opens the list narrowed to
it alone, with no other filter on, showing everything there in the order and grouping you left the
list in. Beneath, muted, a thread whose asks were answered or withdrawn says so, as its row does,
and a stranded thread says why its session has not read your latest messages: it stopped, and how,
its agent last checked in when, or never, or its bridge is not connected, or, for a session its
bridge can nudge, what came of the nudge, such as its agent checking in after the nudge without
reading the thread, with what its terminal shows where its bridge monitors it; a session with no
active credential says so in a notice under the head. **Threads** stays marked in the navigation.
The head holds **Jump to unread** while anything is unread or an ask is open to you. The messages
open on the newest ones, or on the first one you had not read after those you archived when that
comes before them, and show earlier and later ones when you ask.

- A bar at the foot of the page, **Thread actions** to a screen reader, holds the ways off it, each
  an icon over a short word: **Threads**, back to the list as you left it, with its filters, order,
  and grouping, or with none when you opened the thread directly; **Above** and **Below**, **Thread
  above** and **Thread below** in full; and, at its end, **Archive all**. It comes after the
  composer and stays at the foot of the screen as the thread scrolls, with the composer's **Send**
  row just above it while the composer is on screen. While you type in the composer or an ask's box,
  and on a screen too short to spare the room, the bar waits at the end of the page, under the
  composer, so only the **Send** row holds the foot of the screen, above a phone's keyboard; leaving
  the box brings it back.
- While the page is visible, it reads what it shows: what is on screen when you open the thread, and
  messages that arrive or that you show later, as they appear. Each of the agent's messages shows
  the closed envelope if you had not read it when it appeared, until you leave the page or archive
  it, and the open envelope otherwise; one you had not read also stands out in blue, as unread rows
  do, with a dot before its author. Reading, like writing, counts only the messages on screen. Your
  reading wakes no agent waiting for messages, which sees it the next time it reads the thread.
- **Jump to unread** moves you to a message you have not read, whether it shows the closed envelope
  or is not shown yet, or to the card of one of the 50 most pressing asks still open to you, read or
  not. The first press goes to the first of them after what you had read when you opened the page,
  and each press after it to the next in the thread's order, showing earlier or later messages when
  needed, and round to the first in the thread after the last. Once nothing is unread it is **Jump
  to open ask**, going round those asks alone, and with neither it is gone. Its count says how many
  messages are unread, or how many asks it goes round.
- Each message of yours shows, quietly at its bottom right, an envelope and the word **agent**: the
  envelope closed and accented while the agent has not read it, and open once it has. A screen
  reader says **Unread by agent** or **Read by agent**.
- **Archive all** first shows every message through the latest, loading those not yet shown, then
  archives through it, taking the thread off your list until the agent writes to it again. Then it
  goes where **Auto-advance**, in Settings under **Threads**, says: the thread just above where the
  archived thread stands in the list, unless you choose the one just below or back to the list. It
  takes the archived thread's place, so **Back** does not return to it, and at the end of the list
  that way it goes back to the list, which says so. If finding that thread fails, you stay on the
  thread, archived, and the page says so. While an ask is open to you, answer or decline it first:
  **Archive all** is dimmed, and pressing it, or `e`, says why in the bar. Writing to a thread you
  archived keeps it archived, and what you archived never counts as unread.
- **Thread above** and **Thread below**, or `[` and `]`, open the row just above or below this
  thread in the list **Threads** returns to, as that list stands when you press them, with its
  filters, order and grouping, read or not. Change that list while they look, and they look again in
  the list as you left it; should it keep changing, they stay and say so. That is the list beside
  the thread side by side, so if answering or replying here moves the thread in it, they follow it
  to its new place, on a phone as beside the list. A thread the list's filters leave out, such as
  one read out of a list kept to the unread, or an archived one, counts where the list's order would
  put it within its group, which stays where the list shows it. A thread you opened from a link
  moves through the list with no filters, the one **Threads** returns to; a reload keeps the list
  you opened it from. Unlike `k` and `j` in the list, they go through threads in folded groups too,
  since a phone shows no list to fold. At the top or bottom of the list, they go back to the list,
  which says so. **Back** returns to this thread. Side by side, the thread opens beside the list,
  which keeps its scroll, its row outlined; on a phone the same buttons are in the thread's bar.
- The messages you archived fold into one line at the top, **N archived messages**, which shows
  them, each with the archive box. The page never reads them while they are folded. A message you
  send to an archived thread is archived with the rest, but stays in view until you leave the page.
  Once you show them, a thin rule, **Archived through here**, sets apart the messages you have not
  archived after them. It moves as you archive further, and appears when the agent writes to a
  thread you archived.
- The **⋯** button on a message opens its options: **Mark unread from here** and **Archive through
  here**, until you have archived that message; **Change answer** on a message carrying your answers
  while an ask it answered is still live; **Edit** on your other messages; and **Read aloud**,
  wherever the browser can speak, on a replaced message too, once you open it. A message offering
  none has no **⋯** button. Escape, a tap elsewhere, or moving on to another control closes them.
  **Mark unread from here** makes the agent's messages from that one on unread again, and returns to
  the list; it never marks read what you have not read. **Archive through here** archives that
  message and every earlier one, and your own replies right after it, which fold away while the page
  stays, through the latest message too. It waits, naming the ask to answer or decline first, while
  an ask open to you sits in that message or an earlier one. **Read aloud** speaks the message on
  your device, in the browser's own voice for the page's language: its text and details, a code
  block or a diagram named rather than read, then its asks with their suggested answers, and its
  answers. It reads **Stop** while it speaks; reading another message aloud, starting a recording or
  leaving the thread stops it too. A device that cannot speak, such as one without voices installed,
  says so under the message, and **Read aloud** is offered again. Nothing is read aloud unless you
  ask.
- A message's text is a short summary of what the matter is and what is needed. Whatever else the
  message says is in its details: a **Details** line directly under the text opens them in place and
  folds them again, and details you opened stay open as the page refreshes.
- The copy button at the end of a message's head, beside its **⋯** button, copies the whole message
  as Markdown, as it was written: its text, and its details too, after a blank line, while you have
  them open. Its asks, answers, references and files are not copied. Every message with text has
  one, a replaced message too once you open it, and a message without text has none. The button
  shows a check for a moment once the message is copied. Where the browser refuses the clipboard,
  the message says so, and you can select the text to copy it by hand.
- A message's files show under it, and **Attach** beside **Send** adds yours, as
  [Attachments](operator-guide.md#attachments) describes. While the thread's current messages carry
  any, its head holds **Files**, folded, with how many there are and the space they take.
- The GitHub pull requests and branches a message is about show on one short line under its text,
  beside an icon of two lines merging into one: one by its short form, `owner/name#135` for a pull
  request or `owner/name:branch` for a branch; two or more as a count, such as **2 pull requests, 1
  branch**, which unfolds to the list. While the thread's messages name any, its head holds **Pull
  requests and branches**, folded, with how many there are, listing each once, pull requests and
  then branches, each the most recently named first. Each short form opens the thread list narrowed
  to it alone, with no other filter on, so it shows every session's threads that name it, in the
  order and grouping you left the list in, as the thread's agent, session, and topic do. When the
  agent gave its URL, a small link beside it opens its page on GitHub in a new tab, followed by the
  site's name. A replaced message keeps its own, but they leave the thread's list unless its
  replacement names them again. They are what the writer declared: Agention never contacts GitHub,
  so a link says nothing about whether the pull request is open, merged, or still exists, which the
  message's text says when it matters. Programs using the operator API can name them on a message
  too, and list and count threads by them as the filters do.
- Each ask shows as a card on its message, which may carry several. Asks are numbered within the
  thread as the agent writes them, and the card leads with the number (**Ask 3**), then the
  question, its priority, impact, how long answering takes when the agent said, and answer-by, what
  the agent will do without an answer, and whether it is open, answered, revised or withdrawn. An
  agent that revises an ask asks it again under a new number. An agent withdraws an ask it no longer
  needs answered, such as one settled elsewhere, with a reason: its card reads **Withdrawn in #7:**
  and the reason, and the message that withdrew it says **Withdrew ask 3:** and the reason for each
  ask it withdrew. An agent may withdraw an ask in the message that revises its others, and the card
  reads withdrawn all the same. A withdrawn ask takes no answer. An answered card checks the
  suggested answers you picked, sets the others apart and shows your words under **Notes** beside
  your picks, or under **Other** when you picked none; a declined one says so. The message carrying
  your answers says the same for each, naming the ask by its number: the suggested answers you
  picked, with notes when you wrote them, or **Other**, with your words beneath; your words alone on
  an ask without suggested answers; or that you declined.
- You answer on the card. Where the ask allows one answer, its suggested answers are radio buttons
  under **Choose one**; where it allows several, checkboxes under **Choose any that apply**. The
  last choice, **Other**, is for an answer in your own words instead, in place of any picks:
  choosing it unchecks them, and picking a suggested answer unchecks it. Once you choose anything, a
  **Notes** field opens under the choices: beside your picks, what you write there is optional notes
  that go with the answer; with **Other** chosen, the field is your answer, so choosing **Other**
  moves you there. Changing your choice keeps what you wrote. Where several may be picked and you
  uncheck everything, the field stays while it holds words, and the answer waits until you choose
  again or clear them. An ask without suggested answers has only a field, for your answer. While
  [voice](operator-guide.md#voice) is on, **Dictate** under the field puts what you say in it, as
  the composer's does. Files for an answer go with the message that sends it: attach them in the
  composer. **Decline to answer**, below the choices, sets them aside and declines the ask when you
  send, until you undo it. While the card holds an answer or a decline you have not sent, **Clear**
  there removes it as **Remove** in the line above the box does, leaving you on the card as it was
  before you chose anything. **Change answer**, in the options of a message carrying your answers,
  opens again the card of every ask that message answered that is still live, with your answers and
  notes, moves you to the first, unfolding the archived messages when it is among them, and puts
  that message's text and details in their boxes. An answer to an ask the agent since revised or
  retracted stays with that message, and the line above the box says so. When the asks it changes
  have to load first, and the page learns meanwhile that the message was replaced, nothing is
  staged.
- **Edit** in the options of your other messages changes their text and details, and drops their
  answers to asks the agent since revised or retracted. **Change answer** and **Edit** replace the
  whole message, so they need empty boxes with nothing staged, and keep its references, pull
  requests and branches as they are. A replaced message folds into one line naming its replacement,
  and opens to show what it said; one replaced by a message carrying nothing reads **retracted in**
  that message, which says **Retracted #** and the number.
- At the foot is a box labelled **Additional information** while you write answers and **Message**
  otherwise, a **Details** line under it that opens a second box for the message's details, and one
  **Send** button. The message box holds a summary of up to 1,000 characters, and **Details** up to
  20,000; neither cuts what you type or paste, but while either is over, or there are details and no
  message, **Send** waits and the box says why. You can answer several asks at once, up to ten, and
  **Send** sends the answers, the text or both as one message. A line above the box names each
  answer or decline by its ask's number (**Ask 3: “Postgres”**, with notes when you wrote them),
  each with **Remove** to drop it, which also clears its card, as **Clear** on the card does; a
  change of answers or an edit shows as one line, removed whole there, and the cards of a change
  offer no **Clear**. **Send** is available only when there is something complete to send: **Other**
  without words is not, and its field says so once you leave it. Once ten cards hold answers, the
  other asks' choices are unavailable until you send or remove one. While a change or an edit is
  staged, nothing else can be started until you send or remove it, and removing it empties both
  boxes. An edit needs text. With **Enter sends** on, as [Keyboard shortcuts](#keyboard-shortcuts)
  describes, `Enter` in either box sends and `Shift+Enter` starts a new line.
- This browser keeps your draft's text and details as you type, one draft for each thread, so
  leaving the thread or reloading the page loses nothing: the composer opens with them when you come
  back, and counts from where the draft started, so a message the agent wrote while you were away
  makes sending stale, as below. With the thread open in two tabs, the draft typed last is the one
  kept. What you staged, the files you attached and a recording are not kept: the composer says so
  when the draft it opens with had them, and sending it then posts its text as a new message. The
  text a change or an edit loads is kept only once you change it. **Discard draft**, under the boxes
  while they hold anything, asks once, then empties the composer and forgets the draft; a message
  that is sent forgets it, and one that fails to send keeps it. Reloading the page while a message
  is being sent brings its text back as the draft; if the message landed, sending the draft again
  fails as stale, with your message among those missed, so nothing is sent twice unseen. The browser
  forgets a draft 30 days after you last opened its thread or typed in it, keeps the latest 50, and
  forgets them all when you sign out here or remove the passkey it signed in with. A browser that
  refuses storage, as a private window may, keeps none, and the composer works as before.
- Beside **Send**, **After sending** is two compact controls for what follows once a message is
  sent, their icons alone on a phone, and past a phone's width a word or two beside each, after the
  words **After sending**. Holding the pointer over one names it and says what it is set to.
  - The first is a pick list of where sending takes you, whose icon shows the choice it holds, and
    whose choices say what each does: **After sending, go back to the list**, an arrow pointing
    back, as **Threads** does, where the list says what was sent; **After sending, stay on this
    thread**, a ring around a dot; or **After sending, open the thread above** or **After sending,
    open the thread below**, an arrow pointing up or down, as their buttons do. A phone shows the
    choices in its own picker.
  - The second is a checkbox, an archive box named **Archive after sending**. While it is on, this
    thread is archived once the message lands, and then you go wherever the pick list says, so a
    reply that answers the last ask open to you can archive the thread too, whatever you do next. A
    thread you go on to takes the archived thread's place, so **Back** does not return to it;
    staying shows the thread archived. **Auto-advance** has no say here: it is where **Archive all**
    goes.

  The thread sending takes you to says beside its **Send** what you sent, or the list does, saying
  too when you reached its end. If an ask is still open to you, the archive is refused and you stay
  on the thread, and beside **Send**, after what was sent, the page says which ask to answer or
  decline first; when the thread to open cannot be found, it says that there instead. While a
  message that will archive the thread or take you somewhere is on its way, **Thread above**,
  **Thread below**, and **Archive all** wait for it, and while the page is moving to another thread
  or the list, **Send** and **After sending** wait for it. A message that fails to send stays on the
  page with your draft. Sending goes back to the list, archiving nothing, until you choose
  otherwise, and this browser keeps your choices. While you write, **Send** and its options stay at
  the foot of the screen, above a phone's keyboard, with what answers **Send** beside it: why a
  message failed to send above it, and what was sent after it. While voice is on, **Dictate** sits
  there too, and what it says goes in the same places: why dictation failed above, and anything else
  after. While dictation shows its controls there, from the moment the microphone is asked for
  through a recording and its transcription to its **Retry**, **After sending** moves just below the
  row, so the row stays short above a phone's keyboard.

- While [voice](operator-guide.md#voice) is on and the browser can record, **Dictate** sits beside
  **Send**. It asks for the microphone, with **Cancel** while it waits, since a browser may wait on
  its permission prompt for as long as you leave it; then it records, showing how long against its
  limit of five minutes, until you choose **Stop**; then **Transcribing**, with **Cancel**, and the
  text goes in where the cursor was, in the box you were last in, with a space where it meets other
  text, for you to read and change. Nothing is sent until you send it. A transcript of nothing, or a
  recording too short to hold any, says **Nothing heard**. A transcription that fails says why and
  keeps your draft as it was, and the recording for **Retry**, beside **Discard**. A recording also
  stops when it reaches 1.9 MiB, or when you switch away from the page, so the microphone never runs
  while you are not looking, and what it recorded is transcribed as usual; if you are still away
  from the page when the microphone opens, it closes without recording, and leaving the thread
  discards a recording. Starting a recording, here or under an ask's **Notes** field, counts as
  seeing the thread then: a message the agent writes while you record makes sending stale, as below.
  One recording runs at a time: starting another stops the first, whose text goes in as if you had
  chosen **Stop**. While a recording is there, here or on an ask's card, from the moment the
  microphone is asked for through recording and transcribing to awaiting **Retry**, **Send** and its
  shortcut wait and say why, so your words are never lost under a send; the new-thread sheet's
  **Send** waits the same way. **Dictate** waits in turn while a message is on its way. Text that
  arrives after you discarded the draft it was for goes nowhere.

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

## The sessions view

**The sessions view**, **Sessions**, shows every session of your agents in one place, and is also
what `/registrations` shows, the page an agent waiting for approval sends you to. From the top:

- **Waiting for approval** holds the registrations to approve, as
  [Approving agents](operator-guide.md#approving-agents) describes. The **Sessions** tab counts
  them, and approving or rejecting them clears the count. While none is waiting the section is one
  short line, and until some agent has a session it explains instead how a registration arrives.
- Everything in the view that stands for threads is a link opening the thread list on those threads
  alone, with no other filter on: a group's, an agent's or a session's name, a count of threads, the
  envelope, **Blocked on you**, open asks and stranded threads, each within the header or row it
  sits on, and a group's or a tag's chip, on the threads in that group or carrying that tag wherever
  they are. Following one never folds anything: the chevron before a name folds what it heads, as a
  click anywhere else on the header or the row does but on a link or a button.
- **Agents** holds each agent under a header that folds, as the thread list's group headers do, with
  how many sessions it has and what they add up to: how many of them need you, such as **2 need
  you**, flagged in the warning's color while any do, which lists just those sessions, as **Needs
  you** below says; their threads' roll-up and unread updates as each session's row shows them,
  their open asks as each row shows its own, their stranded threads, and the agent's tags. At the
  header's end, its threads open the thread list on the agent's threads; how many of them are
  stranded, flagged while any are, opens it on those, as the **Stranded** filter does; and the **⋯**
  button opens **Tags**. Once you have put any session in a group, the agents fold under their
  groups, groups in your order and **No group** last, each group's head showing what its sessions
  add up to, how many of them need you, with **Blocked on you** when an ask in them blocks an
  agent's work on your answer, and a link opening the thread list on the group's threads. An agent
  with sessions in two groups shows under each with that group's sessions, and its threads' links
  open its threads, and its stranded threads, in that group. This browser keeps the groups you fold,
  a group however you rename it. Under each agent, each session is a folded row, so that many fit on
  a screen. Its first line holds the session's name, the title its agent gave this line of work, cut
  to fit, and its percent toward the goal; the second, where the session is as Agention knows it,
  apart from what its agent reports:
  - **Connected** while its bridge is, and **Not connected** once it is not, in the warning's color
    unless the session has stopped; a session whose bridge predates the background connection says
    neither, as [Running the server](operator-guide.md#running-the-server) says;
  - while it is connected and its bridge monitors its terminal, what the terminal shows and since
    when, as [Monitoring a session's terminal](operator-guide.md#monitoring-a-sessions-terminal)
    describes: **running**, **at its prompt**, **waiting** or **condition unknown**; **stopped at a
    permission prompt** or **stopped at another prompt**; or, where its profile can tell what
    stopped it, that first, with any prompt beside it, such as **stopped by a usage limit (resets
    15:00), at its prompt**, or **(reset due 15:00)** once that time has passed. A permission prompt
    or another prompt, or something that stopped it, is in the warning's color, since it needs you;
  - once its bridge has claimed a nudge, what came of the latest: **nudged** and when; **not
    responding to the nudge at** when, sent, or under way or with no outcome, with no check-in
    since; or **nudge not sent at** when, the last two in the warning's color
    ([The nudge](operator-guide.md#the-nudge));
  - **Last check-in** and when its agent last called Agention, or **Never checked in**, in the
    warning's color while the session is quiet and has not stopped, so a session can show
    **Connected, at its prompt since 14:02 · last check-in 11:40**: online, with an agent that has
    done nothing for hours;
  - and once it has reported a status, how long ago it last updated it, such as **status updated 2
    hours ago**, since an agent can go on checking in long after its status stopped saying what it
    does; a session marked working because it wrote counts as an update then. While a session is
    **Working**, its bridge reminds it to update its status once it has sent none for 20 minutes,
    counting a write that marked it working. The bridge counts from the session's own last update
    through it, not from the age you see, so the two differ when the bridge has restarted or another
    bridge shares the session.

  The third line, wrapping on a phone:
  - what the session reports it is doing: **Working** while it does something; **Idle** while it has
    nothing left to do but wait, for your answers, CI or a review, and still checks Agention, or,
    where its bridge nudges it, waits at its prompt for a nudge; **Stopped** once it stops checking,
    with why, such as **Stopped · completed**; or **No status** when it has never reported, such as
    one whose plugin predates session status. This is the agent's word, and its terminal can say
    otherwise: a session reporting **Working** may be **stopped at a permission prompt**;
  - **Needs you**, in the warning's color, while its terminal shows a permission prompt or another
    prompt, or something that stopped it, which lists just the sessions that need you;
  - its open asks, while it has any, whatever it is doing: a session working on one thing can wait
    on your answer about another. In the thread list's words, **Blocked on you** in red while any of
    them blocks its work on your answer, opening the thread list on the session's threads that do,
    then how many are open, such as **2 open asks**, opening it on the session's open threads;
  - **No credential**, when it has no active credential;
  - its group, in a chip with a dashed border, and its tags, each led by **#**;
  - its threads' roll-up, as the thread list's headers show theirs: how many threads you have not
    archived, which opens the thread list on the session; how many are stranded, flagged as on an
    agent's header, which opens it on those alone; the closed envelope with how many are unread, or
    the open envelope when none is, the closed one opening it on the session's unread threads.
    **Blocked on you** shows once, before its open asks, as on an agent's header;
  - its unread updates, such as **2 new updates**;
  - and its latest update's note, cut to fit, with none after the server marked it working.

  Choosing a row's chevron, or anywhere on it but its links and buttons, lets its title wrap whole
  and unfolds it to its goal over a bar of how far it has come, its credentials, the profile its
  bridge reads its terminal with and whether it can nudge the agent, or **Terminal not monitored**
  when it is given none, and its log: what each update changed, newest first, with its note, and
  **inferred from a write** on one the server logged when the idle session wrote. Consecutive
  updates that changed only the percent show as one line, such as **Progress 20% → 60%**, and
  **Older** shows the updates before. Unfolding reads the updates it shows, which stay marked unread
  until you fold the row again. Rows start folded each time you open the view, and a row under an
  agent or a group you folded reads nothing, since it is not shown. This browser keeps the agents
  you fold, under each group apart.

  A row's **⋯** button opens its options: **New thread**; **Group** and **Tags**, each naming what
  the session has now; and **Revoke** for each of the session's credentials, which asks once more.
  **New thread** opens a sheet for a title, the message, its details and its files, as a thread's
  composer takes them: **Attach** at the sheet's foot, or a pasted image, adds files, and while
  [voice](operator-guide.md#voice) is on, **Dictate** beside it puts what you say in the box you
  were last in. **Send** waits for the files to upload, and for a recording until its text is in or
  you discard it, then starts the thread and opens it; while it is on its way the sheet stays as it
  is. **Cancel**, or leaving the sheet any other way, removes the files it uploaded. The session's
  agent reads it as your words at its terminal and replies in it; the thread asks you nothing, since
  only agents ask. When the session has stopped, is quiet, has no active credential or is not
  connected, the sheet says it is not likely to see the thread, and why: a stopped session not until
  it is started again, a quiet one not soon, one without a credential not until you approve a
  registration for it, and one whose bridge is not connected not until it connects again, with what
  its terminal shows where its bridge monitors it. A session its bridge can nudge is not likely to
  see it only while its latest nudge has had no check-in since, sent or not, since it is not nudged
  again until it checks in; quiet or stopped, it gets the thread's nudge. The thread is stranded
  until the session reads it.

- Above the agents, as on the thread list, **Sort** and **Group** choose how they show, and the
  page's address keeps your choice, so going back to the view or a link to it shows it the same.
  **Group** folds them by **Group**, the default, as above; by **Agent**, each agent over its
  sessions, whether or not any is in a group; or by **Session**, each session's row on its own,
  named with its agent, such as **builder/main**, with no agent's header, so an agent's tags, its
  roll-up and its **Tags** option show only grouped by **Group** or **Agent**. **Sort** puts every
  level in order: **Alphabetic** by name; **Registration time** by when each session was first
  approved, a group or an agent by its earliest session; or **Manual**, offered only grouped by
  **Group**, which keeps your groups in your order and their agents and sessions in name order. The
  checkbox beside **Sort** reverses it, as on the thread list, named for what turning it on gives,
  **Z to A** or **Oldest first**; **Manual** has no direction, and **No group** comes last whichever
  way. Choosing another sort starts it in its own direction, and grouping by **Agent** or
  **Session** while sorted **Manual** sorts **Alphabetic**. In **Manual**, each group's head ends in
  **Move up** and **Move down**, and, with a mouse, a handle to drag it onto another group's head
  and put it in that one's place, which changes your groups' order everywhere, as
  [Groups and tags](#groups-and-tags) does in Settings. While a move is under way, the groups take
  no other; one another browser made stale is refused, and the groups show as they are.

- **Needs you**, the view's one filter, lists just the sessions whose terminal shows a permission
  prompt or another prompt, or something that stopped them, under their agents and groups as
  **Sort** and **Group** arrange them; agents and groups with none such do not show. It hides rows
  and nothing else: an agent's header and a group's head still say what all their sessions add up
  to, those hidden among them. A row's **Needs you** and a header's count of them turn it on,
  keeping the arrangement, and while it is on, a **Needs you** chip under **Sort** and **Group**
  turns it off. The page's address keeps it, as `/sessions?needs_you=true`, beside the arrangement,
  and turning it on or off is a step in the browser's history, so **Back** returns to the view as it
  was, while choosing **Sort** or **Group** is not. With nothing to show, it says no session needs
  you now, or, when the view left sessions out, that none of those listed does. Only a session whose
  bridge monitors its terminal can need you this way: an open ask that waits on you shows as
  **Blocked on you** or its open asks, as above, whatever its terminal shows.

- **Credentials and past requests**, folded until you open it, holds every registration already
  decided.

## Settings

**Settings** is in sections, each at its own address under `/settings/`: under **Access**, your
**Passkeys** (`/settings/passkeys`), as [Signing in](operator-guide.md#signing-in) describes, and
**API keys** (`/settings/api-keys`), as [API keys](operator-guide.md#api-keys) describes; under
**Features**, **Threads** (`/settings/threads`), whose **Auto-advance** chooses where **Archive
all** takes you, as [A thread](#a-thread) describes, **Groups and tags**
(`/settings/groups-and-tags`), as [Groups and tags](#groups-and-tags) describes, **Voice**
(`/settings/voice`), as [Voice](operator-guide.md#voice) describes, **Storage**
(`/settings/storage`), as [Attachments](operator-guide.md#attachments) describes, and **Keyboard**
(`/settings/keyboard`), as [Keyboard shortcuts](#keyboard-shortcuts) describes; and **Sign out**
(`/settings/sign-out`), which signs this browser out, forgetting the drafts it kept, and leaves your
others signed in. On a wide screen the sections are listed beside the one open; on a phone Settings
opens on the list, and each section has a link back to it. `/passkeys` leads to Passkeys. While your
sign-in is too old for a change to passkeys, API keys or voice, those sections offer **Sign in
again** first.

## Markdown and diagrams

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

## Groups and tags

Session groups and tags organize your views, nothing else: agents never see them, and they grant
nothing. A session sits in at most one group, such as **Billing migration** or **Personal:
website**, and you can tag agents and sessions across groups, such as **infra**; a tag on an agent
counts for each of its sessions. The thread list filters by both and, grouped by **Group**, folds
the sessions under their groups, and the sessions view folds the agents under their groups, as
[The thread list](#the-thread-list) and [The sessions view](#the-sessions-view) say.

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

## Keyboard shortcuts

With a keyboard, single keys do the everyday things, in the manner of mail and code-review tools.
They act only while focus is outside a text field, an open menu and a dialog, and never with Ctrl,
Alt or Cmd held unless the key needs it; AltGr, which types a key such as `]` on many keyboards,
counts as none for the punctuation it types, though Ctrl and Alt with a letter, a digit or a key
that types nothing, such as Esc, never act. On a phone without a keyboard nothing changes. Press `?`
anywhere to list them all.

| Where           | Key                         | What it does                                                                                                                                                                                |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere        | `?`                         | Lists the shortcuts                                                                                                                                                                         |
| Anywhere        | `g` then `t`, `s` or `,`    | Goes to Threads, Sessions or Settings, the second key within 1.5 seconds; any other key after `g` does what it does alone                                                                   |
| The thread list | `j` and `k`                 | Moves to the next or previous thread, stopping at either end                                                                                                                                |
| The thread list | `n` and `N`                 | Moves to the next or previous thread that is unread or blocked on you, going round                                                                                                          |
| The thread list | `o`                         | Opens the thread, as `Enter` on its row does                                                                                                                                                |
| The thread list | `x`                         | Selects or unselects the thread, to act on it with others                                                                                                                                   |
| The thread list | `I` and `U`                 | Marks read or unread the threads selected, as **Read** and **Unread** in the bar do, or with none selected, the thread                                                                      |
| The thread list | `/`                         | Opens the list's search field, selecting what it holds                                                                                                                                      |
| The thread list | `f`                         | Opens **Filters**                                                                                                                                                                           |
| The thread list | `s`                         | Puts focus on the order, opening its choices where the browser can                                                                                                                          |
| The thread list | `b`                         | Puts focus on the grouping, opening its choices where the browser can                                                                                                                       |
| A thread        | `u` or `Esc`                | Returns to the thread list                                                                                                                                                                  |
| A thread        | `r`                         | Puts focus in the composer's message box                                                                                                                                                    |
| A thread        | `e`                         | **Archive all**, then where **Auto-advance** says; while an ask is open to you, says why it waits                                                                                           |
| A thread        | `U`                         | **Mark unread from here** on the message that has focus, or else on the first that was unread as you opened the thread, or else on the agent's latest loaded message, returning to the list |
| A thread        | `[` and `]`                 | **Thread above** and **Thread below**                                                                                                                                                       |
| A thread        | `n`                         | **Jump to unread**, or **Jump to open ask**                                                                                                                                                 |
| A thread        | `1` to `9`                  | Chooses that suggested answer on the ask that has focus, or else the first open ask                                                                                                         |
| The composer    | `Ctrl+Enter` or `Cmd+Enter` | **Send**, once there is something to send                                                                                                                                                   |
| The composer    | `Esc`                       | Leaves the composer for its heading, where the thread's keys act again                                                                                                                      |

Leaving a thread with `u`, `Esc` or a `g` key keeps its draft, as leaving it any other way does. `U`
on a thread looks only at the messages the page has loaded, so on a thread you have read whose agent
last wrote before the newest 50 messages, `U` does nothing until you focus a message or show earlier
ones. Moving through the list moves focus from row to row, so a screen reader reads each row as it
is reached. With the list and a thread side by side, the list's keys act wherever focus is, and
moving through the list starts from the open thread's row and opens nothing until `o`; the thread's
keys act only while focus is outside the list, as after clicking the thread; `I` from the thread
marks it read in the list and leaves focus in the thread; and `n` and `U`, which both use, act in
the list while focus is in it, and in the thread otherwise. A screen reader in its browse mode keeps
single keys for its own navigation, so the shortcuts act only once it passes keys through, as in its
focus mode. To turn the shortcuts listed here off in this browser, if they get in the way of a
screen reader, voice control or another tool, clear **Keyboard shortcuts** in **Settings**, under
**Keyboard**, which also lists them. The diagram viewer's own keys stay on.

**Enter sends**, also under **Keyboard**, is off until you turn it on in a browser, which keeps the
choice. On, `Enter` in the composer's message or **Details** box sends, once there is something to
send, and `Shift+Enter` starts a new line, as in a terminal; `Ctrl+Enter` and `Cmd+Enter` send too
while the shortcuts are on. An `Enter` that ends an input method's composition only ends it, and
`Enter` on the composer's buttons presses them; a held `Enter` sends once, not again as it repeats.
While it is on, each box's hint says so. It is a choice of its own, so it holds with the shortcuts
off. A phone's on-screen keyboard has no `Shift+Enter`, so there it leaves no way to start a new
line: it suits a desktop browser. The new-thread sheet keeps `Enter` for a new line in its boxes
either way.
