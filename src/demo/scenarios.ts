// Scripted demo scenarios. Only the members are fake: every Pulse reaction
// is the real agent, real LLM, real Swytchcode calls, real Notion writes.

export interface Persona {
  id: string
  name: string
  role: 'member' | 'organizer'
  avatar: string
}

const avatar = (seed: string) => `https://api.dicebear.com/9.x/notionists/png?seed=${encodeURIComponent(seed)}&size=128&backgroundColor=e0e7ff,fae8ff,dcfce7,fef3c7`

export const PERSONAS: Record<string, Persona> = {
  aarav: { id: 'aarav', name: 'Aarav Mehta', role: 'member', avatar: avatar('Aarav') },
  meera: { id: 'meera', name: 'Meera Iyer', role: 'member', avatar: avatar('Meera') },
  kabir: { id: 'kabir', name: 'Kabir Singh', role: 'member', avatar: avatar('Kabir') },
  ishaan: { id: 'ishaan', name: 'Ishaan Verma', role: 'member', avatar: avatar('Ishaan') },
  sana: { id: 'sana', name: 'Sana Qureshi', role: 'member', avatar: avatar('Sana') },
  rohan: { id: 'rohan', name: 'Rohan Das', role: 'member', avatar: avatar('Rohan') },
  dev: { id: 'dev', name: 'Dev Patel', role: 'member', avatar: avatar('Dev') },
  neha: { id: 'neha', name: 'Neha Kapoor', role: 'organizer', avatar: avatar('Neha') },
}

export type Beat =
  | { caption: string }
  | { join: string }
  | { say: string; text: string; wait?: number }
  | { settle: true }
  | { modReply: string; text: string }
  | { approve: string }
  | { console: string }
  | { sweep: true }
  | { digest: true }
  | { pause: number }

export interface Scenario {
  id: string
  title: string
  description: string
  shows: string[]
  beats: Beat[]
}

const learn: Beat[] = [
  { caption: 'A member asks something the knowledge base has never seen' },
  { say: 'ishaan', text: 'Is there parking at the Thoughtworks office? Coming by car tomorrow 🚗' },
  { settle: true },
  { caption: 'Pulse asked the organizers in #mods. An organizer replies once…' },
  { pause: 2500 },
  { modReply: 'neha', text: 'Yes! Free visitor parking in the Tower B basement. Show your registration QR at the gate.' },
  { settle: true },
  { caption: '…Pulse relays it and saves it to Notion. Next person gets an instant answer' },
  { pause: 2000 },
  { say: 'sana', text: 'anyone know if we can park at the venue?' },
  { settle: true },
]

const helpers: Beat[] = [
  { caption: 'A member answers another member. Pulse proposes saving it' },
  { say: 'kabir', text: '@Meera how did you get Telegram updates working on localhost? my webhook never fires' },
  { settle: true },
  { say: 'meera', text: "@Kabir you don't need a webhook: long-poll getUpdates through swy exec, it works behind NAT. That's what I did" },
  { settle: true },
  { caption: 'An organizer approves with ✅: saved to Notion, helper credited' },
  { pause: 2500 },
  { approve: 'neha' },
  { settle: true },
]

const care: Beat[] = [
  { caption: 'A frustrated member: Pulse reads the mood, answers with empathy and brings in a human' },
  { say: 'rohan', text: 'SERIOUSLY?? swy exec just hangs forever when I call it from node. nothing works, 30 mins wasted' },
  { settle: true },
  { caption: 'Pulse follows Rohan until it is solved: the mood lifts and the case closes itself' },
  { pause: 2500 },
  { say: 'rohan', text: 'ok that was it, the async wrapper fixed it. works now 🙏 thanks' },
  { settle: true },
  { caption: 'A question aimed at someone else goes unanswered: the care sweep catches it' },
  { say: 'dev', text: '@Neha can you check if my Commudle submission link is saved? not sure it went through' },
  { settle: true },
  { pause: 2500 },
  { sweep: true },
  { settle: true },
]

const newcomers: Beat[] = [
  { caption: 'New members arrive and start asking' },
  { join: 'aarav' },
  { settle: true },
  { say: 'meera', text: 'what time is the submission deadline?' },
  { settle: true },
  { say: 'kabir', text: 'do we have to use the Vercel AI SDK or is LangGraph fine?' },
  { settle: true },
  { say: 'aarav', text: 'thanks!!' },
  { settle: true },
]

const announce: Beat[] = [
  { caption: 'The organizer asks the Console in plain English' },
  { console: 'Tonight’s online office hours with the Swytchcode team move to 8 PM. Tell everyone, pin it, and add it to the FAQ so Pulse answers correctly.' },
  { settle: true },
  { caption: 'Swytchcode dry-run previews wait for approval. Organizer approves' },
  { pause: 3000 },
  { approve: 'neha' },
  { settle: true },
]

const digest: Beat[] = [
  { caption: 'Pulse writes the organizers a digest and emails it via Resend' },
  { digest: true },
  { settle: true },
]

export const SCENARIOS: Scenario[] = [
  {
    id: 'full',
    title: 'Full demo',
    description: 'The 2.5-minute story: Pulse learns from an organizer, a member helps a member, a frustrated member is followed until sorted, and the organizer runs an announcement from the Console.',
    shows: ['Learning loop', 'Member → FAQ', 'Mood + care', 'Console + approvals'],
    beats: [...learn, ...helpers, ...care.slice(0, 7), ...announce],
  },
  { id: 'learn', title: 'Learns from organizers', description: 'Unknown question → #mods → organizer answers once → saved to Notion → the next member gets an instant answer.', shows: ['Slack #mods', 'Notion write', 'Instant repeat answer'], beats: learn },
  { id: 'helpers', title: 'Member helps member', description: 'A member answers another; Pulse proposes saving it; an organizer approves with ✅.', shows: ['Approval', 'Helper credit'], beats: helpers },
  { id: 'care', title: 'Care for members', description: 'Mood is read per message; a frustrated member gets empathy plus a human, and the case closes when they say it works. An ignored question is revived by the care sweep.', shows: ['Mood', 'Escalation', 'Case closed', 'Sweep'], beats: care },
  { id: 'newcomers', title: 'Newcomer rush', description: 'Welcomes, FAQ answers with Notion links, and knowing when to stay silent.', shows: ['Welcome', 'Answers', 'Silence'], beats: newcomers },
  { id: 'announce', title: 'Console announcement', description: 'Plain-English request → plan → Swytchcode dry-run previews → approval → posts, pin and FAQ update.', shows: ['Console', 'Dry-run', 'Approval'], beats: announce },
  { id: 'digest', title: 'Organizer digest', description: 'Stats → digest written by the agent → Resend email → archived in Notion.', shows: ['Resend', 'Notion'], beats: digest },
]
