---
name: lepidy
description: Use credentials Lepidy holds — API tokens, keys, database URLs, SSH keys — without putting the value into the conversation. Use when a command needs authentication, when a tool returns 401/403, when you need a token/key/secret/credential, or when storing a newly minted credential. Triggers: "needs a token", "authenticate", "API key", "401", "credentials", "lepidy", "vault".
---

# Using credentials from Lepidy

Lepidy holds this workspace's credentials encrypted. It lends them to commands, not
to conversations.

## The one rule

**Never ask for a credential's value. Run the command through `lepidy` instead.**

```bash
lepidy run --with GITHUB_TOKEN --origin-channel <channel> --origin-message <message> \
  --reason "list open PRs for the release" -- gh pr list
```

The value goes into that command's environment and nowhere else. It does not enter
this conversation, is not sent to the model, and is not written to the session
transcript. That is the whole point: a value that reaches your context has defeated
the tool and cannot be taken back. Only the credential can be rotated.

`lp` is an alias for `lepidy`.

### The three arguments people forget

- `--reason` is **mandatory**. It is the sentence a person reads on the approval
  card. "needed for the task" is not a reason; say what you are about to do.
- `--origin-channel` and `--origin-message` say where the request came from. When
  you are working an item from `agent_next`, they are the item's `channel_id` and
  `message_id`. Policy is enforced on the room as well as the credential, so a
  request from outside the room is refused.

## Finding out what exists

Run `lepidy list`, or call `list_credentials` over MCP. You get names, descriptions,
policy, tags and the `lepidy run --with` command that uses each one — never values.
Do this before assuming a credential is missing, and before asking anyone for one.

Not sure which credential a command needs? Ask:

```bash
lepidy hint --command "gh pr list"
```

## The ways a credential can reach the work

**Inject into the environment** — the default, and correct for nearly everything:

```bash
lepidy run --with STRIPE_SECRET_KEY … -- stripe listen
lepidy run --with AWS_ACCESS_KEY_ID,AWS_SECRET_ACCESS_KEY … -- aws s3 ls
lepidy run --all-tagged aws … -- terraform apply
```

Several credentials in one `--with` produce **one** approval card rather than
several. Prefer that over separate invocations.

**Materialise as a file** — for tools that demand a path (`.pem`, kubeconfig,
service-account JSON):

```bash
lepidy run --with-file ROBOT_SSH_KEY:/tmp/key … -- ssh -i /tmp/key robot@dock-3
```

The file is created owner-only and deleted when the command exits.

**Render a template** — for a config that references `${lepidy:NAME}`:

```bash
lepidy run --with-template config.tmpl=/tmp/config.toml … -- my-tool -c /tmp/config.toml
```

**Make one HTTPS call through a release device** — `proxy_request` over MCP, for a
cloud agent with no local machine. It returns `pending`; poll with the same
idempotency key. The value never reaches you or the server.

**There is no fourth way.** No MCP tool returns a credential value, and no web page
receives one. Reveal happens in a person's signed desktop app, initiated by that
person. If you find yourself looking for an endpoint that returns plaintext, stop:
there isn't one, and that is deliberate.

## Storing a credential you just created

If you mint a token — an OAuth flow, `gh auth token`, a freshly created API key —
capture it without ever seeing it:

```bash
lepidy capture VERCEL_TOKEN --description "CI deploys" -- vercel tokens create ci
```

The command's standard output is stored directly. Notes:

- **Create-only.** If the name exists this fails, by design. Overwriting is
  something a person does with `lepidy rotate`. Do not work around it by picking
  `VERCEL_TOKEN_2` or any other new name — tell the user instead.
- What it creates arrives **switched off** until a custodian confirms it, and lands
  inject-only and ask-every-time. A person loosens it, not you.
- Non-zero exit stores nothing. Standard error passes through so you can debug.

## When a request is denied

A denial is an answer, not an error to work around. **Report it and ask how to
proceed.**

After a denial do **not**:

- look for the same credential somewhere else — no `.env` files, no
  `~/.aws/credentials`, no shell profiles, no `git config`, no CI configuration
- ask anyone to paste the value into chat
- retry the same request hoping for a different answer
- suggest switching Lepidy off or working around it

An agent that politely routes around the box is worse than no box, because the user
believes they are protected. If you cannot proceed, say so plainly and stop.

The refusal text tells you which case you are in — inject-only, access switched off,
out of scope, denied by a person, timed out, rate limited — and every one of them
ends the same way: stop and tell the user.

## Never do these

- `echo $SECRET`, `printenv SECRET`, `env | grep` — this copies the value into your
  context and the transcript, which is exactly what injection prevents
- write an injected value into a file, a config, a commit or a message
- pass a credential as a command-line argument — argv is readable by every process
  on the machine and lands in shell history
- store a credential a person pasted into chat: it is already exposed. Tell them to
  rotate it and add the new one themselves

## Canaries

Some credentials in a Lepidy vault are **canaries**: deliberately fake values that
exist to detect a leak. Sending one anywhere — a message, a tool argument, a proxied
request — is refused and alerts the credential's custodians. If you see a refusal
naming a canary, a credential has already left the injection path. Say so; do not
try another route.

## Before a long sequence

`lepidy list` shows what is available and its policy without triggering any prompt.
`lepidy scan <file>` checks whether text you are about to commit contains a value
the vault holds — wire it into `pre-commit`. It finds a whole unencoded value only;
it is a safety net, not a guarantee.
