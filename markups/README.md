# Lepidy — screen mockups

Real HTML, CSS and JS. No build step, no framework, no `node_modules`.
Open `index.html` for the walkthrough hub, or start anywhere — every screen has a
navigation bar pinned to the bottom with prev / next and a one-line note about
what to look at.

## Run it

```bash
python3 -m http.server 4173 --directory markups
```

Then open <http://localhost:4173/>.

## What's here

| | Screen | |
|---|---|---|
| 01 | `home.html` | Ranked feed — what needs you, what agents did overnight |
| 02 | `channel.html` | The core view: AGENT badge, provenance chip, live session, inline approval |
| 03 | `dm.html` | Two people, a code block, a link to the board — it has to be a good messenger first |
| 04 | `queue.html` | **Work queue** — form intake, one-vote-per-person ranking, owner-defined statuses. Click a 🔥 |
| 05 | `search.html` | Operators you already know; spans people, agents, files and form entries |
| 06 | `inbox.html` | Mentions, threads and approvals in one list |
| 07 | `notifications.html` | Agents notify at a lower tier than people; only approvals beat focus |
| 08 | `people.html` | Directory, local time, focus state, groups, the seat boundary |
| 09 | `agents.html` | The promoted rail item — the agent directory |
| 10 | `agent.html` | Owners, standing brief, security preamble, scope, interaction list |
| 11 | `runtime.html` | Connected / Local / Claude Cloud / Custom. Deep-link: `?runtime=cloud` |
| 12 | `vault.html` | Credentials, live grants, the kill switch |
| 13 | `credential.html` | Disclosure tiers, the ACL's three verbs, the access log |
| 14 | `sessions.html` | Concurrent devices; client sessions vs. runner registrations |
| 15 | `mobile.html` | The approvals companion |
| 16 | `signin.html` | Our own accounts, Google as a way in |
| 17 | `pricing.html` | The plan ladder |

## Two signature elements

Both encode something true rather than decorating:

- **The provenance chip** — `⟡ a.releasebot · via maya`. Identical wherever an agent
  acts: on a message, in an audit row, on an approval card. It's the product's
  argument rendered as one small component.
- **The flight path** — the brand's "movement & direction" motif, animated, used to
  mean exactly one thing: a harness session is running on somebody's machine right
  now. It never appears as ornament.

## Structure

```
assets/css/tokens.css   brand palette, type scale, light + dark themes
assets/css/app.css      every component
assets/js/data.js       fixtures — the same people, agents and credentials on every screen
assets/js/shell.js      renders the rail, topbar and walkthrough bar; icons; avatars
assets/img/*.svg        the mark, a monochrome mark, the gradient wash, an empty state
```

Editing `data.js` changes the content on every screen at once. Editing
`tokens.css` re-themes the lot.

## Notes

- Dark mode works — the moon button in any top bar, and it persists.
- Avatars are generated from initials on brand gradients. Nothing here is a
  photograph of a person.
- Palette, typefaces (Sora + Inter) and motifs come from `../brandkit/`.
  JetBrains Mono is the one addition: this product's most distinctive surfaces are
  a launch command and an audit log, and setting those in Inter would misrepresent
  what they are.
