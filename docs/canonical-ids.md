# Canonical IDs: the fail-closed allow-list

Verified 2026-09-25 against swytchcode **2.23.7**. Bundles: Telegram `telegram_v5_0@1.0.0`, Slack `slack@1.7.0`, Notion `notion@2.0.0`, Resend `resend@1.5.0`.

These are the only tools registered in `.swytchcode/tooling.json`. Anything else returns `category: not_found` (fail-closed), which the guardrail self-test proves with `telegram_v5_0.deletemessage.create`.

| Provider | Canonical ID | Used for |
|---|---|---|
| Telegram | `telegram_v5_0.getupdate.create` | Inbound long-poll (`body.offset`, `body.timeout`) |
| Telegram | `telegram_v5_0.sendmessage.create` | Replies and announcements |
| Telegram | `telegram_v5_0.editmessagetext.create` | Swap the "verifying…" placeholder for the answer |
| Telegram | `telegram_v5_0.sendchataction.create` | "typing…" indicator |
| Telegram | `telegram_v5_0.getchatmember.create` | Membership check → DM policy |
| Telegram | `telegram_v5_0.getchat.create` | Chat metadata |
| Telegram | `telegram_v5_0.getme.create` | Bot identity (mention detection) |
| Slack | `slack.chat.postmessage.create` | Community replies, `#doc-drift`, `#community-team` |
| Slack | `slack.chat.update.create` | Placeholder → answer |
| Slack | `slack.conversations.history.list` | Inbound polling (`params.channel`, `params.oldest`) |
| Slack | `slack.conversations.reply.list` | Thread replies (escalation relay) |
| Slack | `slack.conversations.member.list` | Channel members → DM policy |
| Slack | `slack.conversations.info.list` | Channel metadata |
| Slack | `slack.reactions.add.create` | 👀 / ✅ acknowledgements |
| Slack | `slack.users.info.list` | Display names |
| Slack | `slack.auth.test.list` | Bot identity |
| Notion | `notion.databas.get` | Read the drift DB → `data_sources[0].id` |
| Notion | `notion.data_source.get` | Data-source schema |
| Notion | `notion.query.create` | Dedupe query (`POST /v1/data_sources/{data_source_id}/query`) |
| Notion | `notion.page.create` | New drift ticket |
| Notion | `notion.page.update` | Bump "Times hit", or set status |
| Notion | `notion.page.get` | Read ticket status (loop closure) |
| Notion | `notion.comment.create` | Repeat hits as comments |
| Notion | `notion.search.create` | Find the DB if its ID is unknown |
| Resend | `resend.email.create` | Weekly digest (`Idempotency-Key` header is passed through) |

## Arg shapes (from `swy info`, trimmed)

- **Telegram:** everything goes in `body`. `chat_id` is `integer|string`.
- **Slack:** reads (`*.list`) take query `params`, e.g. `{"params":{"channel":"C…","oldest":"…"}}`. Writes take `body`, e.g. `{"body":{"channel":"C…","text":"…"}}`.
- **Notion:** path IDs go in `params`, e.g. `{"params":{"data_source_id":"…"}}`.
  - The bundle sends `Notion-Version: 2025-09-03` itself (the data-source API), so the wrapper does not add one.
- **Resend:** `{"body":{"from","to","subject","html"},"headers":{"Idempotency-Key":"digest-2026-W39"}}`.

## Findings worth knowing
- `swy list methods [provider]` prints **nothing** in 2.23.7, even with bundles present. The wrapper's `swyListMethods()` falls back to scanning the local wrekenfiles.
- `swy list tooling --json` works: it lists the allow-list.
- `swy exec` on a non-allow-listed tool first tries to **fetch the provider bundle over the network**, then fails with `not_found`.
- Every swy subcommand **reads stdin when it isn't a TTY**, and hangs forever if stdin stays open (`swy info x > file` hangs). The wrapper always closes stdin.
- Slack returns HTTP 200 with `{ok:false}` for auth and other errors, and the CLI exits 0 ("200 OK is not success"). The wrapper raises `SwyError{category:'provider_error'}`.
