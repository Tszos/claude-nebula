import { expect, test } from 'claude-code/testing'

import { EMPTY, TTL_MS, WARN_BEFORE_MS, leftMinutes, levelColor, limitsOf, phaseFor, scene } from '../hooks/register'

test('pure helpers', async () => {
  expect(phaseFor(0, false, false)).toBe('unknown')
  expect(phaseFor(0, true, false)).toBe('busy')
  expect(phaseFor(10 * 60_000, false, true)).toBe('warm')
  expect(phaseFor(TTL_MS - WARN_BEFORE_MS, false, true)).toBe('expiring')
  expect(phaseFor(TTL_MS, false, true)).toBe('cold')
  expect(leftMinutes('warm', 19 * 60_000)).toBe(45)
  expect(leftMinutes('expiring', 57.5 * 60_000)).toBe(3)
  expect(leftMinutes('cold', TTL_MS)).toBe(null)
  expect(levelColor(10)).toBe('#4ade80')
  expect(levelColor(70)).toBe('#fbbf24')
  expect(levelColor(90)).toBe('#f87171')
  expect(limitsOf([{ kind: 'five_hour', percentUsed: 31.4 }, { kind: 'seven_day', percentUsed: 12 }])).toEqual({ shortLimit: 31, shortLabel: '5H', weekLimit: 12 })
  expect(limitsOf([{ kind: 'spend_limit', percentUsed: 80 }])).toEqual({ shortLimit: 80, shortLabel: 'SPEND', weekLimit: null })
})

test('the scene stays inside what the engine draws', async () => {
  const full = scene({ ctxPercent: 91, ctxTokens: 182_000, shortLimit: 31, shortLabel: '5H', weekLimit: 12, cache: 'expiring', cacheLeftMin: 3 })
  for (const svg of [scene(EMPTY), full]) {
    expect(svg.length < 131_072).toBe(true)
    expect(svg.includes('\\')).toBe(false)
    expect(svg.includes('&')).toBe(false)
    expect(svg.includes('href')).toBe(false)
    expect(svg.includes('<image')).toBe(false)
  }
  expect(full.includes('CONTEXT 91% · 182k')).toBe(true)
  expect(full.includes('5H 31% · 7D 12%')).toBe(true)
  expect(full.includes('CACHE ENDS IN 3 MIN')).toBe(true)
  expect(scene(EMPTY).includes('CONTEXT NO DATA')).toBe(true)
})
