# undo-send

![undo-send: give your agent an undo button](https://raw.githubusercontent.com/askeleven/undo-send/main/docs/social-preview.png)

**Give your agent an undo button.**

```bash
npm install @askeleven/undo-send
```

```js
import { createOutbox, fileStore } from '@askeleven/undo-send'

const outbox = createOutbox(fileStore('./outbox.jsonl'), {
  delay: '2m',
  secret: process.env.UNDO_SEND_SECRET,
  baseUrl: process.env.UNDO_SEND_URL,
})
outbox.register('email', (payload) => mailer.send(payload))
outbox.start()

// Where your agent used to call mailer.send:
const { id, dueAt, undoUrl } = await outbox.hold('email', message, {
  summary: `Email to ${message.to}: ${message.subject}`,
})
```

Mail apps have had an undo button for years, because people press send and then see the
mistake. An agent makes the same mistakes, faster, and has no button: the email to the
wrong customer, the quote with last year's prices, the text at 2am. undo-send holds each
action for a short delay before it runs. In that time a person can undo it, from a link,
the command line or your own code. When the delay is up it runs, once.

Any action, not only email: texts, refunds, CRM updates, anything your agent would rather
take back. Zero dependencies.

---

## What it guarantees

| What could go wrong | What undo-send does |
|---|---|
| **Someone presses undo as it is about to run** | Undoing and starting are each one compare-and-set on the stored status. One wins. An undone action never runs; one that started cannot be undone, and the person is told it is too late. |
| **Two runners**, or a restart while one is running | Each action starts once. A runner that loses the race skips it. |
| **The process dies mid-send** | The action stays `executing`. It is never retried on its own, because nobody knows whether it went. `undo-send list` shows it; you check with the provider and `resolve` it. |
| **The executor throws** | The action is `failed`, with the error. It is not retried. |
| **The same action is held twice** | Pass your own `id` and the second `hold` returns the first entry, not a second action. |
| **A link preview opens the undo link** | Nothing happens. Slack, Teams and mail apps fetch every URL they see, so opening a link only shows what will happen and when. Only the button on that page undoes it. |
| **Someone guesses an undo link** | They cannot. Each link carries an HMAC of the action's id, checked in constant time. A wrong token gets the same "not valid" page as an id that does not exist. |

## What it does not do

**It does not decide what should be held.** Your code calls `hold` instead of sending.
Anything sent another way is not in the outbox.

**It cannot undo what has gone.** After the delay the action runs, and an email that has
been sent stays sent. The delay is the undo window; pick one a person can act within.

**It does not tell anyone.** `hold` returns the `undoUrl`; posting it where a person will
see it, such as a Slack channel or the agent's chat, is up to you.

**It does not delete old entries.** The outbox file keeps every state of every action,
payloads included. Treat it like a mail log, and rotate it when you need to.

---

## Undo

**From the link.** `hold` returns an `undoUrl` when the outbox has a `secret` and a
`baseUrl`. Serve the links with the CLI:

```bash
export UNDO_SEND_SECRET=$(npx @askeleven/undo-send secret)
npx @askeleven/undo-send serve --outbox outbox.jsonl --port 8787
```

or inside your own server, which also works behind a path prefix:

```js
import { createUndoHandler } from '@askeleven/undo-send'

app.all('/undo/:id', createUndoHandler(outbox))
```

The page shows the summary you gave, when it goes, and one button. It is not cached, not
indexed, cannot be framed and sends no referrer, so the link does not leak from it.

**From the command line.**

```
$ npx @askeleven/undo-send list --outbox outbox.jsonl
sent       u_8fQ2mXv0aLc  sent 4m ago  email  Email to sam@shop.example: Order 1182 shipped
held       u_3kP9xq2LmA0  due in 1m    email  Email to dana@acme.com: Your quote
held       u_Zt71bQe9sKw  due in 2m    sms    Text to +1 555 0100: Your table is booked

2 held

$ npx @askeleven/undo-send cancel u_3kP9xq2LmA0 --reason "wrong prices"
Undone: u_3kP9xq2LmA0. It will not run.
```

**From code.** `await outbox.cancel(id, { by, reason })` returns `cancelled`,
`already_cancelled`, `too_late` or `not_found`.

## CLI

```
undo-send list [--status <status>]
undo-send show <id>
undo-send cancel <id> [--reason <text>]
undo-send send-now <id>
undo-send resolve <id> <sent|failed> [--note <text>]
undo-send serve [--port <n>] [--host <addr>]
undo-send secret

--outbox <file>   Default $UNDO_SEND_OUTBOX.
--by <name>       Recorded on the entry. Default $USER.
--json            Machine-readable output.
```

Exit code `0` means done, `1` means refused (not found, or too late), `2` means it could
not run. `serve` listens on 127.0.0.1 by default; put a proxy with TLS in front of it.

## The library

`createOutbox(store, options)` takes:

- `delay`: how long each action waits. A number of milliseconds or `'30s'`, `'2m'`,
  `'1h'`. Default `'2m'`.
- `secret`: signs undo links. At least 32 characters, from the environment, never source.
- `baseUrl`: where the undo server is reachable.
- `now`: a clock, for tests.

The outbox has:

- `register(action, executor)`: the function that runs an action, given its payload.
- `hold(action, payload, { summary, delay, id, by })`: holds it. The payload must be
  JSON, because it is stored until it runs. Returns `{ outcome, id, dueAt, undoUrl, entry }`.
- `cancel(id, { by, reason })`: undoes it, if it has not started.
- `sendNow(id)`: skips the rest of the wait.
- `run({ limit })`: runs what is due, once, and returns what happened to each.
- `start({ every })`: calls `run` on a timer, default every second. Returns `{ stop }`.
- `resolve(id, 'sent' | 'failed', { by, note })`: settles one left `executing`.
- `get(id)`, `list({ status })`, `undoUrl(id)`.

Statuses are `held`, `cancelled`, `executing`, `sent` and `failed`.

### Stores

`fileStore(path)` is an append-only JSONL file. Every change is one line, written under a
lock and synced to disk before `hold` returns, so an undo link is never handed out for an
action that a crash could lose. It is for one machine on a local disk.
`memoryStore()` is for tests: held actions are lost on restart.

For a database, implement four methods: `claim(key, entry)` writes only if the key is
new, `transition(key, from, entry)` writes only if the status is still `from`, and `get`
and `list` read. The two writes must be atomic; in SQL that is an `INSERT ... ON CONFLICT
DO NOTHING` and an `UPDATE ... WHERE status = $from`, each checking the row count.

### With send-once

undo-send decides whether an action still goes after a person had the chance to stop it.
[send-once](https://github.com/askeleven/send-once) decides whether it has gone already
and whether its approval is still true. They stack: call send-once inside the executor.

## Privacy

Nothing leaves your machine except what your executors send. There is no other network
code. The outbox file holds the payloads you give it.

## Requirements

Node 20 or newer. No dependencies.

---

## Why we built it

[AskEleven](https://askeleven.com) runs AI employees that email and text candidates and
customers for small businesses. An agent that sends on its own needs a moment in which a
person can still stop it. This is that moment, in the code path that sends.

## Contributing

Issues and pull requests welcome, especially:

- **Stores** for Postgres, SQLite and Redis, with tests for the two atomic writes.
- **Ways it can run twice or not at all** that the tests do not cover.
- **Undo page** wording and accessibility.

Run the tests with `npm test`. They use a fake clock and temporary files, and the race tests
run two outboxes against one file.

## License

MIT. See [LICENSE](LICENSE).
