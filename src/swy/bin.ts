import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { env } from '../config/env.js'

// The npm postinstall on Windows deletes the .ps1 shims and the .cmd shims
// can't be spawned without a shell, so we always spawn the platform exe directly.

const exeName = process.platform === 'win32' ? 'swytchcode.exe' : 'swytchcode'
const pkgName = `swytchcode-cli-${process.platform}-${process.arch}`

let cached: string | undefined

function candidates(): string[] {
  const root = process.cwd()
  const out: string[] = []
  if (env.SWYTCHCODE_BIN) out.push(env.SWYTCHCODE_BIN)
  out.push(path.join(root, 'node_modules', 'swytchcode', 'node_modules', pkgName, 'bin', exeName))
  out.push(path.join(root, 'node_modules', pkgName, 'bin', exeName))

  // Any other platform package that happens to be installed (e.g. musl variants)
  for (const base of [path.join(root, 'node_modules', 'swytchcode', 'node_modules'), path.join(root, 'node_modules')]) {
    try {
      for (const d of readdirSync(base)) {
        if (d.startsWith('swytchcode-cli-')) out.push(path.join(base, d, 'bin', exeName))
      }
    } catch {
      /* dir missing */
    }
  }

  const globalRoot =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules')
      : '/usr/local/lib/node_modules'
  out.push(path.join(globalRoot, 'swytchcode', 'node_modules', pkgName, 'bin', exeName))
  return out
}

/** Absolute path to the swytchcode binary, or the bare name (resolved via PATH). */
export function swyBin(): string {
  if (cached) return cached
  cached = candidates().find((p) => p && existsSync(p)) ?? exeName
  return cached
}
