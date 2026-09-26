// Seed knowledge for the demo community: the Build with Swytchcode (Gurgaon)
// buildathon. Sources: the official participant guide + our own verified
// Swytchcode findings (docs/swytchcode-research.md). Everything else Pulse
// knows is learned from mods and members at runtime.

export interface SeedEntry {
  question: string
  answer: string
}

const GUIDE = 'Participant guide'

export const SEED: SeedEntry[] = [
  // ── Event logistics ──────────────────────────────────────────────────────
  {
    question: 'When and where is the event?',
    answer:
      'Saturday 26 September 2026, 9:00 AM – 5:00 PM at the Thoughtworks office, International Tech Park, Sector 59, Gurugram, Haryana 122011. It is a solo, hybrid buildathon.',
  },
  {
    question: 'What is the schedule for the day?',
    answer:
      '9:00–9:50 registration & setup · 9:50–10:15 opening session · 10:15–12:50 build session I · 12:50–1:00 check-in · 1:00–1:40 lunch · 1:40–3:30 build session II · 3:30 submission deadline · 3:30–3:45 shortlisting · 3:50–4:20 final jury round · 4:25–4:50 closing ceremony.',
  },
  {
    question: 'What is the submission deadline?',
    answer: 'Final submission is due at 3:30 PM on Commudle. Late submissions may not be considered.',
  },
  {
    question: 'Where do I submit my project?',
    answer: 'On Commudle: https://www.commudle.com/builds/create?campaign=BuildWithSwytchcode',
  },
  {
    question: 'What do I need to include in my submission?',
    answer:
      'A working AI agent, at least 3 Swytchcode API integrations, a public GitHub repo, a README, an architecture diagram, setup instructions, a demo/prototype and the Commudle submission. A LinkedIn or X post mentioning Swytchcode is optional.',
  },
  {
    question: 'When is lunch?',
    answer: 'Lunch is 1:00–1:40 PM, right after the 12:50 check-in.',
  },
  {
    question: 'Can I participate in a team?',
    answer: 'No. Participation is strictly solo.',
  },
  {
    question: 'Can I change my track after selecting it?',
    answer: 'No. Once the track selection form is submitted, the track cannot be changed during the event.',
  },
  {
    question: 'Where is the track selection form?',
    answer: 'https://forms.gle/DZz8fzQh8PNxcbPXA (mandatory before you start building).',
  },
  {
    question: 'What are the tracks?',
    answer:
      '1 AI Software Engineer (GitHub, Jira, Slack) · 2 AI Knowledge Worker (Gmail, Drive, Notion, Box, Slack) · 3 AI Community Agent (X, Telegram, Slack, Notion, Resend) · 4 AI Meeting & Productivity (Meet, Gmail, Notion, Drive, Slack) · 5 AI Real World Agent (OpenWeather, Gmail, Notion, Slack, Resend) · 6 AI Business Operator (PayPal, Gmail, Slack, Jira, Notion).',
  },
  // ── Rules & judging ──────────────────────────────────────────────────────
  {
    question: 'How are projects judged?',
    answer:
      'Swytchcode API integration 30% · technical implementation 25% · innovation & originality 20% · functionality 10% · real-world impact 10% · UX & presentation 5%.',
  },
  {
    question: 'How does the final round work?',
    answer:
      'Mentors score projects during the build sessions and shortlist the top 7–10. Finalists give a 4-minute live demo to the jury: 2.5 minutes of demo + 1.5 minutes of Q&A, between 3:50 and 4:20 PM.',
  },
  {
    question: 'What counts as an AI agent here?',
    answer:
      'An agent that understands a request, reasons about it, decides which tools/APIs to use, executes multiple actions, processes the results and follows up. A traditional app that only makes direct API calls does not meet the objective.',
  },
  {
    question: 'Which agent frameworks are allowed?',
    answer:
      'Any comparable agentic framework: LangGraph, CrewAI, OpenAI Agents SDK, Vercel AI SDK, Anthropic SDK, Google ADK, Pydantic AI, or agent platforms like OpenClaw and Hermes.',
  },
  {
    question: 'How many Swytchcode APIs do I need?',
    answer:
      'At least 3, meaningfully integrated: the output of one tool should influence the agent’s next action (e.g. GitHub → analyse → Jira → Slack).',
  },
  {
    question: 'Can I use AI coding assistants?',
    answer: 'Yes. AI coding assistants and other dev tools are allowed.',
  },
  {
    question: 'Do I need paid accounts for the integrations?',
    answer: 'No. Free tiers or trials are fine. Create your own accounts/workspaces and use test or dummy data.',
  },
  {
    question: 'Is an interactive demo required?',
    answer:
      'Strongly recommended, not mandatory: a prompt box where judges type a request and watch the agent’s steps, tool choices, Swytchcode calls and final result in real time.',
  },
  // ── Swytchcode how-to (verified against CLI 2.23.7) ──────────────────────
  {
    question: 'How do I install the Swytchcode CLI?',
    answer:
      '`npm install -g swytchcode`, then `swy --version`. On Windows the npm postinstall removes the .ps1 shims; call the exe directly or point SWYTCHCODE_BIN at node_modules/swytchcode-cli-win32-x64/bin/swytchcode.exe.',
  },
  {
    question: 'How do I find the right canonical ID for an API method?',
    answer:
      '`swy discover "<what you want>" --provider <name> --json --top 10`, then check it with `swy info <id> --json`. The best match is not always first. IDs drift between bundle versions, so commit your .swytchcode folder.',
  },
  {
    question: 'swy list methods prints nothing, is it broken?',
    answer:
      'In 2.23.7 `swy list methods` prints nothing even with bundles installed. Use `swy discover`, `swy info <id>`, or read the CANONICAL_ID lines in .swytchcode/integrations/**/wrekenfile.yaml. `swy list tooling --json` does work.',
  },
  {
    question: 'How do I call a tool from Node/TypeScript?',
    answer:
      '`import { exec } from "@swytchcode/runtime"` then `await exec("slack.chat.postmessage.create", { body: { channel, text } })`. The documented SwytchcodeRuntime class does not exist. Install zod explicitly or you get "Cannot find module zod".',
  },
  {
    question: 'What is the argument shape for swy exec?',
    answer:
      'JSON on stdin: `{ "body": {...}, "params": {...path/query...}, "headers": {...}, "Authorization": "Bearer ..." }`. Path ids like Notion page_id go in params; POST fields go in body.',
  },
  {
    question: 'swy exec hangs forever',
    answer:
      'Every swy subcommand reads stdin when it is not a TTY. If you spawn it from code, always close stdin (e.g. `child.stdin.end()`), otherwise it waits forever.',
  },
  {
    question: 'How do I preview a call without sending it?',
    answer:
      'Add `--dry-run`: Swytchcode prints the exact HTTP request (method, URL, body) with auth redacted, and policies are still enforced. Great for approval screens.',
  },
  {
    question: 'How do Swytchcode policies work?',
    answer:
      'Rules in .swytchcode/integrations/policies.json are checked before execution: target tool ids, a `when` condition (operators like matches, in, >, starts_with, and all/any/not groups) and an action (POLICY_BLOCKED, RATE_LIMITED…). Use bare field names like `text`, not `body.text`.',
  },
  {
    question: 'Slack returns ok:false but swy says success',
    answer:
      'Slack answers HTTP 200 with {"ok":false,"error":...} and the CLI exits 0. Always check `data.ok` yourself: 200 OK is not success.',
  },
  {
    question: 'How do I use Telegram through Swytchcode?',
    answer:
      'The Telegram base URL needs the bot token (`https://api.telegram.org/bot<TOKEN>`), and `{token}` is not substituted by pass-through auth. Patch production_endpoint in a gitignored copy of .swytchcode/integrations/manifest.json.',
  },
  {
    question: 'Is REQUIRES_APPROVAL (human approval) available on the free plan?',
    answer:
      'No, it needs the Business plan. Setup: enable Socket Mode on a Slack app (app token xapp- with connections:write), then app.swytchcode.com → Settings → Workspaces → HITL Notifications → Slack (bot token, app token, channel ID). A held call exits 7 and runs after Approve; a dry-run exits 7 too but creates nothing. Without a provider you get "No active HITL provider configured" and nothing runs. Track requests with `swy audit policy hitl|approved|rejected`. On free, build your own loop: dry-run, ask a human, then exec.',
  },
  {
    question: 'How do I pass API keys to Swytchcode?',
    answer:
      'Either `swy auth connect <provider>` (managed), or pass-through per call: `"Authorization": "Bearer <token>"` in the exec args. Never paste real tokens in this chat, rotate them if you do.',
  },
  {
    question: 'Who is Pulse?',
    answer:
      'Pulse is this community’s AI assistant, built on Swytchcode. It answers from the community knowledge base in Notion, asks the organizers when it doesn’t know, and learns their answers so the next person gets an instant reply.',
  },
]

export const SEED_SOURCE = GUIDE
