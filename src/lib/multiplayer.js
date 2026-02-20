export const MULTIPLAYER_COLLECTION = 'tablequest_sessions'

const SESSION_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateSessionCode(length = 6) {
  let code = ''
  for (let index = 0; index < length; index += 1) {
    const charIndex = Math.floor(Math.random() * SESSION_CODE_CHARS.length)
    code += SESSION_CODE_CHARS[charIndex]
  }
  return code
}

function mulberry32(seed) {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomIntFromRng(min, max, rng) {
  return Math.floor(rng() * (max - min + 1)) + min
}

export function buildSeededQuestion(tables, seed, index) {
  const rng = mulberry32(seed + index * 3571)
  const safeTables = Array.isArray(tables) && tables.length > 0 ? tables : [2, 3, 4, 5]

  const a = safeTables[randomIntFromRng(0, safeTables.length - 1, rng)]
  const b = randomIntFromRng(1, 12, rng)
  const answer = a * b
  const options = new Set([answer])

  while (options.size < 4) {
    const spread = randomIntFromRng(-15, 15, rng)
    const candidate = answer + (spread === 0 ? 5 : spread)
    if (candidate > 0) {
      options.add(candidate)
    }
  }

  const shuffledOptions = Array.from(options).sort(() => rng() - 0.5)

  return {
    id: `${seed}-${index}-${a}-${b}`,
    a,
    b,
    answer,
    options: shuffledOptions,
  }
}

export function createSessionSeed() {
  return Math.floor(Math.random() * 1000000000)
}

export function normalizeSessionCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

export function sortPlayersByRank(playersMap) {
  const players = Object.values(playersMap || {})

  return players.sort((first, second) => {
    if (second.score !== first.score) {
      return second.score - first.score
    }

    const firstAccuracy = first.total > 0 ? first.correct / first.total : 0
    const secondAccuracy = second.total > 0 ? second.correct / second.total : 0
    if (secondAccuracy !== firstAccuracy) {
      return secondAccuracy - firstAccuracy
    }

    const firstFinish = typeof first.finishedAtMs === 'number' ? first.finishedAtMs : Infinity
    const secondFinish = typeof second.finishedAtMs === 'number' ? second.finishedAtMs : Infinity
    return firstFinish - secondFinish
  })
}
