import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, ThemeSetArgs } from 'claude-code'

import type { CachePhase, Sky } from '../types'
import { makeColors } from './make-colors.js'

// A space look for the desktop app. The palette and the backdrop are the theme; three objects in
// the sky are gauges, read at a glance and at zero tokens:
//   the star          = prompt cache (bright green warm, amber in the last five minutes, grey cold;
//                       twelve dots around it count the warm hour down in five-minute steps)
//   the planet        = context window (the ring fills with the window)
//   the ringed planet = usage limits (inner ring five-hour window, outer ring seven-day window)
// A ring is green under 60 %, amber under 85 %, red from there.
// The terminal draws no look, and a headless run starts no timer.

export const SCENE = 'nebula-sky'
// The cache lifetime is not visible from a mod: one hour fits a subscription. Change it for your plan.
export const TTL_MS = 60 * 60 * 1000
export const WARN_BEFORE_MS = 5 * 60 * 1000
export const TICK_MS = 30 * 1000

const { theme, problems } = makeColors({
  label: 'Nebula',
  only: 'dark',
  roles: { accent: '#3ddc97', danger: '#ff5d6c', success: '#5fd38a', warning: '#f0b429', pro: '#a78bfa' },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#070d10',
        'surface-1': '#0b1418',
        'surface-2': '#101b20',
        'surface-3': '#142228',
        'text-primary': '#e4f2ec',
        'text-secondary': '#b9cdc5',
        'text-muted': '#8fa69d',
      },
    },
  },
})

const LOOK: ThemeSetArgs = {
  colors: theme,
  backdrop: { scene: SCENE, glass: { blur: 6, tint: '#060c0f', opacity: 0.55 } },
}

export const EMPTY: Sky = {
  ctxPercent: null,
  ctxTokens: null,
  shortLimit: null,
  shortLabel: '5H',
  weekLimit: null,
  cache: 'unknown',
  cacheLeftMin: null,
}

const skyAtom = atom({ plugin: 'nebula', key: 'sky' } as const, EMPTY)

const live = {
  isOn: false,
  tick: undefined as { cancel: () => void } | undefined,
  lastRequestAt: null as number | null,
  isBusy: false,
  sky: EMPTY,
}

// ---------- pure helpers ----------

const GREEN = '#4ade80'
const AMBER = '#fbbf24'
const RED = '#f87171'
const DIM = '#5b6b78'

export function levelColor(percent: number | null): string {
  if (percent === null) return DIM
  if (percent < 60) return GREEN
  if (percent < 85) return AMBER
  return RED
}

export function fmtTokens(n: number | null): string {
  if (n === null) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export function phaseFor(idleMs: number, isBusy: boolean, hasRequest: boolean): CachePhase {
  if (isBusy) return 'busy'
  if (!hasRequest) return 'unknown'
  if (idleMs >= TTL_MS) return 'cold'
  if (idleMs >= TTL_MS - WARN_BEFORE_MS) return 'expiring'
  return 'warm'
}

// Minutes left, coarse on purpose: every change of this number redraws the scene.
export function leftMinutes(phase: CachePhase, idleMs: number): number | null {
  if (phase === 'busy') return 60
  if (phase === 'warm') return Math.ceil((TTL_MS - idleMs) / (5 * 60_000)) * 5
  if (phase === 'expiring') return Math.max(1, Math.ceil((TTL_MS - idleMs) / 60_000))
  return null
}

export function limitsOf(rateLimits: readonly SessionRateLimit[]): Pick<Sky, 'shortLimit' | 'shortLabel' | 'weekLimit'> {
  const find = (kind: string) => rateLimits.find(r => r.kind === kind)
  const five = find('five_hour')
  const spend = find('spend_limit')
  const week = find('seven_day')
  const short = five ?? spend
  return {
    shortLimit: short === undefined ? null : Math.round(short.percentUsed),
    shortLabel: five === undefined && spend !== undefined ? 'SPEND' : '5H',
    weekLimit: week === undefined ? null : Math.round(week.percentUsed),
  }
}

function isSame(a: Sky, b: Sky): boolean {
  return (
    a.ctxPercent === b.ctxPercent &&
    a.ctxTokens === b.ctxTokens &&
    a.shortLimit === b.shortLimit &&
    a.shortLabel === b.shortLabel &&
    a.weekLimit === b.weekLimit &&
    a.cache === b.cache &&
    a.cacheLeftMin === b.cacheLeftMin
  )
}

// ---------- the drawing ----------

// A fixed star field: the same seed draws the same sky on every redraw.
function starField(): string {
  let seed = 20261123
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  const tints = ['#ffffff', '#ffffff', '#ffffff', '#d7f5e6', '#cfe6ff', '#ffe9c7']
  const out: string[] = []
  for (let i = 0; i < 190; i++) {
    const x = (rnd() * 1600).toFixed(1)
    const y = (rnd() * 1000).toFixed(1)
    const big = rnd() < 0.12
    const r = (big ? 1.2 + rnd() * 0.9 : 0.4 + rnd() * 0.7).toFixed(2)
    const o = (big ? 0.75 + rnd() * 0.25 : 0.25 + rnd() * 0.5).toFixed(2)
    const tint = tints[Math.floor(rnd() * tints.length)] ?? '#ffffff'
    const twinkle = rnd() < 0.14 ? ` class="tw${1 + Math.floor(rnd() * 3)}"` : ''
    out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${tint}" opacity="${o}"${twinkle}/>`)
  }
  return out.join('')
}

const STARS = starField()

// Star-chart annotation: small italic text left of the body, with a short leader tick.
function label(x: number, y: number, text: string, color = '#9fb8ae'): string {
  return (
    `<line x1="${x + 4}" y1="${y - 3}" x2="${x + 12}" y2="${y - 3}" stroke="${color}" stroke-opacity="0.3" stroke-width="0.6"/>` +
    `<text x="${x}" y="${y}" text-anchor="end" font-family="serif" font-style="italic" font-size="10.5" letter-spacing="1.2" fill="${color}" fill-opacity="0.5">${text}</text>`
  )
}

type Tone = { hi: string; mid: string; lo: string; air: string }

export function toneFor(percent: number | null): Tone {
  if (percent !== null && percent >= 85) return { hi: '#ffc9b8', mid: '#b9503f', lo: '#4a1714', air: RED }
  if (percent !== null && percent >= 60) return { hi: '#ffe4ad', mid: '#b98432', lo: '#4d2e10', air: AMBER }
  return { hi: '#b4f2d6', mid: '#2b9478', lo: '#0c4038', air: '#5eead4' }
}

// The cache as a star: a white-green star while warm (it shrinks as the hour runs out), an
// orange giant in the last five minutes, a dim red dwarf once cold.
function cacheStar(sky: Sky, cx: number, cy: number): string {
  const text =
    sky.cache === 'busy' ? 'CACHE WARM'
    : sky.cache === 'warm' ? `CACHE WARM ${sky.cacheLeftMin} MIN`
    : sky.cache === 'expiring' ? `CACHE ENDS IN ${sky.cacheLeftMin} MIN`
    : sky.cache === 'cold' ? 'CACHE COLD'
    : 'CACHE NO DATA'
  if (sky.cache === 'cold' || sky.cache === 'unknown') {
    const c = sky.cache === 'cold' ? '#a8503a' : '#7d8f9c'
    return (
      `<circle cx="${cx}" cy="${cy}" r="16" fill="${c}" opacity="0.12" filter="url(#f-glow)"/>` +
      `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${c}" opacity="0.9"/>` +
      label(cx - 22, cy + 3, text, sky.cache === 'cold' ? '#d98b78' : undefined)
    )
  }
  const isEnding = sky.cache === 'expiring'
  const tint = isEnding ? '#ffb454' : '#9dffd0'
  const k = isEnding ? 0.8 : 0.6 + 0.4 * Math.min(1, (sky.cacheLeftMin ?? 60) / 60)
  const long = (62 * k).toFixed(1)
  const short = (20 * k).toFixed(1)
  const spike = (len: string, w: number) => `M ${-Number(len)} 0 Q 0 ${w} ${len} 0 Q 0 ${-w} ${-Number(len)} 0 Z`
  return (
    `<g transform="translate(${cx} ${cy})">` +
    `<circle class="glow" r="${(80 * k).toFixed(1)}" fill="url(#g-${isEnding ? 'amber' : 'star'})" opacity="0.55"/>` +
    `<circle r="${(16 * k).toFixed(1)}" fill="${tint}" opacity="0.55" filter="url(#f-glow)"/>` +
    `<g filter="url(#f-fine)" fill="${tint}">` +
    `<path d="${spike(long, 1.5)}" opacity="0.75"/>` +
    `<path d="${spike(long, 1.5)}" opacity="0.75" transform="rotate(90)"/>` +
    `<path d="${spike(short, 1)}" opacity="0.45" transform="rotate(45)"/>` +
    `<path d="${spike(short, 1)}" opacity="0.45" transform="rotate(-45)"/>` +
    `</g>` +
    `<circle r="${(4.2 * k).toFixed(1)}" fill="#ffffff"/>` +
    `</g>` +
    label(cx - 30 * k - 8, cy + 3, text, isEnding ? AMBER : undefined)
  )
}

// The context window as a planet lit by the cache star: the day side grows with the fill, from a
// thin crescent to a full disc, and the surface turns amber, then red, as the window runs out.
function contextPlanet(sky: Sky, cx: number, cy: number, lightDeg: number): string {
  const r = 44
  const tone = toneFor(sky.ctxPercent)
  const k = Math.min(0.99, Math.max(0.05, (sky.ctxPercent ?? 0) / 100))
  const rx = (r * Math.abs(1 - 2 * k)).toFixed(2)
  const lit = `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} A ${rx} ${r} 0 0 ${k > 0.5 ? 1 : 0} 0 ${-r} Z`
  const tokens = fmtTokens(sky.ctxTokens)
  const text = sky.ctxPercent === null ? 'CONTEXT NO DATA' : `CONTEXT ${sky.ctxPercent}%${tokens === '' ? '' : ` · ${tokens}`}`
  return (
    `<g transform="translate(${cx} ${cy})">` +
    `<circle r="${r + 5}" fill="none" stroke="${tone.air}" stroke-opacity="0.35" stroke-width="5" filter="url(#f-glow)"/>` +
    `<circle r="${r}" fill="#050f12"/>` +
    `<g clip-path="url(#c-planet)">` +
    `<g transform="rotate(${lightDeg})" filter="url(#f-fine)">` +
    `<radialGradient id="g-day" gradientUnits="userSpaceOnUse" cx="${r * 0.55}" cy="0" r="${r * 1.7}"><stop offset="0" stop-color="${tone.hi}"/><stop offset="0.45" stop-color="${tone.mid}"/><stop offset="1" stop-color="${tone.lo}"/></radialGradient>` +
    `<path d="${lit}" fill="url(#g-day)"/>` +
    `</g>` +
    `<g transform="rotate(-14)">` +
    `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" fill="#03110f" filter="url(#f-bands)" opacity="0.55"/>` +
    `<ellipse cx="-6" cy="-15" rx="40" ry="3.5" fill="#ffffff" opacity="0.05"/>` +
    `<ellipse cx="8" cy="12" rx="42" ry="5" fill="#000000" opacity="0.12"/>` +
    `</g>` +
    `<circle r="${r}" fill="url(#g-limb)"/>` +
    `</g>` +
    `</g>` +
    label(cx - r - 16, cy + 3, text, sky.ctxPercent !== null && sky.ctxPercent >= 85 ? '#f0a79c' : undefined)
  )
}

// The usage limits as a gas giant with two dust rings: the bright arc of the inner ring is the
// five-hour window, the bright arc of the outer ring is the seven-day window.
function limitsPlanet(sky: Sky, cx: number, cy: number): string {
  const r = 19
  const arc = (rx: number, ry: number, percent: number | null): string => {
    const dust = `<ellipse rx="${rx}" ry="${ry}" fill="none" stroke="#a9c9c0" stroke-opacity="0.16" stroke-width="3.4"/>` +
      `<ellipse rx="${rx}" ry="${ry}" fill="none" stroke="#d6ebe4" stroke-opacity="0.12" stroke-width="0.7"/>`
    if (percent === null || percent <= 0) return dust
    const p = Math.min(100, percent)
    const c = levelColor(percent)
    const lit = `rx="${rx}" ry="${ry}" fill="none" stroke="${c}" pathLength="100" stroke-dasharray="${p} 100"`
    return dust + `<ellipse ${lit} stroke-width="4" stroke-opacity="0.35" filter="url(#f-fine)"/>` + `<ellipse ${lit} stroke-width="1.6" stroke-opacity="0.7"/>`
  }
  const rings = arc(36, 9.5, sky.shortLimit) + arc(49, 13, sky.weekLimit)
  const parts: string[] = []
  if (sky.shortLimit !== null) parts.push(`${sky.shortLabel} ${sky.shortLimit}%`)
  if (sky.weekLimit !== null) parts.push(`7D ${sky.weekLimit}%`)
  const text = parts.length === 0 ? 'LIMITS NO DATA' : parts.join(' · ')
  const worst = Math.max(sky.shortLimit ?? 0, sky.weekLimit ?? 0)
  return (
    `<g transform="translate(${cx} ${cy}) rotate(-20)">` +
    rings +
    `<circle r="${r + 3}" fill="#7fb7c9" opacity="0.18" filter="url(#f-glow)"/>` +
    `<circle r="${r}" fill="url(#g-giant)"/>` +
    `<g clip-path="url(#c-giant)">` +
    `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}" fill="#06181f" filter="url(#f-bands)" opacity="0.6"/>` +
    `<circle r="${r}" fill="url(#g-limb-s)"/>` +
    `</g>` +
    `<g clip-path="url(#c-front)">${rings}</g>` +
    `</g>` +
    label(cx - 58, cy + 3, text, worst >= 85 ? '#f0a79c' : undefined)
  )
}

export function scene(sky: Sky): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">` +
    `<style>` +
    `.tw1{animation:tw 7s ease-in-out infinite}` +
    `.tw2{animation:tw 11s ease-in-out infinite 2s}` +
    `.tw3{animation:tw 17s ease-in-out infinite 5s}` +
    `.breath{animation:breath 90s ease-in-out infinite}` +
    `.glow{animation:glow 6s ease-in-out infinite}` +
    `@keyframes tw{50%{opacity:0.15}}` +
    `@keyframes breath{50%{opacity:0.2}}` +
    `@keyframes glow{50%{opacity:0.5}}` +
    `@media (max-aspect-ratio: 3/2){.gauges{transform:translate(-150px,0)}}` +
    `@media (max-aspect-ratio: 6/5){.gauges{transform:translate(-300px,0)}}` +
    `@media (max-aspect-ratio: 9/10){.gauges{transform:translate(-450px,0)}}` +
    `@media (max-aspect-ratio: 3/5){.gauges{transform:translate(-600px,0)}}` +
    `@media (min-aspect-ratio: 2/1){.gauges{transform:translate(0,70px)}}` +
    `</style>` +
    `<defs>` +
    `<radialGradient id="g-sky" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#0b171b"/><stop offset="1" stop-color="#03070a"/></radialGradient>` +
    `<radialGradient id="g-neb-a"><stop offset="0" stop-color="#3ddc97" stop-opacity="0.55"/><stop offset="0.55" stop-color="#1fae6b" stop-opacity="0.22"/><stop offset="1" stop-color="#1fae6b" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-neb-b"><stop offset="0" stop-color="#7dffb8" stop-opacity="0.4"/><stop offset="0.6" stop-color="#0f766e" stop-opacity="0.2"/><stop offset="1" stop-color="#0f766e" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-neb-c"><stop offset="0" stop-color="#14b8a6" stop-opacity="0.3"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-neb-d"><stop offset="0" stop-color="#6d4fc4" stop-opacity="0.2"/><stop offset="1" stop-color="#6d4fc4" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-star"><stop offset="0" stop-color="#7dffb8" stop-opacity="0.9"/><stop offset="0.4" stop-color="#3ddc97" stop-opacity="0.3"/><stop offset="1" stop-color="#3ddc97" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-amber"><stop offset="0" stop-color="#fde68a" stop-opacity="0.9"/><stop offset="0.4" stop-color="#fbbf24" stop-opacity="0.3"/><stop offset="1" stop-color="#fbbf24" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="g-giant" cx="45%" cy="18%" r="85%"><stop offset="0" stop-color="#a9d6df"/><stop offset="0.45" stop-color="#2f6b7d"/><stop offset="1" stop-color="#081c25"/></radialGradient>` +
    `<radialGradient id="g-limb" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="44"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/></radialGradient>` +
    `<radialGradient id="g-limb-s" cx="50%" cy="42%" r="52%"><stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.6"/></radialGradient>` +
    `<clipPath id="c-planet"><circle r="44"/></clipPath>` +
    `<clipPath id="c-giant"><circle r="19"/></clipPath>` +
    `<clipPath id="c-front"><rect x="-70" y="0" width="140" height="40"/></clipPath>` +
    `<filter id="f-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<filter id="f-fine" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.9"/></filter>` +
    `<filter id="f-bands" x="0" y="0" width="100%" height="100%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.014 0.11" numOctaves="3" seed="4" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  2.2 0 0 0 -0.75" result="m"/>` +
    `<feComposite in="SourceGraphic" in2="m" operator="in"/>` +
    `</filter>` +
    `<filter id="f-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="38"/></filter>` +
    `<filter id="f-cloud" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.0045 0.008" numOctaves="4" seed="11" result="n"/>` +
    `<feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.9 0 0 0 -0.55" result="m"/>` +
    `<feComposite in="SourceGraphic" in2="m" operator="in"/>` +
    `<feGaussianBlur stdDeviation="6"/>` +
    `</filter>` +
    `</defs>` +
    `<rect width="1600" height="1000" fill="url(#g-sky)"/>` +
    `<!-- nebula: a diagonal band, lower left to upper right -->` +
    `<g transform="rotate(-24 800 500)">` +
    `<g filter="url(#f-soft)">` +
    `<ellipse cx="520" cy="610" rx="520" ry="210" fill="url(#g-neb-c)"/>` +
    `<ellipse cx="1220" cy="430" rx="420" ry="200" fill="url(#g-neb-d)"/>` +
    `<ellipse class="breath" cx="900" cy="500" rx="560" ry="170" fill="url(#g-neb-b)" opacity="0.45"/>` +
    `</g>` +
    `<g filter="url(#f-cloud)">` +
    `<ellipse cx="700" cy="540" rx="640" ry="240" fill="url(#g-neb-a)"/>` +
    `<ellipse cx="1120" cy="470" rx="460" ry="190" fill="url(#g-neb-b)"/>` +
    `<ellipse cx="330" cy="640" rx="330" ry="150" fill="url(#g-neb-a)"/>` +
    `</g>` +
    `</g>` +
    `<!-- stars -->` +
    STARS +
    `<!-- gauges: cache star, context planet, limits planet -->` +
    `<g class="gauges">` +
    contextPlanet(sky, 1385, 345, -60) +
    limitsPlanet(sky, 1478, 535) +
    cacheStar(sky, 1488, 168) +
    `</g>` +
    `</svg>`
  )
}

export function altText(sky: Sky): string {
  const ctx = sky.ctxPercent === null ? 'no reading' : `${sky.ctxPercent} percent`
  const short = sky.shortLimit === null ? 'no reading' : `${sky.shortLimit} percent`
  const week = sky.weekLimit === null ? 'no reading' : `${sky.weekLimit} percent`
  return `A green nebula and stars. Prompt cache: ${sky.cache}. Context window: ${ctx}. Short usage limit: ${short}. Seven-day limit: ${week}.`
}

// ---------- the readings ----------

async function publish($: EngineInterface, patch: Partial<Sky>): Promise<void> {
  const nextSky = { ...live.sky, ...patch }
  if (isSame(nextSky, live.sky)) return
  live.sky = nextSky
  try { await update($, skyAtom, () => nextSky) } catch { /* no state host in some test bottoms */ }
}

async function readCache($: EngineInterface): Promise<void> {
  if (!live.isOn) return
  const now = await $.clock.now()
  const idleMs = live.lastRequestAt === null || live.isBusy ? 0 : now - live.lastRequestAt
  const cache = phaseFor(idleMs, live.isBusy, live.lastRequestAt !== null)
  await publish($, { cache, cacheLeftMin: leftMinutes(cache, idleMs) })
}

async function readUsage($: EngineInterface): Promise<void> {
  try {
    const u = await $.session.usage()
    await publish($, {
      ctxPercent: u.context.percent ?? null,
      ctxTokens: u.context.tokens ?? null,
      ...limitsOf(u.rateLimits),
    })
  } catch {
    // no usage host in some test bottoms; the last figures stand
  }
}

async function start($: EngineInterface): Promise<void> {
  // A reload keeps `$.state` and drops module variables: pick the last sky up again.
  try { live.sky = await read($, skyAtom) } catch { live.sky = EMPTY }
  await $.theme.set(LOOK)
  if (live.tick !== undefined) return
  live.isOn = true
  live.tick = $.clock.every(TICK_MS, () => { void readCache($) })
  await readUsage($)
  await readCache($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    live.tick?.cancel(); live.tick = undefined; live.isOn = false
    const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))
    if (unpainted !== undefined) $.ui.toast(unpainted)
    // Desktop reports isInteractive=false and attaches its client after this fires, so the look
    // also starts on `session.attach`. A plain `claude -p` run has no surface and stays silent.
    let surfaces: readonly string[] = []
    try { surfaces = await $.session.surfaces() } catch { surfaces = [] }
    if (e.isInteractive || surfaces.length > 0) await start($)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    await start($)
    return next(e)
  })

  // Context fill and rate-limit windows, pushed by the engine when one of them moves.
  on('session.measure', async ($, e, next) => {
    if (live.isOn) {
      await publish($, {
        ctxPercent: e.context.percent ?? null,
        ctxTokens: e.context.tokens ?? null,
        ...limitsOf(e.rateLimits),
      })
    }
    return next(e)
  })

  // Main loop only: a subagent's requests warm its own prefix, not the conversation's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && live.isOn) { live.isBusy = true; void readCache($) }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && live.isOn) {
      live.isBusy = false
      live.lastRequestAt = await $.clock.now()
      void readCache($)
    }
    return next(e)
  })

  on('ui.render', { component: 'Backdrop' }, async ($, e, next) => {
    if (e.props.scene !== SCENE || (e.surface !== 'desktop' && e.surface !== 'mobile')) return next(e)
    const { Svg } = $.ui.resolve(e)
    const sky = await read($, skyAtom)
    return <Svg source={scene(sky)} alt={altText(sky)} />
  })
}
