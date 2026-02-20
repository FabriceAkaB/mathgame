import { useEffect, useMemo, useRef, useState } from 'react'
import { signInAnonymously } from 'firebase/auth'
import {
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import './App.css'
import { auth, db, isFirebaseConfigured } from './lib/firebase'
import {
  buildSeededQuestion,
  createSessionSeed,
  generateSessionCode,
  MULTIPLAYER_COLLECTION,
  normalizeSessionCode,
  sortPlayersByRank,
} from './lib/multiplayer'

const STORAGE_KEYS = {
  users: 'tablequest_users_v1',
  activeUser: 'tablequest_active_user_v1',
  devicePlayerId: 'tablequest_device_player_id_v1',
}

const GAME_MODES = [
  {
    id: 'warmup',
    title: 'Echauffement',
    subtitle: 'Tables 2 a 5',
    duration: 45,
    tables: [2, 3, 4, 5],
  },
  {
    id: 'focus7',
    title: 'Focus x7',
    subtitle: 'Table de 7',
    duration: 55,
    tables: [7],
  },
  {
    id: 'master',
    title: 'Mix Master',
    subtitle: 'Tables 2 a 12',
    duration: 60,
    tables: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  },
  {
    id: 'boss',
    title: 'Boss 9-12',
    subtitle: 'Pour les champions',
    duration: 75,
    tables: [9, 10, 11, 12],
  },
]

const DEFAULT_MODE = GAME_MODES[0]
const ANSWER_MODES = [
  {
    id: 'choices',
    title: 'Choix de reponses',
    subtitle: '4 propositions a toucher',
  },
  {
    id: 'input',
    title: 'Reponse ecrite',
    subtitle: 'Tu tapes la reponse toi-meme',
  },
]

function readUsersFromStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.users)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveUsersToStorage(users) {
  window.localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(users))
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickRandom(array) {
  return array[randomInt(0, array.length - 1)]
}

function buildQuestion(tables) {
  const a = pickRandom(tables)
  const b = randomInt(1, 12)
  const answer = a * b
  const options = new Set([answer])

  while (options.size < 4) {
    const spread = randomInt(-15, 15)
    const candidate = answer + (spread === 0 ? 5 : spread)
    if (candidate > 0) {
      options.add(candidate)
    }
  }

  const shuffled = Array.from(options).sort(() => Math.random() - 0.5)

  return {
    id: `${a}-${b}-${Math.random()}`,
    a,
    b,
    answer,
    options: shuffled,
  }
}

function initialUser(name) {
  return {
    id: name.toLowerCase(),
    name,
    bestScore: 0,
    bestStreak: 0,
    gamesPlayed: 0,
    totalCorrect: 0,
    totalAnswers: 0,
    stars: 0,
    lastPlayed: null,
  }
}

function getDevicePlayerId() {
  const saved = window.localStorage.getItem(STORAGE_KEYS.devicePlayerId)
  if (saved) {
    return saved
  }

  const generated =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `player-${Math.random().toString(36).slice(2, 12)}`

  window.localStorage.setItem(STORAGE_KEYS.devicePlayerId, generated)
  return generated
}

function getModeById(modeId) {
  return GAME_MODES.find((mode) => mode.id === modeId) || DEFAULT_MODE
}

function createLobbyPlayer(activeUser, devicePlayerId, previous = null) {
  const now = Date.now()
  return {
    uid: devicePlayerId,
    userId: activeUser.id,
    name: activeUser.name,
    score: previous?.score ?? 0,
    streak: previous?.streak ?? 0,
    bestStreak: previous?.bestStreak ?? 0,
    correct: previous?.correct ?? 0,
    total: previous?.total ?? 0,
    questionIndex: previous?.questionIndex ?? 0,
    joinedAtMs: previous?.joinedAtMs ?? now,
    lastUpdateMs: now,
    finishedAtMs: previous?.finishedAtMs ?? null,
    leftAtMs: null,
  }
}

function App() {
  const [users, setUsers] = useState(() => readUsersFromStorage())
  const [activeUserId, setActiveUserId] = useState(() => window.localStorage.getItem(STORAGE_KEYS.activeUser) || '')
  const [screen, setScreen] = useState(() => (window.localStorage.getItem(STORAGE_KEYS.activeUser) ? 'home' : 'login'))
  const [nameInput, setNameInput] = useState('')
  const [customTables, setCustomTables] = useState([2, 3, 4, 5])
  const [mode, setMode] = useState(DEFAULT_MODE)
  const [answerMode, setAnswerMode] = useState('choices')

  const [question, setQuestion] = useState(() => buildQuestion(DEFAULT_MODE.tables))
  const [timeLeft, setTimeLeft] = useState(DEFAULT_MODE.duration)
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [bestRoundStreak, setBestRoundStreak] = useState(0)
  const [correctAnswers, setCorrectAnswers] = useState(0)
  const [totalAnswers, setTotalAnswers] = useState(0)
  const [locked, setLocked] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [selectedAnswer, setSelectedAnswer] = useState(null)
  const [inputAnswer, setInputAnswer] = useState('')
  const [starsEarned, setStarsEarned] = useState(0)

  const [multiModeId, setMultiModeId] = useState(DEFAULT_MODE.id)
  const [joinCodeInput, setJoinCodeInput] = useState('')
  const [multiSessionId, setMultiSessionId] = useState('')
  const [multiSession, setMultiSession] = useState(null)
  const [multiStatusMessage, setMultiStatusMessage] = useState('')
  const [multiBusy, setMultiBusy] = useState(false)
  const [multiStartedKey, setMultiStartedKey] = useState('')

  const [multiQuestionIndex, setMultiQuestionIndex] = useState(0)
  const [multiQuestion, setMultiQuestion] = useState(null)
  const [multiTimeLeft, setMultiTimeLeft] = useState(0)
  const [multiStartsIn, setMultiStartsIn] = useState(0)
  const [multiScore, setMultiScore] = useState(0)
  const [multiStreak, setMultiStreak] = useState(0)
  const [multiBestStreak, setMultiBestStreak] = useState(0)
  const [multiCorrect, setMultiCorrect] = useState(0)
  const [multiTotal, setMultiTotal] = useState(0)
  const [multiLocked, setMultiLocked] = useState(false)
  const [multiFeedback, setMultiFeedback] = useState(null)
  const [multiSelectedAnswer, setMultiSelectedAnswer] = useState(null)
  const [multiInputAnswer, setMultiInputAnswer] = useState('')
  const [multiFinalRankings, setMultiFinalRankings] = useState([])

  const nextQuestionTimeoutRef = useRef(null)
  const answerInputRef = useRef(null)

  const multiNextQuestionTimeoutRef = useRef(null)
  const multiInputRef = useRef(null)
  const multiFinishedRef = useRef(false)

  const activeUser = useMemo(
    () => users.find((user) => user.id === activeUserId) || null,
    [users, activeUserId],
  )

  const devicePlayerId = useMemo(() => getDevicePlayerId(), [])

  const leaderboard = useMemo(
    () => [...users].sort((a, b) => b.bestScore - a.bestScore || b.stars - a.stars).slice(0, 5),
    [users],
  )

  const currentMultiMode = useMemo(() => getModeById(multiModeId), [multiModeId])

  const isHost = multiSession?.hostUid === devicePlayerId

  const multiplayerEnabled = isFirebaseConfigured

  const multiplayerAnswerMode = multiSession?.answerMode || answerMode

  const multiRankings = useMemo(() => {
    const players = { ...(multiSession?.players || {}) }

    if (screen === 'multiplayerPlaying' && activeUser) {
      players[devicePlayerId] = {
        ...(players[devicePlayerId] || {}),
        uid: devicePlayerId,
        name: activeUser.name,
        score: multiScore,
        streak: multiStreak,
        bestStreak: multiBestStreak,
        correct: multiCorrect,
        total: multiTotal,
        questionIndex: multiQuestionIndex,
        finishedAtMs: multiFinishedRef.current ? Date.now() : null,
      }
    }

    return sortPlayersByRank(players)
  }, [
    multiSession,
    screen,
    activeUser,
    devicePlayerId,
    multiScore,
    multiStreak,
    multiBestStreak,
    multiCorrect,
    multiTotal,
    multiQuestionIndex,
  ])

  const myMultiRank = useMemo(
    () => multiRankings.findIndex((player) => player.uid === devicePlayerId) + 1,
    [multiRankings, devicePlayerId],
  )

  useEffect(() => {
    if (!activeUserId) {
      setScreen('login')
    }
  }, [activeUserId])

  useEffect(() => {
    if (screen !== 'playing') {
      return undefined
    }

    if (timeLeft <= 0) {
      return undefined
    }

    const timer = window.setInterval(() => {
      setTimeLeft((previous) => Math.max(previous - 1, 0))
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [screen, timeLeft])

  useEffect(() => {
    if (screen === 'playing' && timeLeft === 0) {
      finishRound()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft, screen])

  useEffect(() => {
    if (screen === 'playing' && answerMode === 'input' && !locked) {
      answerInputRef.current?.focus()
    }
  }, [screen, answerMode, locked, question.id])

  useEffect(() => {
    if (screen === 'multiplayerPlaying' && multiplayerAnswerMode === 'input' && !multiLocked && multiStartsIn === 0) {
      multiInputRef.current?.focus()
    }
  }, [screen, multiplayerAnswerMode, multiLocked, multiStartsIn, multiQuestion?.id])

  useEffect(() => {
    return () => {
      if (nextQuestionTimeoutRef.current) {
        window.clearTimeout(nextQuestionTimeoutRef.current)
      }

      if (multiNextQuestionTimeoutRef.current) {
        window.clearTimeout(multiNextQuestionTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!multiplayerEnabled || !auth) {
      return
    }

    signInAnonymously(auth).catch(() => {
      setMultiStatusMessage('Connexion multi impossible. Verifie la config Firebase.')
    })
  }, [multiplayerEnabled])

  useEffect(() => {
    if (!multiSessionId || !multiplayerEnabled || !db) {
      return undefined
    }

    const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

    const unsubscribe = onSnapshot(
      sessionRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setMultiStatusMessage('Cette session n existe plus.')
          setMultiSession(null)
          setMultiSessionId('')
          setScreen('home')
          return
        }

        const data = snapshot.data()
        const sessionData = {
          id: snapshot.id,
          ...data,
          players: data.players || {},
        }

        setMultiSession(sessionData)

        if (sessionData.status === 'lobby') {
          if (screen !== 'multiplayerLobby') {
            setScreen('multiplayerLobby')
          }
          return
        }

        if (sessionData.status === 'playing') {
          const sessionRunKey = `${sessionData.id}-${sessionData.startAtMs}-${sessionData.seed}`

          if (multiStartedKey !== sessionRunKey) {
            const myData = sessionData.players?.[devicePlayerId]
            const restoredIndex = Number.isInteger(myData?.questionIndex) ? myData.questionIndex : 0

            setAnswerMode(sessionData.answerMode || 'choices')
            setMultiQuestionIndex(restoredIndex)
            setMultiQuestion(buildSeededQuestion(sessionData.tables, sessionData.seed, restoredIndex))
            setMultiScore(myData?.score ?? 0)
            setMultiStreak(myData?.streak ?? 0)
            setMultiBestStreak(myData?.bestStreak ?? 0)
            setMultiCorrect(myData?.correct ?? 0)
            setMultiTotal(myData?.total ?? 0)
            setMultiFeedback(null)
            setMultiLocked(false)
            setMultiSelectedAnswer(null)
            setMultiInputAnswer('')
            setMultiFinalRankings([])
            setMultiStartedKey(sessionRunKey)
            multiFinishedRef.current = Boolean(myData?.finishedAtMs)
          }

          if (screen !== 'multiplayerPlaying') {
            setScreen('multiplayerPlaying')
          }

          return
        }

        if (sessionData.status === 'finished') {
          setMultiFinalRankings(sortPlayersByRank(sessionData.players || {}))
          setScreen('multiplayerResult')
          multiFinishedRef.current = true
        }
      },
      () => {
        setMultiStatusMessage('Erreur reseau sur la session multi.')
      },
    )

    return () => {
      unsubscribe()
    }
  }, [multiSessionId, multiplayerEnabled, screen, multiStartedKey, devicePlayerId])

  useEffect(() => {
    if (screen !== 'multiplayerPlaying' || !multiSession || multiSession.status !== 'playing') {
      return undefined
    }

    const tick = () => {
      const now = Date.now()
      const startsIn = Math.max(0, Math.ceil((multiSession.startAtMs - now) / 1000))
      setMultiStartsIn(startsIn)

      if (startsIn > 0) {
        setMultiTimeLeft(multiSession.duration)
        return
      }

      const remaining = Math.max(0, Math.ceil((multiSession.endAtMs - now) / 1000))
      setMultiTimeLeft(remaining)

      if (remaining === 0 && !multiFinishedRef.current) {
        finishMultiplayerRace(true)
      }
    }

    tick()
    const timer = window.setInterval(tick, 250)

    return () => {
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, multiSession?.status, multiSession?.startAtMs, multiSession?.endAtMs, multiSession?.duration])

  function applyProgressToActiveUser(scoreValue, streakValue, correctValue, totalValue, starsValue) {
    if (!activeUserId) {
      return
    }

    setUsers((previousUsers) => {
      const updatedUsers = previousUsers.map((user) => {
        if (user.id !== activeUserId) {
          return user
        }

        return {
          ...user,
          bestScore: Math.max(user.bestScore, scoreValue),
          bestStreak: Math.max(user.bestStreak, streakValue),
          gamesPlayed: user.gamesPlayed + 1,
          totalCorrect: user.totalCorrect + correctValue,
          totalAnswers: user.totalAnswers + totalValue,
          stars: user.stars + starsValue,
          lastPlayed: new Date().toISOString(),
        }
      })

      saveUsersToStorage(updatedUsers)
      return updatedUsers
    })
  }

  function handleLogin(event) {
    event.preventDefault()
    const cleanName = nameInput.trim().replace(/\s+/g, ' ').slice(0, 18)
    if (!cleanName) {
      return
    }

    const existing = users.find((user) => user.id === cleanName.toLowerCase())
    const user = existing || initialUser(cleanName)

    if (!existing) {
      const nextUsers = [user, ...users]
      setUsers(nextUsers)
      saveUsersToStorage(nextUsers)
    }

    setActiveUserId(user.id)
    window.localStorage.setItem(STORAGE_KEYS.activeUser, user.id)
    setNameInput('')
    setScreen('home')
  }

  function logout() {
    setActiveUserId('')
    window.localStorage.removeItem(STORAGE_KEYS.activeUser)
    setScreen('login')
  }

  function startRound(selectedMode) {
    if (nextQuestionTimeoutRef.current) {
      window.clearTimeout(nextQuestionTimeoutRef.current)
    }

    setMode(selectedMode)
    setQuestion(buildQuestion(selectedMode.tables))
    setTimeLeft(selectedMode.duration)
    setScore(0)
    setStreak(0)
    setBestRoundStreak(0)
    setCorrectAnswers(0)
    setTotalAnswers(0)
    setLocked(false)
    setFeedback(null)
    setSelectedAnswer(null)
    setInputAnswer('')
    setStarsEarned(0)
    setScreen('playing')
  }

  function finishRound() {
    if (screen !== 'playing' || !activeUser) {
      return
    }

    if (nextQuestionTimeoutRef.current) {
      window.clearTimeout(nextQuestionTimeoutRef.current)
    }

    const accuracy = totalAnswers === 0 ? 0 : correctAnswers / totalAnswers
    const earned = Math.max(1, Math.round(score / 20 + accuracy * 4))
    setStarsEarned(earned)

    applyProgressToActiveUser(score, bestRoundStreak, correctAnswers, totalAnswers, earned)
    setScreen('result')
  }

  function answerQuestion(selectedValue) {
    if (locked || screen !== 'playing') {
      return
    }

    setLocked(true)
    setSelectedAnswer(selectedValue)
    setTotalAnswers((previous) => previous + 1)

    if (selectedValue === question.answer) {
      const nextStreak = streak + 1
      const gain = 10 + Math.min(streak * 2, 20)

      setScore((previous) => previous + gain)
      setStreak(nextStreak)
      setBestRoundStreak((previous) => Math.max(previous, nextStreak))
      setCorrectAnswers((previous) => previous + 1)
      setFeedback({
        type: 'success',
        title: 'Excellent!',
        detail: `+${gain} points`,
      })
    } else {
      setStreak(0)
      setFeedback({
        type: 'error',
        title: 'Pas cette fois',
        detail: `${question.a} x ${question.b}`,
        correctAnswer: question.answer,
      })
    }

    nextQuestionTimeoutRef.current = window.setTimeout(() => {
      setQuestion(buildQuestion(mode.tables))
      setLocked(false)
      setFeedback(null)
      setSelectedAnswer(null)
      setInputAnswer('')
    }, 1000)
  }

  function handleInputSubmit(event) {
    event.preventDefault()
    if (inputAnswer.trim() === '') {
      return
    }

    const parsed = Number(inputAnswer)
    if (!Number.isFinite(parsed)) {
      return
    }

    answerQuestion(parsed)
  }

  function toggleCustomTable(table) {
    setCustomTables((previous) => {
      if (previous.includes(table)) {
        if (previous.length === 1) {
          return previous
        }

        return previous.filter((value) => value !== table)
      }

      return [...previous, table].sort((a, b) => a - b)
    })
  }

  function startCustomMode() {
    startRound({
      id: 'custom',
      title: 'Mode Perso',
      subtitle: `Tables ${customTables.join(', ')}`,
      duration: 60,
      tables: customTables,
    })
  }

  async function createMultiplayerSession() {
    if (!activeUser) {
      return
    }

    if (!multiplayerEnabled || !db) {
      setMultiStatusMessage('Active Firebase pour le mode multi.')
      return
    }

    setMultiBusy(true)
    setMultiStatusMessage('')

    try {
      let sessionCode = ''
      let created = false

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidateCode = generateSessionCode(6)
        const candidateRef = doc(db, MULTIPLAYER_COLLECTION, candidateCode)
        const existing = await getDoc(candidateRef)

        if (existing.exists()) {
          continue
        }

        const selectedMode = getModeById(multiModeId)
        await setDoc(candidateRef, {
          status: 'lobby',
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          hostUid: devicePlayerId,
          hostName: activeUser.name,
          modeId: selectedMode.id,
          modeTitle: selectedMode.title,
          tables: selectedMode.tables,
          duration: selectedMode.duration,
          answerMode,
          seed: createSessionSeed(),
          startAtMs: null,
          endAtMs: null,
          players: {
            [devicePlayerId]: createLobbyPlayer(activeUser, devicePlayerId),
          },
        })

        sessionCode = candidateCode
        created = true
        break
      }

      if (!created) {
        throw new Error('Impossible de creer une session. Reessaie.')
      }

      setJoinCodeInput(sessionCode)
      setMultiSessionId(sessionCode)
      setMultiStartedKey('')
      setScreen('multiplayerLobby')
    } catch {
      setMultiStatusMessage('Creation de session impossible pour le moment.')
    } finally {
      setMultiBusy(false)
    }
  }

  async function joinMultiplayerSession() {
    if (!activeUser) {
      return
    }

    if (!multiplayerEnabled || !db) {
      setMultiStatusMessage('Active Firebase pour rejoindre une session.')
      return
    }

    const normalizedCode = normalizeSessionCode(joinCodeInput)
    setJoinCodeInput(normalizedCode)

    if (normalizedCode.length !== 6) {
      setMultiStatusMessage('Code invalide. Il faut 6 caracteres.')
      return
    }

    setMultiBusy(true)
    setMultiStatusMessage('')

    try {
      const sessionRef = doc(db, MULTIPLAYER_COLLECTION, normalizedCode)
      const snapshot = await getDoc(sessionRef)

      if (!snapshot.exists()) {
        throw new Error('Session introuvable')
      }

      const data = snapshot.data()
      const existingPlayer = data.players?.[devicePlayerId] || null

      if (data.status === 'finished') {
        throw new Error('Session terminee')
      }

      if (data.status === 'playing' && !existingPlayer) {
        throw new Error('Partie deja lancee')
      }

      const nextPlayer = createLobbyPlayer(activeUser, devicePlayerId, existingPlayer)

      await updateDoc(sessionRef, {
        [`players.${devicePlayerId}`]: nextPlayer,
      })

      setMultiSessionId(normalizedCode)
      setMultiStartedKey('')
      setScreen(data.status === 'playing' ? 'multiplayerPlaying' : 'multiplayerLobby')
    } catch (error) {
      if (error instanceof Error && error.message === 'Partie deja lancee') {
        setMultiStatusMessage('Cette course a deja commence. Demande un nouveau code.')
      } else if (error instanceof Error && error.message === 'Session terminee') {
        setMultiStatusMessage('Cette session est deja terminee.')
      } else {
        setMultiStatusMessage('Impossible de rejoindre cette session.')
      }
    } finally {
      setMultiBusy(false)
    }
  }

  async function startMultiplayerRace() {
    if (!multiplayerEnabled || !db || !multiSession || !multiSessionId || !isHost) {
      return
    }

    const players = multiSession.players || {}
    const playerIds = Object.keys(players)

    if (playerIds.length < 2) {
      setMultiStatusMessage('Ajoute au moins 2 joueurs pour lancer la course.')
      return
    }

    const now = Date.now()
    const startAtMs = now + 4000
    const endAtMs = startAtMs + multiSession.duration * 1000

    const resetPayload = {
      status: 'playing',
      seed: createSessionSeed(),
      startAtMs,
      endAtMs,
      finishedAtMs: null,
    }

    playerIds.forEach((playerId) => {
      resetPayload[`players.${playerId}.score`] = 0
      resetPayload[`players.${playerId}.streak`] = 0
      resetPayload[`players.${playerId}.bestStreak`] = 0
      resetPayload[`players.${playerId}.correct`] = 0
      resetPayload[`players.${playerId}.total`] = 0
      resetPayload[`players.${playerId}.questionIndex`] = 0
      resetPayload[`players.${playerId}.finishedAtMs`] = null
      resetPayload[`players.${playerId}.leftAtMs`] = null
      resetPayload[`players.${playerId}.lastUpdateMs`] = now
    })

    setMultiStatusMessage('Top depart dans 4 secondes...')

    try {
      await updateDoc(doc(db, MULTIPLAYER_COLLECTION, multiSessionId), resetPayload)
    } catch {
      setMultiStatusMessage('Impossible de lancer la course.')
    }
  }

  function resetMultiplayerLocalState() {
    if (multiNextQuestionTimeoutRef.current) {
      window.clearTimeout(multiNextQuestionTimeoutRef.current)
    }

    setMultiSessionId('')
    setMultiSession(null)
    setJoinCodeInput('')
    setMultiBusy(false)
    setMultiStartedKey('')
    setMultiQuestionIndex(0)
    setMultiQuestion(null)
    setMultiTimeLeft(0)
    setMultiStartsIn(0)
    setMultiScore(0)
    setMultiStreak(0)
    setMultiBestStreak(0)
    setMultiCorrect(0)
    setMultiTotal(0)
    setMultiLocked(false)
    setMultiFeedback(null)
    setMultiSelectedAnswer(null)
    setMultiInputAnswer('')
    setMultiFinalRankings([])
    multiFinishedRef.current = false
  }

  async function leaveMultiplayerSession() {
    const sessionToLeave = multiSession

    if (multiplayerEnabled && db && sessionToLeave && multiSessionId) {
      const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

      try {
        if (sessionToLeave.status === 'lobby') {
          const others = Object.values(sessionToLeave.players || {}).filter((player) => player.uid !== devicePlayerId)

          if (others.length === 0) {
            await deleteDoc(sessionRef)
          } else {
            const payload = {
              [`players.${devicePlayerId}`]: deleteField(),
            }

            if (sessionToLeave.hostUid === devicePlayerId) {
              payload.hostUid = others[0].uid
              payload.hostName = others[0].name
            }

            await updateDoc(sessionRef, payload)
          }
        } else {
          await updateDoc(sessionRef, {
            [`players.${devicePlayerId}.leftAtMs`]: Date.now(),
            [`players.${devicePlayerId}.lastUpdateMs`]: Date.now(),
          })
        }
      } catch {
        // Keep local UX responsive even if network update fails.
      }
    }

    resetMultiplayerLocalState()
    setScreen('home')
  }

  function persistMultiplayerProgress(nextValues) {
    if (!multiplayerEnabled || !db || !multiSessionId || !activeUser) {
      return
    }

    const basePath = `players.${devicePlayerId}`
    const payload = {
      [`${basePath}.uid`]: devicePlayerId,
      [`${basePath}.userId`]: activeUser.id,
      [`${basePath}.name`]: activeUser.name,
      [`${basePath}.score`]: nextValues.score,
      [`${basePath}.streak`]: nextValues.streak,
      [`${basePath}.bestStreak`]: nextValues.bestStreak,
      [`${basePath}.correct`]: nextValues.correct,
      [`${basePath}.total`]: nextValues.total,
      [`${basePath}.questionIndex`]: nextValues.questionIndex,
      [`${basePath}.lastUpdateMs`]: Date.now(),
    }

    if (Object.prototype.hasOwnProperty.call(nextValues, 'finishedAtMs')) {
      payload[`${basePath}.finishedAtMs`] = nextValues.finishedAtMs
    }

    updateDoc(doc(db, MULTIPLAYER_COLLECTION, multiSessionId), payload).catch(() => {
      setMultiStatusMessage('Connexion instable: les points se synchronisent mal.')
    })
  }

  function answerMultiplayerQuestion(selectedValue) {
    if (
      multiLocked ||
      screen !== 'multiplayerPlaying' ||
      !multiQuestion ||
      !multiSession ||
      multiStartsIn > 0 ||
      multiFinishedRef.current
    ) {
      return
    }

    setMultiLocked(true)
    setMultiSelectedAnswer(selectedValue)

    const nextTotal = multiTotal + 1
    let nextScore = multiScore
    let nextStreak = multiStreak
    let nextBestStreak = multiBestStreak
    let nextCorrect = multiCorrect

    if (selectedValue === multiQuestion.answer) {
      const gain = 10 + Math.min(multiStreak * 2, 20)
      nextScore += gain
      nextStreak += 1
      nextBestStreak = Math.max(nextBestStreak, nextStreak)
      nextCorrect += 1

      setMultiFeedback({
        type: 'success',
        title: 'Top vitesse!',
        detail: `+${gain} points`,
      })
    } else {
      nextStreak = 0
      setMultiFeedback({
        type: 'error',
        title: 'Mauvais calcul',
        detail: `${multiQuestion.a} x ${multiQuestion.b}`,
        correctAnswer: multiQuestion.answer,
      })
    }

    const nextQuestionIndex = multiQuestionIndex + 1

    setMultiTotal(nextTotal)
    setMultiScore(nextScore)
    setMultiStreak(nextStreak)
    setMultiBestStreak(nextBestStreak)
    setMultiCorrect(nextCorrect)

    persistMultiplayerProgress({
      score: nextScore,
      streak: nextStreak,
      bestStreak: nextBestStreak,
      correct: nextCorrect,
      total: nextTotal,
      questionIndex: nextQuestionIndex,
    })

    multiNextQuestionTimeoutRef.current = window.setTimeout(() => {
      setMultiQuestionIndex(nextQuestionIndex)
      setMultiQuestion(buildSeededQuestion(multiSession.tables, multiSession.seed, nextQuestionIndex))
      setMultiLocked(false)
      setMultiFeedback(null)
      setMultiSelectedAnswer(null)
      setMultiInputAnswer('')
    }, 900)
  }

  function handleMultiplayerInputSubmit(event) {
    event.preventDefault()
    if (multiInputAnswer.trim() === '' || multiStartsIn > 0) {
      return
    }

    const parsed = Number(multiInputAnswer)
    if (!Number.isFinite(parsed)) {
      return
    }

    answerMultiplayerQuestion(parsed)
  }

  function finishMultiplayerRace(forceSessionFinish = false) {
    if (multiFinishedRef.current) {
      return
    }

    multiFinishedRef.current = true

    if (multiNextQuestionTimeoutRef.current) {
      window.clearTimeout(multiNextQuestionTimeoutRef.current)
    }

    setMultiLocked(true)
    const finishedAtMs = Date.now()

    persistMultiplayerProgress({
      score: multiScore,
      streak: multiStreak,
      bestStreak: multiBestStreak,
      correct: multiCorrect,
      total: multiTotal,
      questionIndex: multiQuestionIndex,
      finishedAtMs,
    })

    const playersWithMe = {
      ...(multiSession?.players || {}),
      [devicePlayerId]: {
        ...(multiSession?.players?.[devicePlayerId] || {}),
        uid: devicePlayerId,
        name: activeUser?.name || 'Joueur',
        score: multiScore,
        streak: multiStreak,
        bestStreak: multiBestStreak,
        correct: multiCorrect,
        total: multiTotal,
        questionIndex: multiQuestionIndex,
        finishedAtMs,
      },
    }

    const everyoneFinished = Object.values(playersWithMe).every(
      (player) => typeof player.finishedAtMs === 'number',
    )

    if (multiplayerEnabled && db && multiSessionId && (forceSessionFinish || everyoneFinished)) {
      updateDoc(doc(db, MULTIPLAYER_COLLECTION, multiSessionId), {
        status: 'finished',
        finishedAtMs: Date.now(),
      }).catch(() => {
        setMultiStatusMessage('Fin de session non synchronisee pour tous.')
      })
    }

    const starsFromMulti = Math.max(1, Math.round(multiScore / 30))
    applyProgressToActiveUser(multiScore, multiBestStreak, multiCorrect, multiTotal, starsFromMulti)

    setMultiFinalRankings(sortPlayersByRank(playersWithMe))
    setScreen('multiplayerResult')
  }

  async function copySessionCode() {
    if (!multiSessionId) {
      return
    }

    try {
      await navigator.clipboard.writeText(multiSessionId)
      setMultiStatusMessage(`Code ${multiSessionId} copie dans le presse-papiers.`)
    } catch {
      setMultiStatusMessage('Copie impossible. Tu peux partager le code manuellement.')
    }
  }

  const accuracyRate = totalAnswers === 0 ? 0 : Math.round((correctAnswers / totalAnswers) * 100)
  const globalAccuracy =
    activeUser && activeUser.totalAnswers > 0
      ? Math.round((activeUser.totalCorrect / activeUser.totalAnswers) * 100)
      : 0

  const multiAccuracyRate = multiTotal === 0 ? 0 : Math.round((multiCorrect / multiTotal) * 100)

  return (
    <main className="app-shell">
      <div className="bg-shape bg-shape-top" />
      <div className="bg-shape bg-shape-bottom" />

      {screen === 'login' && (
        <section className="panel panel-login">
          <p className="eyebrow">TABLE QUEST</p>
          <h1>Deviens le boss des multiplications</h1>
          <p className="muted">
            Jeu rapide, beau et simple. Parfait sur mobile et iPad pour apprendre en s amusant.
          </p>

          <form className="login-form" onSubmit={handleLogin}>
            <label htmlFor="name">Ton pseudo</label>
            <input
              id="name"
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              placeholder="Ex: Leo"
              maxLength={18}
              autoComplete="nickname"
            />
            <button type="submit" className="btn-primary">
              Entrer dans le jeu
            </button>
          </form>

          <p className="small-note">Les scores sont sauvegardes sur cet appareil.</p>
        </section>
      )}

      {screen === 'home' && activeUser && (
        <section className="panel panel-home">
          <header className="home-header">
            <div>
              <p className="eyebrow">Salut {activeUser.name}</p>
              <h2>Choisis ton mode de jeu</h2>
            </div>
            <button className="btn-soft" type="button" onClick={logout}>
              Changer de profil
            </button>
          </header>

          <div className="stats-grid">
            <article className="stat-card">
              <p>Record perso</p>
              <strong>{activeUser.bestScore}</strong>
            </article>
            <article className="stat-card">
              <p>Serie max</p>
              <strong>{activeUser.bestStreak}</strong>
            </article>
            <article className="stat-card">
              <p>Etoiles</p>
              <strong>{activeUser.stars}</strong>
            </article>
            <article className="stat-card">
              <p>Precision globale</p>
              <strong>{globalAccuracy}%</strong>
            </article>
          </div>

          <article className="answer-mode-panel">
            <p className="custom-title">Type de reponse</p>
            <p className="muted">Tu choisis: mode QCM ou mode ecriture.</p>
            <div className="answer-mode-options">
              {ANSWER_MODES.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={answerMode === option.id ? 'answer-mode-btn active' : 'answer-mode-btn'}
                  onClick={() => setAnswerMode(option.id)}
                >
                  <span>{option.title}</span>
                  <small>{option.subtitle}</small>
                </button>
              ))}
            </div>
          </article>

          <div className="mode-grid">
            {GAME_MODES.map((gameMode) => (
              <article key={gameMode.id} className="mode-card">
                <h3>{gameMode.title}</h3>
                <p>{gameMode.subtitle}</p>
                <span>{gameMode.duration}s</span>
                <button type="button" className="btn-primary" onClick={() => startRound(gameMode)}>
                  Jouer
                </button>
              </article>
            ))}
          </div>

          <article className="custom-mode">
            <p className="custom-title">Mode personnalise</p>
            <p className="muted">Choisis les tables que tu veux travailler.</p>
            <div className="table-picker">
              {Array.from({ length: 11 }, (_, index) => index + 2).map((table) => (
                <button
                  type="button"
                  key={table}
                  className={customTables.includes(table) ? 'table-pill active' : 'table-pill'}
                  onClick={() => toggleCustomTable(table)}
                >
                  x{table}
                </button>
              ))}
            </div>
            <button type="button" className="btn-primary" onClick={startCustomMode}>
              Lancer le mode perso
            </button>
          </article>

          <article className="multiplayer-panel">
            <div className="leaderboard-head">
              <h3>Mode multijoueur vitesse</h3>
              <p>Cross-device web</p>
            </div>

            {!multiplayerEnabled && (
              <p className="multiplayer-warning">
                Configure Firebase (variables VITE_FIREBASE_...) pour activer creation et sessions multi.
              </p>
            )}

            <div className="multiplayer-setup-grid">
              <label className="stack-label">
                Mode de course
                <select
                  value={multiModeId}
                  onChange={(event) => setMultiModeId(event.target.value)}
                  disabled={!multiplayerEnabled || multiBusy}
                >
                  {GAME_MODES.map((gameMode) => (
                    <option key={gameMode.id} value={gameMode.id}>
                      {gameMode.title} ({gameMode.duration}s)
                    </option>
                  ))}
                </select>
              </label>

              <label className="stack-label">
                Code session
                <input
                  value={joinCodeInput}
                  onChange={(event) => setJoinCodeInput(normalizeSessionCode(event.target.value))}
                  placeholder="Ex: 9F7QK2"
                  maxLength={6}
                  disabled={!multiplayerEnabled || multiBusy}
                />
              </label>
            </div>

            <div className="multiplayer-actions">
              <button
                type="button"
                className="btn-primary"
                onClick={createMultiplayerSession}
                disabled={!multiplayerEnabled || multiBusy}
              >
                {multiBusy ? 'Patiente...' : `Creer une session (${currentMultiMode.title})`}
              </button>
              <button
                type="button"
                className="btn-soft"
                onClick={joinMultiplayerSession}
                disabled={!multiplayerEnabled || multiBusy}
              >
                Rejoindre avec le code
              </button>
            </div>

            <p className="small-note">Partage le code de session pour jouer ensemble en temps reel.</p>
            {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
          </article>

          <article className="leaderboard">
            <div className="leaderboard-head">
              <h3>Top records</h3>
              <p>Sur cet appareil</p>
            </div>
            {leaderboard.length === 0 && <p className="muted">Pas encore de score.</p>}
            {leaderboard.map((player, index) => (
              <div className="leader-row" key={player.id}>
                <span>#{index + 1}</span>
                <p>{player.name}</p>
                <strong>{player.bestScore}</strong>
              </div>
            ))}
          </article>
        </section>
      )}

      {screen === 'playing' && (
        <section className="panel panel-game">
          <header className="game-top">
            <div className="pill">Temps {timeLeft}s</div>
            <div className="pill">Score {score}</div>
            <div className="pill">Serie {streak}</div>
          </header>

          <article className="question-card">
            <p className="eyebrow">{mode.title}</p>
            <h2>
              {question.a} x {question.b}
            </h2>
            <p className="muted">
              {answerMode === 'choices' ? 'Choisis la bonne reponse.' : 'Ecris la reponse puis valide.'}
            </p>
          </article>

          {answerMode === 'choices' ? (
            <div className="answers-grid">
              {question.options.map((option) => {
                let buttonClass = 'answer-btn'
                if (locked && selectedAnswer === option && option === question.answer) {
                  buttonClass += ' picked-correct'
                } else if (locked && selectedAnswer === option && option !== question.answer) {
                  buttonClass += ' picked-wrong'
                }

                if (locked && feedback?.type === 'error' && option === question.answer) {
                  buttonClass += ' reveal-correct'
                }

                return (
                  <button
                    key={`${question.id}-${option}`}
                    type="button"
                    className={buttonClass}
                    disabled={locked}
                    onClick={() => answerQuestion(option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          ) : (
            <form className="input-answer-form" onSubmit={handleInputSubmit}>
              <input
                ref={answerInputRef}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="input-answer"
                placeholder="Ta reponse"
                value={inputAnswer}
                onChange={(event) => setInputAnswer(event.target.value)}
                disabled={locked}
              />
              <button type="submit" className="btn-primary" disabled={locked}>
                Valider
              </button>
            </form>
          )}

          <article className={feedback ? `feedback-card active ${feedback.type}` : 'feedback-card'}>
            {feedback ? (
              <>
                <p className="feedback-title">{feedback.title}</p>
                {feedback.type === 'success' ? (
                  <p className="feedback-points">{feedback.detail}</p>
                ) : (
                  <p className="feedback-answer">
                    Bonne reponse: <strong>{feedback.detail}</strong> = <b>{feedback.correctAnswer}</b>
                  </p>
                )}
              </>
            ) : (
              <p className="feedback-placeholder">Reponds pour voir ton boost.</p>
            )}
          </article>

          <footer className="game-footer">
            <p>
              Bonnes reponses {correctAnswers}/{totalAnswers} ({accuracyRate}%)
            </p>
            <button type="button" className="btn-soft" onClick={finishRound}>
              Terminer
            </button>
          </footer>
        </section>
      )}

      {screen === 'result' && activeUser && (
        <section className="panel panel-result">
          <p className="eyebrow">Fin de partie</p>
          <h2>Bien joue {activeUser.name}</h2>

          <div className="result-grid">
            <article className="result-card">
              <p>Score</p>
              <strong>{score}</strong>
            </article>
            <article className="result-card">
              <p>Precision</p>
              <strong>{accuracyRate}%</strong>
            </article>
            <article className="result-card">
              <p>Serie max</p>
              <strong>{bestRoundStreak}</strong>
            </article>
            <article className="result-card">
              <p>Etoiles gagnees</p>
              <strong>+{starsEarned}</strong>
            </article>
          </div>

          <p className="muted">
            Ton record perso: <strong>{Math.max(activeUser.bestScore, score)}</strong>
          </p>

          <div className="result-actions">
            <button type="button" className="btn-primary" onClick={() => startRound(mode)}>
              Rejouer
            </button>
            <button type="button" className="btn-soft" onClick={() => setScreen('home')}>
              Menu principal
            </button>
          </div>
        </section>
      )}

      {screen === 'multiplayerLobby' && activeUser && (
        <section className="panel panel-multi-lobby">
          <p className="eyebrow">Session multijoueur</p>
          <h2>Salle de course</h2>

          <div className="lobby-code-wrap">
            <p>Code a partager</p>
            <strong>{multiSessionId || '-'}</strong>
            <button type="button" className="btn-soft" onClick={copySessionCode}>
              Copier le code
            </button>
          </div>

          <div className="lobby-meta">
            <p>
              Mode: <strong>{multiSession?.modeTitle || currentMultiMode.title}</strong>
            </p>
            <p>
              Reponse: <strong>{multiplayerAnswerMode === 'choices' ? 'QCM' : 'Ecrite'}</strong>
            </p>
            <p>
              Duree: <strong>{multiSession?.duration || currentMultiMode.duration}s</strong>
            </p>
          </div>

          <article className="leaderboard">
            <div className="leaderboard-head">
              <h3>Joueurs connectes</h3>
              <p>{Object.keys(multiSession?.players || {}).length} joueurs</p>
            </div>
            {sortPlayersByRank(multiSession?.players || {}).map((player) => (
              <div className="leader-row" key={player.uid}>
                <span>{player.uid === multiSession?.hostUid ? 'Host' : 'Player'}</span>
                <p>{player.name}</p>
                <strong>{player.uid === devicePlayerId ? 'Toi' : ''}</strong>
              </div>
            ))}
          </article>

          <div className="result-actions">
            {isHost ? (
              <button type="button" className="btn-primary" onClick={startMultiplayerRace}>
                Lancer la course
              </button>
            ) : (
              <button type="button" className="btn-soft" disabled>
                En attente du host
              </button>
            )}
            <button type="button" className="btn-soft" onClick={leaveMultiplayerSession}>
              Quitter la session
            </button>
          </div>

          {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
        </section>
      )}

      {screen === 'multiplayerPlaying' && (
        <section className="panel panel-game panel-multi-game">
          <header className="game-top">
            <div className="pill">Temps {multiTimeLeft}s</div>
            <div className="pill">Score {multiScore}</div>
            <div className="pill">Rang #{myMultiRank > 0 ? myMultiRank : '-'}</div>
          </header>

          <article className="question-card">
            <p className="eyebrow">Course live {multiSessionId ? `#${multiSessionId}` : ''}</p>
            {multiStartsIn > 0 ? (
              <>
                <h2>Depart dans {multiStartsIn}</h2>
                <p className="muted">Prete-toi... vitesse max!</p>
              </>
            ) : (
              <>
                <h2>
                  {multiQuestion?.a} x {multiQuestion?.b}
                </h2>
                <p className="muted">
                  {multiplayerAnswerMode === 'choices'
                    ? 'Choisis la bonne reponse.'
                    : 'Ecris la reponse puis valide.'}
                </p>
              </>
            )}
          </article>

          {multiStartsIn === 0 && multiplayerAnswerMode === 'choices' && multiQuestion && (
            <div className="answers-grid">
              {multiQuestion.options.map((option) => {
                let buttonClass = 'answer-btn'
                if (multiLocked && multiSelectedAnswer === option && option === multiQuestion.answer) {
                  buttonClass += ' picked-correct'
                } else if (multiLocked && multiSelectedAnswer === option && option !== multiQuestion.answer) {
                  buttonClass += ' picked-wrong'
                }

                if (multiLocked && multiFeedback?.type === 'error' && option === multiQuestion.answer) {
                  buttonClass += ' reveal-correct'
                }

                return (
                  <button
                    key={`${multiQuestion.id}-${option}`}
                    type="button"
                    className={buttonClass}
                    disabled={multiLocked || multiStartsIn > 0}
                    onClick={() => answerMultiplayerQuestion(option)}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          )}

          {multiStartsIn === 0 && multiplayerAnswerMode === 'input' && (
            <form className="input-answer-form" onSubmit={handleMultiplayerInputSubmit}>
              <input
                ref={multiInputRef}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="input-answer"
                placeholder="Ta reponse"
                value={multiInputAnswer}
                onChange={(event) => setMultiInputAnswer(event.target.value)}
                disabled={multiLocked || multiStartsIn > 0}
              />
              <button type="submit" className="btn-primary" disabled={multiLocked || multiStartsIn > 0}>
                Valider
              </button>
            </form>
          )}

          <article className={multiFeedback ? `feedback-card active ${multiFeedback.type}` : 'feedback-card'}>
            {multiStartsIn > 0 ? (
              <p className="feedback-placeholder">Tous les joueurs se preparent...</p>
            ) : multiFeedback ? (
              <>
                <p className="feedback-title">{multiFeedback.title}</p>
                {multiFeedback.type === 'success' ? (
                  <p className="feedback-points">{multiFeedback.detail}</p>
                ) : (
                  <p className="feedback-answer">
                    Bonne reponse: <strong>{multiFeedback.detail}</strong> = <b>{multiFeedback.correctAnswer}</b>
                  </p>
                )}
              </>
            ) : (
              <p className="feedback-placeholder">Reste focus, chaque seconde compte.</p>
            )}
          </article>

          <article className="live-ranking-card">
            <div className="leaderboard-head">
              <h3>Classement live</h3>
              <p>{multiRankings.length} joueurs</p>
            </div>
            {multiRankings.slice(0, 5).map((player, index) => (
              <div className="leader-row" key={`${player.uid}-${index}`}>
                <span>#{index + 1}</span>
                <p>{player.name}</p>
                <strong>{player.score}</strong>
              </div>
            ))}
          </article>

          <footer className="game-footer">
            <p>
              Bonnes reponses {multiCorrect}/{multiTotal} ({multiAccuracyRate}%)
            </p>
            <button type="button" className="btn-soft" onClick={() => finishMultiplayerRace(true)}>
              Terminer la course
            </button>
          </footer>
        </section>
      )}

      {screen === 'multiplayerResult' && (
        <section className="panel panel-result">
          <p className="eyebrow">Resultat multijoueur</p>
          <h2>Course terminee</h2>

          <div className="result-grid">
            <article className="result-card">
              <p>Ton score</p>
              <strong>{multiScore}</strong>
            </article>
            <article className="result-card">
              <p>Ton rang</p>
              <strong>#{myMultiRank > 0 ? myMultiRank : '-'}</strong>
            </article>
            <article className="result-card">
              <p>Precision</p>
              <strong>{multiAccuracyRate}%</strong>
            </article>
            <article className="result-card">
              <p>Serie max</p>
              <strong>{multiBestStreak}</strong>
            </article>
          </div>

          <article className="leaderboard">
            <div className="leaderboard-head">
              <h3>Classement final</h3>
              <p>Session {multiSessionId || '-'}</p>
            </div>
            {(multiFinalRankings.length > 0 ? multiFinalRankings : multiRankings).map((player, index) => (
              <div className="leader-row" key={`${player.uid}-${index}`}>
                <span>#{index + 1}</span>
                <p>{player.name}</p>
                <strong>{player.score}</strong>
              </div>
            ))}
          </article>

          <div className="result-actions">
            <button type="button" className="btn-primary" onClick={leaveMultiplayerSession}>
              Retour menu
            </button>
            <button type="button" className="btn-soft" onClick={copySessionCode}>
              Copier le code
            </button>
          </div>

          {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
        </section>
      )}
    </main>
  )
}

export default App
