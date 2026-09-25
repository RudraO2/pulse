import type { LanguageModel } from 'ai'
import { env } from '../config/env.js'
import { buildModels, ModelChain, parseChain } from './llm.js'

// Three model chains, each with per-step fallback:
//   community: fast Groq first (sub-second steps), Claude Haiku last
//   console:   Claude Haiku 4.5 first (reliable multi-step tool use)
//   light:     cheapest/fastest for summaries

const keys = () => ({ google: env.GOOGLE_GENERATIVE_AI_API_KEY, groq: env.GROQ_API_KEY, anthropic: env.ANTHROPIC_API_KEY })

let community: ModelChain | undefined
let consoleChain: ModelChain | undefined
let light: ModelChain | undefined

function chain(name: string, spec: string): ModelChain | undefined {
  const models = buildModels(parseChain(spec, spec), keys())
  return models.length ? new ModelChain(name, models) : undefined
}

export function communityModel(): LanguageModel | undefined {
  return (community ??= chain('community', env.LLM_CHAIN))
}

export function consoleModel(): LanguageModel | undefined {
  return (consoleChain ??= chain('console', env.CONSOLE_CHAIN))
}

export function lightModel(): LanguageModel | undefined {
  return (light ??= chain('light', env.TRIAGE_CHAIN))
}

/** Tests only. */
export function resetModels(): void {
  community = consoleChain = light = undefined
}
