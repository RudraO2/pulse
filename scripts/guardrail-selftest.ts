// Runs the guardrail self-test against the real Swytchcode policy engine.
//   npm run selftest
import { prepareRuntimeDir } from '../src/swy/runtime-dir.js'
import { applyPolicies } from '../src/swy/policies.js'
import { runGuardrailSelfTest } from '../src/swy/selftest.js'
import { swyVersion } from '../src/swy/exec.js'

prepareRuntimeDir()
const { warnings } = await applyPolicies({ force: true })
console.log(`swytchcode ${await swyVersion()} — policies compiled${warnings.length ? ` (${warnings.length} warnings)` : ''}`)
for (const w of warnings) console.log(`  ${w}`)

const results = await runGuardrailSelfTest()
for (const r of results) {
  const mark = r.ok ? '✔' : '✘'
  console.log(`${mark} ${r.name.padEnd(48)} expect=${r.expect} got=${r.got}${r.policyId ? ` [${r.policyId}]` : ''}${r.ok ? '' : ` ${r.detail ?? ''}`}`)
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} guardrail check(s) FAILED` : `\nAll ${results.length} guardrail checks passed`)
process.exit(failed ? 1 : 0)
