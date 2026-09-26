import fs from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

// Renders the phone app icons (PWA manifest, iOS home screen, notification badge)
// from the Pulse mark. Run once: npx tsx scripts/make-icons.ts

const mark = (stroke: string, width = 2.3) => `<path d="M2.5 12.5h4l2.5-6 4 12 2.8-8.5 1.7 2.5h4" stroke="${stroke}" stroke-width="${width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`

// "any": rounded tile; "maskable": full bleed with the mark inside the safe zone.
const tile = (size: number, maskable: boolean) => {
  const inset = maskable ? 0.22 : 0.16
  const s = 24 / (1 - inset * 2)
  const off = -inset * s
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${off} ${off} ${s} ${s}">
  <rect x="${off}" y="${off}" width="${s}" height="${s}" rx="${maskable ? 0 : s * 0.22}" fill="#12151b"/>
  ${mark('#ffffff')}
  <circle cx="21.5" cy="12.5" r="1.25" fill="#7b98ff"/>
</svg>`
}
// Android status-bar badge: white on transparent.
const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 24 24">${mark('#ffffff', 2.6)}</svg>`

const out = 'web/public/m'
fs.mkdirSync(out, { recursive: true })
const render = (svg: string, file: string, width: number) => fs.writeFileSync(`${out}/${file}`, new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng())
render(tile(192, false), 'icon-192.png', 192)
render(tile(512, false), 'icon-512.png', 512)
render(tile(512, true), 'icon-maskable-512.png', 512)
render(tile(180, true), 'apple-touch-icon.png', 180)
render(badge, 'badge-96.png', 96)
console.log('icons written to', out)
