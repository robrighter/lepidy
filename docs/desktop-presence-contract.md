# The desktop presence contract

Status: implemented 2026-09-09 (P01a). Companion to the
[native shell contract](./native-shell-contract.md), which owns the trusted
origin, the command surface, the native gesture and the tray.

This records the five things the desktop shell does when nobody is looking at
it — deep links, notifications, the unread badge, the kill-switch chord and the
offline fallback — and what guards each of them.

## 1. The premise, restated for input that arrives from outside

R03's premise is that the window renders content written by agents and by
strangers. P01a adds a second one, and it is sharper: **a registered URL scheme
is an entry point into this process from the entire operating system.** Any web
page can navigate a browser to `lepidy://…`, any message can contain one, and
the platform hands it over without asking anybody.

So a deep link is treated exactly like a message body, and the same parser
guards both the links the platform delivers and the destinations the page
attaches to a notification. There is one place where "where may this take you"
is decided.

## 2. Deep links name a place, never a URL

`deeplink::parse` returns a `Destination` from a closed set, and the shell
builds the address itself by joining that destination's path onto the trusted
origin. **No branch anywhere navigates to a string a link supplied.** That is
what makes `lepidy://open?next=https://evil.test` a parse failure rather than a
redirect.

| Refused | Because |
|---|---|
| A query or a fragment | That is how "open this" becomes "open this, and then go here" |
| Any percent-encoding | Nothing accepted needs an escape, and a decoder here is where `%2e%2e%2f` gets in |
| A backslash | A path separator on one of the three platforms and not on the other two |
| `.`, `..`, an empty or over-long segment | The two strings segment validation exists to keep out of a path |
| An unknown destination | Refused and reported, never quietly opened at the home page: a link that silently went somewhere else makes a mistyped link indistinguishable from a working one |

**No verb does anything.** There is no `lepidy://approve/…`, no
`lepidy://stop`, no `lepidy://release/…`. Every member of the set shows a page.
A link that could approve would be an approval anybody could cause by getting
one click, and §8.6's whole argument is that the person decides at a surface
they trust. The set is asserted as a test, because the temptation to add an
action arrives with the first notification somebody wants a button on.

Whether the room exists and whether the viewer may see it is decided by the
workspace on the read, with the viewer's authority, exactly as for a link they
typed. The parser owns shape only.

## 3. A notification is text, and its click stays here

`presence::prepare` sanitises before anything reaches the operating system:

- **Control characters**, including newlines, become a single word break. A
  notification is one or two lines of chrome, and a body carrying twenty
  newlines pushes the half a person needed off the visible area — which is how a
  preview of an approval ends up showing only the reassuring part.
- **Bidirectional overrides** (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F) are
  removed. They reorder the characters *around* them when rendered, so a message
  body can rewrite how the title beside it reads.
- **Length** is bounded here rather than by the platform, counted in characters
  so a Japanese preview is not cut to a third of a Latin one.
- **Nothing legible** is a refusal. A notification with an empty title is a blank
  popup carrying this product's icon, which teaches people the icon means
  nothing.

The activation target goes through `deeplink::parse`, so a click cannot leave
this workspace. The desktop notification plugin exposes no activation callback,
so the validated **path** is returned to the page, which navigates itself; the
value is that the shell decided where a notification may lead, and no URL the
page composed decided anything.

## 4. The badge is a count

`presence::badge_label` takes a number and returns digits, or `"99+"`, or
nothing. There is no interface anywhere that puts a string in a badge.

That is narrow on purpose. A badge whose contents came from a message would put
a stranger's characters into the operating system's own chrome — the dock, the
taskbar, the window list — in a place no sanitiser of ours sits between. There
is no story where that is worth the flexibility. Zero clears rather than showing
a nought, because a dock icon reading `0` says there is something here.

`badge_count` clamps identically, so the dock and the tray never give two
answers to one question. Windows has no count badge; its tray tooltip carries
the number and its taskbar overlay icon is P01b's.

## 5. One global chord, and it stops

§10.4 gives the kill switch four independent paths so that no single one being
unavailable is safety-critical. The global hotkey is the desktop app's fastest:
it works with the window closed, behind something else, or on a machine whose
tray the desktop environment declined to render.

- **The action is fixed.** Exactly one shortcut is registered and it calls the
  supervisor's stop. Nothing — page, deep link or file — can point it elsewhere.
  A hotkey that could be rebound to *start* would be a machine that begins
  answering for somebody's agents because of a keystroke in another application.
- **The chord is chosen on the machine.** `LEPIDY_KILL_SWITCH`, validated by
  `hotkey::Chord::parse`; the default is `CommandOrControl+Alt+Shift+K`.
  Deliberately awkward: a global chord takes that key from every other
  application, and this one stops work.
- **A mistyped override is fatal, not replaced.** A person who configured a
  chord and silently got the shipped one would believe they had a kill switch on
  a key that does nothing.
- **A chord with no real modifier is refused**, because `Shift+K` is how a person
  types a capital K, and so are chords the platforms already own.
- **A failed registration is reported**, and the message names the tray, the CLI
  and the web app. A kill switch that is silently not registered is a kill switch
  that does not exist, and the moment somebody discovers that is the moment they
  needed it.

## 6. The offline fallback says what is actually true

The interesting part of an offline fallback in *this* product is not the page.
The runner holds its own outbound socket and has never needed this window, so
**"my laptop cannot reach the workspace" and "my agents have stopped" are
different facts**, and a person deciding whether to worry acts on the
difference. The fallback's text is generated natively from the supervisor's own
state, and the three runner states read differently — a runner that exited on
its own is not a runner somebody stopped.

Only a load that never finished puts the window on the fallback. An HTTP error
or a sign-in redirect is the workspace talking, and replacing that with "you are
offline" would name the wrong problem. The wait is twelve seconds; retries
double to a five-minute cap, so a laptop shut for a weekend comes back to a
window that is still trying and a workspace that is genuinely down is not
retried by every desktop in a company twice a second.

**The fallback document has no native privileges, and that is not an oversight.**
It is served from the application's own scheme, not from the trusted origin, so
`require_trusted_caller` refuses every command to it — including `runner_stop`.
The whole reason the origin check is worth having is that it has no exceptions,
and a local page that could stop the runner would be a local page worth
navigating somebody to. The stop is reachable anyway, which is the point of
giving it four paths, and the fallback's job is to *say so*: its text names the
tray, `lepidy agentd stop` and the web app on another device.

The navigation guard admits exactly two things — the trusted origin and this one
document, matched by exact host and exact path. Being admitted is not being
trusted.

## 7. The workspace origin's capability

A capability file is decided when the binary is built; the origin this shell
trusts is decided when it starts, because a production origin baked into a
binary is a default nobody notices is wrong. `grant_workspace_capability` is the
join: one window, remote-only, the same seven window-chrome permissions the
checked-in file grants loopback, and the one origin `TrustedOrigin` already
validated. It cannot admit a second origin because there is only ever one, and a
test asserts the two permission lists are identical.

The three plugins P01a adds — deep link, notification, global shortcut — are
**Rust dependencies, not granted capabilities.** No page can register a global
shortcut, claim a scheme, or raise a notification that skipped
`presence::prepare`.

## 8. Required automated scenarios

All of these exist and pass; see `TESTING.md` for where.

1. A deep link that cannot carry a URL, an encoding, a traversal or a verb.
2. Every destination producing a rooted, single-query path on its own origin.
3. A notification body that cannot stop being one line of text, and a title that
   cannot be empty.
4. A notification destination refused for everything `deeplink::parse` refuses.
5. A badge that is digits and at most one `+`, for every input including
   `u64::MAX`.
6. A chord with no real modifier, a reserved chord and an unknown key refused,
   and a mistyped override refused rather than replaced.
7. A failed registration naming the three other stop paths.
8. An offline status that never says the agents are stopped when they are not,
   and always names where the stop is.
9. The bundled document admitted by the navigation guard and every look-alike,
   sibling page and query-carrying variant refused.
10. The grace period, the give-up that keeps its attempt count, and a capped
    backoff.
11. The configuration asserted: the command list, the two permission lists
    agreeing, the single declared scheme matching the parser, the fallback
    document fetching nothing and offering no control, and the kill-switch
    handler containing no start.

## 9. What P01a does not claim

- **No GUI is driven.** No window, tray click, notification popup, badge or
  chord press is exercised by an automated scenario. That is P01b's WebdriverIO
  Tauri harness, which R03 already deferred and which now also owns this.
- **A webview that renders its own error page inside the grace period** is not
  detected as an outage by the load watch, because the platform reports that
  load as finished. Which platforms do this is a question only a driven GUI can
  answer.
- **macOS is unexercised**, as everywhere else in this product: there is no
  macOS machine. The dock badge label and the traffic-light chrome are written
  and compiled for it and have never run.
- **Signing, bundling and the updater are P01b.** `bundle.active` is still
  `false`; nothing here produces an installable artifact.
