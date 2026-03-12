import { useState, useEffect, useRef } from 'react'

// ====== Helpers ======
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pickN(arr, n) {
  return shuffle(arr).slice(0, n)
}

// ====== Data ======
const WORD_BANK = [
  ['Tigre', 'Pizza', 'Montagne', 'Clé', 'Dragon', 'Bateau'],
  ['Soleil', 'Livre', 'Guitare', 'Nuage', 'Requin', 'Jardin'],
  ['Vélo', 'Forêt', 'Lampe', 'Fusée', 'Château', 'Cactus'],
  ['Robot', 'Cascade', 'Tableau', 'Étoile', 'Pirate', 'Tambour'],
  ['Lune', 'Cerise', 'Flèche', 'Ballon', 'Serpent', 'Phare'],
]

const DECOY_WORDS = [
  'Parapluie', 'Fantôme', 'Miroir', 'Licorne', 'Champignon',
  'Volcan', 'Casque', 'Trampoline', 'Sorcière', 'Bouclier', 'Chouette', 'Tornade',
]

const EMOJI_BANK = [
  ['🍎', '⚽', '📚', '🚲', '🐱', '🌙'],
  ['🎸', '🚀', '🌊', '🦊', '🎯', '🍕'],
  ['🏰', '🐬', '🌈', '🎪', '🔮', '🦁'],
  ['🌺', '🎭', '🦋', '🏆', '🎲', '🌴'],
]

const EMOJI_INTRUDERS = [
  '🐘', '🌵', '🎺', '🛸', '🦈', '🎨', '🌋', '🦅', '🎃', '🧲', '🌠', '🦄',
]

const NUMBER_SEQS = ['4729183', '8264751', '3917482', '6148293', '2857634', '5093761']

const CALC_PROBLEMS = [
  { label: '18 + 7', answer: 25 },
  { label: '34 − 16', answer: 18 },
  { label: '25 + 13', answer: 38 },
  { label: '47 − 29', answer: 18 },
  { label: '56 + 28', answer: 84 },
  { label: '72 − 35', answer: 37 },
  { label: '63 + 19', answer: 82 },
  { label: '91 − 46', answer: 45 },
]

const IMAGE_SEQS = [
  ['🚗', '🏠', '🌳', '🐶', '⚽'],
  ['🦁', '🌊', '🎸', '🍎', '🏆'],
  ['🚀', '🌙', '⭐', '🎯', '🔑'],
  ['🐬', '🌺', '🎪', '🦋', '🎲'],
  ['🐉', '🍄', '🌈', '🐝', '🔮'],
]

// ====== Game definitions ======
export const GAME_DEFS = [
  {
    id: 'word-memory',
    title: 'Mémoire de Mots',
    emoji: '📝',
    description: 'Mémorise une liste de 6 mots',
    color: '#2d7cff',
    maxScore: 10,
  },
  {
    id: 'missing-object',
    title: 'Objet Disparu',
    emoji: '🔍',
    description: 'Un objet a disparu — lequel ?',
    color: '#f6a623',
    maxScore: 5,
  },
  {
    id: 'number-memory',
    title: 'Suite de Chiffres',
    emoji: '🔢',
    description: 'Mémorise la suite de 7 chiffres',
    color: '#7c4dff',
    maxScore: 10,
  },
  {
    id: 'image-order',
    title: 'Ordre des Images',
    emoji: '🔄',
    description: 'Dans quel ordre étaient les images ?',
    color: '#00bfa5',
    maxScore: 10,
  },
  {
    id: 'calc-memory',
    title: 'Calcul Mémoire',
    emoji: '⚡',
    description: 'Mémorise le calcul, trouve le résultat',
    color: '#e91e63',
    maxScore: 5,
  },
]

// ====== Countdown ======
function Countdown({ from, onDone }) {
  const [left, setLeft] = useState(from)
  const calledRef = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (left <= 0) {
      if (!calledRef.current) {
        calledRef.current = true
        onDoneRef.current()
      }
      return
    }
    const t = setTimeout(() => setLeft((l) => l - 1), 1000)
    return () => clearTimeout(t)
  }, [left])

  const r = 22
  const circ = 2 * Math.PI * r
  const dash = circ * (left / from)

  return (
    <div className="mc-countdown">
      <svg viewBox="0 0 56 56" className="mc-countdown-svg">
        <circle cx="28" cy="28" r={r} className="mc-countdown-bg" />
        <circle
          cx="28"
          cy="28"
          r={r}
          className="mc-countdown-ring"
          strokeDasharray={circ}
          strokeDashoffset={circ - dash}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <span className="mc-countdown-num">{left}</span>
    </div>
  )
}

// ====== Game 1: Word Memory ======
function WordMemoryGame({ onComplete }) {
  const [data] = useState(() => {
    const words = pick(WORD_BANK)
    const q2Pos = Math.floor(Math.random() * 6)
    const allOptions = shuffle([...words, ...pickN(DECOY_WORDS, 4)])
    const q2Options = shuffle([
      words[q2Pos],
      ...pickN(
        DECOY_WORDS.filter((w) => !words.includes(w)),
        3,
      ),
    ])
    return { words, q2Pos, allOptions, q2Options }
  })

  const [phase, setPhase] = useState('memorize')
  const [selected, setSelected] = useState([])
  const [q1Done, setQ1Done] = useState(false)
  const [q1Score, setQ1Score] = useState(0)
  const [q2Answer, setQ2Answer] = useState(null)

  function handleMemoDone() {
    setPhase('q1')
  }

  function toggleWord(w) {
    if (q1Done) return
    setSelected((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]))
  }

  function submitQ1() {
    let pts = 0
    data.words.forEach((w) => {
      if (selected.includes(w)) pts++
    })
    selected.forEach((w) => {
      if (!data.words.includes(w)) pts = Math.max(0, pts - 1)
    })
    setQ1Score(pts)
    setQ1Done(true)
    setTimeout(() => setPhase('q2'), 1800)
  }

  function submitQ2(ans) {
    setQ2Answer(ans)
    const isCorrect = ans === data.words[data.q2Pos]
    setTimeout(() => onComplete(q1Score + (isCorrect ? 4 : 0), 10), 1500)
  }

  const posLabels = ['1ʳᵉ', '2ᵉ', '3ᵉ', '4ᵉ', '5ᵉ', '6ᵉ']

  if (phase === 'memorize') {
    return (
      <div className="mc-phase">
        <Countdown from={20} onDone={handleMemoDone} />
        <h3>Mémorise cette liste !</h3>
        <p className="muted">Tu as 20 secondes</p>
        <ol className="mc-word-list">
          {data.words.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
      </div>
    )
  }

  if (phase === 'q1') {
    return (
      <div className="mc-phase">
        <h3>Quels mots étaient dans la liste ?</h3>
        <p className="muted">Sélectionne tous les mots que tu te rappelles</p>
        <div className="mc-word-grid">
          {data.allOptions.map((w, i) => {
            const isSel = selected.includes(w)
            const isInList = data.words.includes(w)
            const cls = [
              'mc-word-btn',
              isSel ? 'sel' : '',
              q1Done ? (isInList ? (isSel ? 'correct' : 'missed') : isSel ? 'wrong' : '') : '',
            ]
              .filter(Boolean)
              .join(' ')
            return (
              <button key={i} className={cls} onClick={() => toggleWord(w)} disabled={q1Done}>
                {w}
              </button>
            )
          })}
        </div>
        {!q1Done && (
          <button className="btn-primary mc-submit" onClick={submitQ1} disabled={selected.length === 0}>
            Valider ({selected.length} mot{selected.length > 1 ? 's' : ''})
          </button>
        )}
        {q1Done && <p className="mc-feedback positive">+{q1Score} pts — Prochaine question...</p>}
      </div>
    )
  }

  return (
    <div className="mc-phase">
      <p className="mc-qcount">Question bonus</p>
      <h3>
        Quel mot était en <em>{posLabels[data.q2Pos]}</em> position ?
      </h3>
      <div className="mc-choices">
        {data.q2Options.map((opt, i) => {
          const isSel = q2Answer === opt
          const isCorrect = opt === data.words[data.q2Pos]
          const show = q2Answer !== null
          return (
            <button
              key={i}
              className={`answer-btn mc-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
              onClick={() => !q2Answer && submitQ2(opt)}
              disabled={q2Answer !== null}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ====== Game 2: Missing Object ======
function MissingObjectGame({ onComplete }) {
  const [data] = useState(() => {
    const emojiList = pick(EMOJI_BANK)
    const removedIdx = Math.floor(Math.random() * 6)
    const removed = emojiList[removedIdx]
    const remaining = emojiList.filter((_, i) => i !== removedIdx)
    const choices = shuffle([removed, ...pickN(EMOJI_INTRUDERS, 3)])
    return { emojiList, removed, remaining, choices }
  })

  const [phase, setPhase] = useState('memorize')
  const [answer, setAnswer] = useState(null)

  function handleMemoDone() {
    setPhase('question')
  }

  function submitAnswer(e) {
    setAnswer(e)
    setTimeout(() => onComplete(e === data.removed ? 5 : 0, 5), 1500)
  }

  if (phase === 'memorize') {
    return (
      <div className="mc-phase">
        <Countdown from={10} onDone={handleMemoDone} />
        <h3>Mémorise ces objets !</h3>
        <p className="muted">Tu as 10 secondes</p>
        <div className="mc-emoji-row">
          {data.emojiList.map((e, i) => (
            <span key={i} className="mc-emoji">
              {e}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mc-phase">
      <h3>Quel objet a disparu ?</h3>
      <div className="mc-emoji-row">
        {data.remaining.map((e, i) => (
          <span key={i} className="mc-emoji">
            {e}
          </span>
        ))}
        <span className="mc-emoji mc-emoji-missing">?</span>
      </div>
      <div className="mc-choices">
        {data.choices.map((e, i) => {
          const isSel = answer === e
          const isCorrect = e === data.removed
          const show = answer !== null
          return (
            <button
              key={i}
              className={`answer-btn mc-choice mc-emoji-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
              onClick={() => !answer && submitAnswer(e)}
              disabled={answer !== null}
            >
              {e}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ====== Game 3: Number Memory ======
function NumberMemoryGame({ onComplete }) {
  const [data] = useState(() => {
    const seq = pick(NUMBER_SEQS)
    const decoys = new Set()
    let tries = 0
    while (decoys.size < 3 && tries < 200) {
      tries++
      const digits = seq.split('')
      const idx = Math.floor(Math.random() * digits.length)
      const mutated = digits
        .map((d, i) => (i === idx ? String((parseInt(d) + Math.floor(Math.random() * 4) + 1) % 10) : d))
        .join('')
      if (mutated !== seq) decoys.add(mutated)
    }
    return { seq, choices: shuffle([seq, ...Array.from(decoys)]) }
  })

  const [phase, setPhase] = useState('memorize')
  const [answer, setAnswer] = useState(null)

  function handleMemoDone() {
    setPhase('question')
  }

  function submitAnswer(a) {
    setAnswer(a)
    setTimeout(() => onComplete(a === data.seq ? 10 : 0, 10), 1500)
  }

  if (phase === 'memorize') {
    return (
      <div className="mc-phase">
        <Countdown from={15} onDone={handleMemoDone} />
        <h3>Mémorise cette suite !</h3>
        <p className="muted">Tu as 15 secondes</p>
        <div className="mc-digits">
          {data.seq.split('').map((d, i) => (
            <span key={i} className="mc-digit">
              {d}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mc-phase">
      <h3>Quelle était la suite de chiffres ?</h3>
      <div className="mc-choices mc-choices-col">
        {data.choices.map((c, i) => {
          const isSel = answer === c
          const isCorrect = c === data.seq
          const show = answer !== null
          return (
            <button
              key={i}
              className={`answer-btn mc-choice mc-number-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
              onClick={() => !answer && submitAnswer(c)}
              disabled={answer !== null}
            >
              {c.split('').join(' · ')}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ====== Game 4: Image Order ======
function ImageOrderGame({ onComplete }) {
  const [data] = useState(() => {
    const seq = pick(IMAGE_SEQS)
    const afterIdx = Math.floor(Math.random() * 4)
    const afterCorrect = seq[afterIdx + 1]
    const afterOthers = seq.filter((_, i) => i !== afterIdx + 1)
    const afterOptions = shuffle([afterCorrect, ...pickN(afterOthers, 3)])
    const firstCorrect = seq[0]
    const firstOptions = shuffle([firstCorrect, ...pickN(seq.slice(1), 3)])
    return { seq, afterIdx, afterCorrect, afterOptions, firstCorrect, firstOptions }
  })

  const [phase, setPhase] = useState('memorize')
  const [q1Answer, setQ1Answer] = useState(null)
  const [q2Answer, setQ2Answer] = useState(null)
  const [q1Score, setQ1Score] = useState(0)

  function handleMemoDone() {
    setPhase('q1')
  }

  function submitQ1(ans) {
    setQ1Answer(ans)
    const pts = ans === data.afterCorrect ? 5 : 0
    setQ1Score(pts)
    setTimeout(() => setPhase('q2'), 1500)
  }

  function submitQ2(ans) {
    setQ2Answer(ans)
    const isCorrect = ans === data.firstCorrect
    setTimeout(() => onComplete(q1Score + (isCorrect ? 5 : 0), 10), 1500)
  }

  if (phase === 'memorize') {
    return (
      <div className="mc-phase">
        <Countdown from={10} onDone={handleMemoDone} />
        <h3>Mémorise l'ordre !</h3>
        <p className="muted">Tu as 10 secondes</p>
        <div className="mc-seq-row">
          {data.seq.map((e, i) => (
            <span key={i} className="mc-seq-item">
              <span className="mc-seq-num">{i + 1}</span>
              <span className="mc-emoji">{e}</span>
            </span>
          ))}
        </div>
      </div>
    )
  }

  if (phase === 'q1') {
    return (
      <div className="mc-phase">
        <p className="mc-qcount">Question 1 / 2</p>
        <h3>
          Que vient <em>après</em> <span className="mc-big-emoji">{data.seq[data.afterIdx]}</span> ?
        </h3>
        <div className="mc-choices">
          {data.afterOptions.map((e, i) => {
            const isSel = q1Answer === e
            const isCorrect = e === data.afterCorrect
            const show = q1Answer !== null
            return (
              <button
                key={i}
                className={`answer-btn mc-choice mc-emoji-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
                onClick={() => !q1Answer && submitQ1(e)}
                disabled={q1Answer !== null}
              >
                {e}
              </button>
            )
          })}
        </div>
        {q1Answer !== null && (
          <p className={`mc-feedback ${q1Answer === data.afterCorrect ? 'positive' : 'negative'}`}>
            {q1Answer === data.afterCorrect ? '+5 pts !' : 'Raté...'}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="mc-phase">
      <p className="mc-qcount">Question 2 / 2</p>
      <h3>
        Quel était le <em>premier</em> objet ?
      </h3>
      <div className="mc-choices">
        {data.firstOptions.map((e, i) => {
          const isSel = q2Answer === e
          const isCorrect = e === data.firstCorrect
          const show = q2Answer !== null
          return (
            <button
              key={i}
              className={`answer-btn mc-choice mc-emoji-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
              onClick={() => !q2Answer && submitQ2(e)}
              disabled={q2Answer !== null}
            >
              {e}
            </button>
          )
        })}
      </div>
      {q2Answer !== null && (
        <p className={`mc-feedback ${q2Answer === data.firstCorrect ? 'positive' : 'negative'}`}>
          {q2Answer === data.firstCorrect ? '+5 pts !' : 'Raté...'}
        </p>
      )}
    </div>
  )
}

// ====== Game 5: Calc Memory ======
function CalcMemoryGame({ onComplete }) {
  const [data] = useState(() => {
    const problem = pick(CALC_PROBLEMS)
    const decoys = new Set()
    let tries = 0
    while (decoys.size < 3 && tries < 200) {
      tries++
      const offset = (Math.random() < 0.5 ? 1 : -1) * (Math.floor(Math.random() * 8) + 1)
      const d = problem.answer + offset
      if (d > 0 && d !== problem.answer) decoys.add(d)
    }
    return { problem, choices: shuffle([problem.answer, ...Array.from(decoys)]) }
  })

  const [phase, setPhase] = useState('memorize')
  const [answer, setAnswer] = useState(null)

  function handleMemoDone() {
    setPhase('question')
  }

  function submitAnswer(a) {
    setAnswer(a)
    setTimeout(() => onComplete(a === data.problem.answer ? 5 : 0, 5), 1500)
  }

  if (phase === 'memorize') {
    return (
      <div className="mc-phase">
        <Countdown from={8} onDone={handleMemoDone} />
        <h3>Mémorise ce calcul !</h3>
        <p className="muted">Tu as 8 secondes</p>
        <div className="mc-calc-display">{data.problem.label}</div>
      </div>
    )
  }

  return (
    <div className="mc-phase">
      <h3>Quel était le résultat ?</h3>
      <p className="muted">Le calcul a disparu — tu t'en souviens ?</p>
      <div className="mc-choices">
        {data.choices.map((c, i) => {
          const isSel = answer === c
          const isCorrect = c === data.problem.answer
          const show = answer !== null
          return (
            <button
              key={i}
              className={`answer-btn mc-choice ${show ? (isCorrect ? 'mc-correct' : isSel ? 'mc-wrong' : '') : ''}`}
              onClick={() => !answer && submitAnswer(c)}
              disabled={answer !== null}
            >
              {c}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ====== Components map ======
const GAME_COMPONENTS = {
  'word-memory': WordMemoryGame,
  'missing-object': MissingObjectGame,
  'number-memory': NumberMemoryGame,
  'image-order': ImageOrderGame,
  'calc-memory': CalcMemoryGame,
}

// ====== Game Result ======
function GameResult({ score, maxScore, gameTitle, onPlayAgain, onMenu }) {
  const pct = Math.round((score / maxScore) * 100)
  const stars = pct >= 80 ? 3 : pct >= 50 ? 2 : 1
  const msg =
    pct === 100
      ? 'Parfait ! 🎉'
      : pct >= 80
        ? 'Excellent !'
        : pct >= 50
          ? 'Bien joué !'
          : "Continue de t'entraîner !"

  return (
    <div className="mc-result">
      <div className="mc-stars">{'⭐'.repeat(stars)}</div>
      <h3>{gameTitle}</h3>
      <div className="mc-score-display">
        <span className="mc-score-num">{score}</span>
        <span className="mc-score-max">/ {maxScore}</span>
      </div>
      <p className="muted">{msg}</p>
      <div className="mc-result-actions">
        <button className="btn-primary" onClick={onPlayAgain}>
          Rejouer
        </button>
        <button className="btn-soft" onClick={onMenu}>
          Menu
        </button>
      </div>
    </div>
  )
}

// ====== Game Runner ======
function GameRunner({ gameId, onGameDone, onMenu }) {
  const [gameState, setGameState] = useState('playing')
  const [result, setResult] = useState(null)
  const [runKey, setRunKey] = useState(0)

  const gameDef = GAME_DEFS.find((g) => g.id === gameId)
  const GameComponent = GAME_COMPONENTS[gameId]

  function handleComplete(score, maxScore) {
    setResult({ score, maxScore })
    setGameState('result')
    onGameDone(score, maxScore)
  }

  function handlePlayAgain() {
    setResult(null)
    setGameState('playing')
    setRunKey((k) => k + 1)
  }

  return (
    <div className="mc-runner">
      <div className="mc-runner-header">
        <button className="btn-soft mc-back-btn" onClick={onMenu}>
          ← Retour
        </button>
        <span className="mc-runner-title">
          {gameDef?.emoji} {gameDef?.title}
        </span>
        <span className="mc-runner-max">/{gameDef?.maxScore} pts</span>
      </div>
      <div className="mc-runner-body">
        {gameState === 'playing' && <GameComponent key={runKey} onComplete={handleComplete} />}
        {gameState === 'result' && result && (
          <GameResult
            score={result.score}
            maxScore={result.maxScore}
            gameTitle={gameDef?.title}
            onPlayAgain={handlePlayAgain}
            onMenu={onMenu}
          />
        )}
      </div>
    </div>
  )
}

// ====== Main Memory Page ======
export function MemoryGame() {
  const [activeGame, setActiveGame] = useState(null)
  const [history, setHistory] = useState([])

  const totalScore = history.reduce((s, r) => s + r.score, 0)
  const totalMax = history.reduce((s, r) => s + r.maxScore, 0)

  function handleGameDone(gameId, score, maxScore) {
    setHistory((h) => [...h, { gameId, score, maxScore }])
  }

  if (activeGame) {
    return (
      <section className="panel mc-panel">
        <GameRunner
          gameId={activeGame}
          onGameDone={(score, maxScore) => handleGameDone(activeGame, score, maxScore)}
          onMenu={() => setActiveGame(null)}
        />
      </section>
    )
  }

  return (
    <section className="panel mc-panel">
      <div className="mc-header">
        <p className="eyebrow">BRAIN ARENA</p>
        <h2>Jeux de Mémoire</h2>
        <p className="muted">Entraîne ta mémoire, ta logique et ton attention — 10 min par jour</p>
      </div>

      {history.length > 0 && (
        <div className="mc-session-bar">
          <div>
            <strong>{history.length}</strong>
            <span> jeu{history.length > 1 ? 'x' : ''} joué{history.length > 1 ? 's' : ''}</span>
          </div>
          <div>
            <strong>{totalScore}</strong>
            <span> / {totalMax} pts</span>
          </div>
          <div>
            <strong>{totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0}%</strong>
            <span> de réussite</span>
          </div>
        </div>
      )}

      <div className="mc-game-grid">
        {GAME_DEFS.map((game) => {
          const played = history.filter((h) => h.gameId === game.id)
          const bestScore = played.length > 0 ? Math.max(...played.map((h) => h.score)) : null
          return (
            <button
              key={game.id}
              className="mc-game-card"
              style={{ '--gc': game.color }}
              onClick={() => setActiveGame(game.id)}
            >
              <span className="mc-card-emoji">{game.emoji}</span>
              <div className="mc-card-text">
                <strong>{game.title}</strong>
                <p>{game.description}</p>
                {bestScore !== null && (
                  <span className="mc-card-best" style={{ color: game.color }}>
                    Meilleur : {bestScore}/{game.maxScore}
                  </span>
                )}
              </div>
              <span
                className="mc-card-badge"
                style={{ background: game.color + '22', color: game.color }}
              >
                {game.maxScore} pts
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
