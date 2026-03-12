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

function normalizeNumber(value, fallback, min = 0, max = 10000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function normalizeModeConfig(modeConfigOrTables) {
  if (Array.isArray(modeConfigOrTables)) {
    return {
      type: 'tables',
      tables: modeConfigOrTables.length > 0 ? modeConfigOrTables : [2, 3, 4, 5],
    }
  }

  const source = modeConfigOrTables || {}

  if (source.type === 'mixed') {
    const rawOperations = Array.isArray(source.operations) ? source.operations : ['mul', 'add']
    const operations = rawOperations.filter((operation) => operation === 'mul' || operation === 'add')
    const safeOperations = operations.length > 0 ? operations : ['mul']

    const mulMin = normalizeNumber(source.mulMin, 6, 1, 200)
    const mulMax = normalizeNumber(source.mulMax, 20, mulMin, 500)
    const addMin = normalizeNumber(source.addMin, 20, 0, 5000)
    const addMax = normalizeNumber(source.addMax, 200, addMin, 20000)

    return {
      type: 'mixed',
      operations: safeOperations,
      mulMin,
      mulMax,
      addMin,
      addMax,
    }
  }

  const tables = Array.isArray(source.tables) ? source.tables.filter((value) => Number.isInteger(value)) : []
  return {
    type: 'tables',
    tables: tables.length > 0 ? tables : [2, 3, 4, 5],
  }
}

function buildOptions(answer, rng) {
  const options = new Set([answer])
  const spread = Math.max(10, Math.round(Math.abs(answer) * 0.2))

  let guard = 0
  while (options.size < 4 && guard < 60) {
    guard += 1
    let delta = randomIntFromRng(-spread, spread, rng)
    if (delta === 0) {
      delta = randomIntFromRng(1, 9, rng)
    }

    const candidate = answer + delta
    if (candidate >= 0) {
      options.add(candidate)
    }
  }

  while (options.size < 4) {
    options.add(answer + options.size)
  }

  return Array.from(options).sort(() => rng() - 0.5)
}

function buildQuestionFromModeConfig(modeConfig, rng, idPrefix) {
  if (modeConfig.type === 'mixed') {
    const selectedOperation = modeConfig.operations[randomIntFromRng(0, modeConfig.operations.length - 1, rng)]

    if (selectedOperation === 'add') {
      const left = randomIntFromRng(modeConfig.addMin, modeConfig.addMax, rng)
      const right = randomIntFromRng(modeConfig.addMin, modeConfig.addMax, rng)
      const answer = left + right

      return {
        id: `${idPrefix}-${selectedOperation}-${left}-${right}`,
        left,
        right,
        operator: '+',
        label: `${left} + ${right}`,
        answer,
        options: buildOptions(answer, rng),
      }
    }

    const left = randomIntFromRng(modeConfig.mulMin, modeConfig.mulMax, rng)
    const right = randomIntFromRng(modeConfig.mulMin, modeConfig.mulMax, rng)
    const answer = left * right

    return {
      id: `${idPrefix}-${selectedOperation}-${left}-${right}`,
      left,
      right,
      operator: 'x',
      label: `${left} x ${right}`,
      answer,
      options: buildOptions(answer, rng),
    }
  }

  const left = modeConfig.tables[randomIntFromRng(0, modeConfig.tables.length - 1, rng)]
  const right = randomIntFromRng(1, 12, rng)
  const answer = left * right

  return {
    id: `${idPrefix}-mul-${left}-${right}`,
    left,
    right,
    operator: 'x',
    label: `${left} x ${right}`,
    answer,
    options: buildOptions(answer, rng),
  }
}

export function buildSeededQuestion(modeConfigOrTables, seed, index) {
  const modeConfig = normalizeModeConfig(modeConfigOrTables)
  const rng = mulberry32(seed + index * 3571)
  return buildQuestionFromModeConfig(modeConfig, rng, `${seed}-${index}`)
}

export function buildRandomQuestion(modeConfigOrTables) {
  const modeConfig = normalizeModeConfig(modeConfigOrTables)
  return buildQuestionFromModeConfig(modeConfig, Math.random, `${Date.now()}-${Math.random()}`)
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
    if ((second.score || 0) !== (first.score || 0)) {
      return (second.score || 0) - (first.score || 0)
    }

    const firstAccuracy = first.total > 0 ? first.correct / first.total : 0
    const secondAccuracy = second.total > 0 ? second.correct / second.total : 0
    if (secondAccuracy !== firstAccuracy) {
      return secondAccuracy - firstAccuracy
    }

    const firstWins = first.questionWins || 0
    const secondWins = second.questionWins || 0
    if (secondWins !== firstWins) {
      return secondWins - firstWins
    }

    const firstFinish = typeof first.finishedAtMs === 'number' ? first.finishedAtMs : Infinity
    const secondFinish = typeof second.finishedAtMs === 'number' ? second.finishedAtMs : Infinity
    return firstFinish - secondFinish
  })
}
