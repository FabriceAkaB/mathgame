import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth'
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import { MemoryGame } from './MemoryGame'
import { auth, db, isFirebaseConfigured } from './lib/firebase'
import {
  buildRandomQuestion,
  buildSeededQuestion,
  createSessionSeed,
  generateSessionCode,
  MULTIPLAYER_COLLECTION,
  normalizeModeConfig,
  normalizeSessionCode,
  sortPlayersByRank,
} from './lib/multiplayer'

const STORAGE_KEYS = {
  users: 'tablequest_users_v1',
  devicePlayerId: 'tablequest_device_player_id_v1',
}

const CLOUD_PROFILE_COLLECTION = 'tablequest_profiles'
const QUESTS_COLLECTION = 'tablequest_quests'
const ADMIN_EMAIL = import.meta.env.VITE_ADMIN_EMAIL || ''

const GAME_MODES = [
  {
    id: 'warmup',
    title: 'Echauffement',
    subtitle: 'Tables 2 a 5',
    duration: 45,
    modeConfig: { type: 'tables', tables: [2, 3, 4, 5] },
  },
  {
    id: 'focus7',
    title: 'Focus x7',
    subtitle: 'Table de 7',
    duration: 55,
    modeConfig: { type: 'tables', tables: [7] },
  },
  {
    id: 'master',
    title: 'Mix Master',
    subtitle: 'Tables 2 a 12',
    duration: 60,
    modeConfig: { type: 'tables', tables: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  },
  {
    id: 'boss',
    title: 'Boss 9-12',
    subtitle: 'Pour les champions',
    duration: 75,
    modeConfig: { type: 'tables', tables: [9, 10, 11, 12] },
  },
  {
    id: 'mental-hard',
    title: 'Calcul Mental Difficile',
    subtitle: 'Additions + multiplications intenses',
    duration: 90,
    modeConfig: { type: 'mixed', operations: ['mul', 'add'], mulMin: 6, mulMax: 25, addMin: 20, addMax: 300 },
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

const QUEST_ANSWER_MODE_OPTIONS = [
  { id: 'any', title: 'Libre (au choix du joueur)' },
  { id: 'choices', title: 'Choix de reponses uniquement' },
  { id: 'input', title: 'Reponse ecrite uniquement' },
]

function getModeById(modeId) {
  return GAME_MODES.find((mode) => mode.id === modeId) || DEFAULT_MODE
}

function normalizePositiveNumber(value, fallback, min = 1, max = 5000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function normalizeQuestAnswerMode(value) {
  if (value === 'choices' || value === 'input') {
    return value
  }
  return 'any'
}

function getQuestAnswerModeLabel(value) {
  const normalized = normalizeQuestAnswerMode(value)
  return QUEST_ANSWER_MODE_OPTIONS.find((option) => option.id === normalized)?.title || QUEST_ANSWER_MODE_OPTIONS[0].title
}

function buildMentalModeConfig(mentalSettings) {
  const operations = []
  if (mentalSettings.includeMul) {
    operations.push('mul')
  }
  if (mentalSettings.includeAdd) {
    operations.push('add')
  }

  return normalizeModeConfig({
    type: 'mixed',
    operations: operations.length > 0 ? operations : ['mul'],
    mulMin: normalizePositiveNumber(mentalSettings.mulMin, 6, 1, 200),
    mulMax: normalizePositiveNumber(mentalSettings.mulMax, 25, normalizePositiveNumber(mentalSettings.mulMin, 6, 1, 200), 500),
    addMin: normalizePositiveNumber(mentalSettings.addMin, 20, 0, 5000),
    addMax: normalizePositiveNumber(mentalSettings.addMax, 300, normalizePositiveNumber(mentalSettings.addMin, 20, 0, 5000), 20000),
  })
}

function getDevicePlayerId() {
  const saved = window.localStorage.getItem(STORAGE_KEYS.devicePlayerId)
  if (saved) {
    return saved
  }

  const generated =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `device-${Math.random().toString(36).slice(2, 11)}`

  window.localStorage.setItem(STORAGE_KEYS.devicePlayerId, generated)
  return generated
}

function readLocalUsersFromStorage() {
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

function summarizeLocalUsers(localUsers) {
  if (!Array.isArray(localUsers) || localUsers.length === 0) {
    return null
  }

  return localUsers.reduce(
    (accumulator, current) => {
      const bestScore = Number(current.bestScore) || 0
      const bestStreak = Number(current.bestStreak) || 0
      const gamesPlayed = Number(current.gamesPlayed) || 0
      const totalCorrect = Number(current.totalCorrect) || 0
      const totalAnswers = Number(current.totalAnswers) || 0
      const stars = Number(current.stars) || 0

      return {
        bestScore: Math.max(accumulator.bestScore, bestScore),
        bestStreak: Math.max(accumulator.bestStreak, bestStreak),
        gamesPlayed: accumulator.gamesPlayed + gamesPlayed,
        totalCorrect: accumulator.totalCorrect + totalCorrect,
        totalAnswers: accumulator.totalAnswers + totalAnswers,
        stars: accumulator.stars + stars,
      }
    },
    {
      bestScore: 0,
      bestStreak: 0,
      gamesPlayed: 0,
      totalCorrect: 0,
      totalAnswers: 0,
      stars: 0,
    },
  )
}

function levelFromXp(xp) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 120)) + 1)
}

function createDefaultCloudProfile(user, localSummary = null) {
  const safeDisplayName =
    (user.displayName && user.displayName.trim()) ||
    (user.email && user.email.split('@')[0]) ||
    'Joueur'

  const base = {
    uid: user.uid,
    email: user.email || '',
    displayName: safeDisplayName,
    bestScore: 0,
    bestStreak: 0,
    gamesPlayed: 0,
    totalCorrect: 0,
    totalAnswers: 0,
    stars: 0,
    xp: 0,
    level: 1,
    recentRuns: [],
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    lastPlayedMs: null,
    localMigrationV1Done: true,
  }

  if (!localSummary) {
    return base
  }

  const nextXp = Math.max(0, localSummary.stars * 10 + localSummary.bestScore)

  return {
    ...base,
    bestScore: localSummary.bestScore,
    bestStreak: localSummary.bestStreak,
    gamesPlayed: localSummary.gamesPlayed,
    totalCorrect: localSummary.totalCorrect,
    totalAnswers: localSummary.totalAnswers,
    stars: localSummary.stars,
    xp: nextXp,
    level: levelFromXp(nextXp),
  }
}

function getActivePlayerEntries(playersMap) {
  return Object.entries(playersMap || {}).filter(([, player]) => !player?.leftAtMs)
}

function getSpeedPointsByRank(rankIndex) {
  if (rankIndex === 0) {
    return 5
  }
  if (rankIndex === 1) {
    return 3
  }
  if (rankIndex === 2) {
    return 2
  }
  return 1
}

function createSessionPlayer(cloudProfile, playerId, previous = null) {
  const now = Date.now()
  return {
    playerId,
    uid: cloudProfile.uid,
    name: cloudProfile.displayName,
    score: previous?.score ?? 0,
    streak: previous?.streak ?? 0,
    bestStreak: previous?.bestStreak ?? 0,
    correct: previous?.correct ?? 0,
    total: previous?.total ?? 0,
    questionWins: previous?.questionWins ?? 0,
    joinedAtMs: previous?.joinedAtMs ?? now,
    lastUpdateMs: now,
    leftAtMs: null,
  }
}

function computeRoundResolution(sessionData, resolvedAtMs) {
  const currentIndex = sessionData.currentQuestionIndex || 0
  const question = buildSeededQuestion(sessionData.modeConfig, sessionData.seed, currentIndex)

  const players = { ...(sessionData.players || {}) }
  const responses = { ...(sessionData.roundResponses || {}) }

  const activePlayerEntries = getActivePlayerEntries(players)
  const activePlayerIds = activePlayerEntries.map(([playerId]) => playerId)

  const validResponses = activePlayerIds
    .map((playerId) => responses[playerId])
    .filter(Boolean)

  const correctResponses = validResponses
    .filter((response) => response.isCorrect)
    .sort((first, second) => {
      if ((first.latencyMs || Infinity) !== (second.latencyMs || Infinity)) {
        return (first.latencyMs || Infinity) - (second.latencyMs || Infinity)
      }
      return (first.answeredAtMs || Infinity) - (second.answeredAtMs || Infinity)
    })

  const pointsByPlayerId = {}
  correctResponses.forEach((response, index) => {
    pointsByPlayerId[response.playerId] = getSpeedPointsByRank(index)
  })

  activePlayerIds.forEach((playerId) => {
    const previous = players[playerId] || {}
    const response = responses[playerId] || null
    const scoreGain = pointsByPlayerId[playerId] || 0

    const nextPlayer = {
      ...previous,
      score: (previous.score || 0) + scoreGain,
      lastUpdateMs: resolvedAtMs,
    }

    if (response) {
      nextPlayer.total = (previous.total || 0) + 1
      if (response.isCorrect) {
        const nextStreak = (previous.streak || 0) + 1
        nextPlayer.correct = (previous.correct || 0) + 1
        nextPlayer.streak = nextStreak
        nextPlayer.bestStreak = Math.max(previous.bestStreak || 0, nextStreak)
        nextPlayer.questionWins = (previous.questionWins || 0) + 1
      } else {
        nextPlayer.streak = 0
      }
    } else {
      nextPlayer.streak = 0
    }

    players[playerId] = nextPlayer
  })

  const winner = correctResponses[0] || null

  const summary = {
    questionLabel: question.label,
    correctAnswer: question.answer,
    winnerPlayerId: winner?.playerId || null,
    winnerUid: winner?.uid || null,
    winnerName: winner?.name || null,
    answeredCount: validResponses.length,
    totalPlayers: activePlayerIds.length,
    correctPlayers: correctResponses.map((response, index) => ({
      playerId: response.playerId,
      uid: response.uid,
      name: response.name,
      rank: index + 1,
      points: pointsByPlayerId[response.playerId] || 0,
      latencyMs: response.latencyMs || null,
    })),
    wrongPlayers: validResponses
      .filter((response) => !response.isCorrect)
      .map((response) => ({ playerId: response.playerId, uid: response.uid, name: response.name })),
    missedPlayers: activePlayerIds
      .filter((playerId) => !responses[playerId])
      .map((playerId) => ({
        playerId,
        uid: players[playerId]?.uid || '',
        name: players[playerId]?.name || 'Joueur',
      })),
    resolvedAtMs,
  }

  return {
    players,
    summary,
    question,
  }
}

function buildAuthErrorMessage(error, currentHost = '') {
  const code = error?.code || ''

  if (code === 'auth/unauthorized-domain') {
    return `Domaine non autorise dans Firebase Auth (${currentHost || 'domaine courant'}). Ajoute-le dans Authentication > Settings > Authorized domains.`
  }
  if (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user') {
    return 'Popup Google bloquee. Reessaie (ou utilise la redirection).'
  }
  if (code === 'auth/invalid-credential') {
    return 'Identifiants invalides.'
  }
  if (code === 'auth/user-not-found') {
    return 'Aucun compte trouve pour cet email.'
  }
  if (code === 'auth/wrong-password') {
    return 'Mot de passe incorrect.'
  }
  if (code === 'auth/email-already-in-use') {
    return 'Cet email est deja utilise.'
  }
  if (code === 'auth/weak-password') {
    return 'Mot de passe trop faible (minimum 6 caracteres).'
  }
  if (code === 'auth/network-request-failed') {
    return 'Erreur reseau, reessaie.'
  }

  return error?.message || 'Authentification impossible.'
}

function buildProfileLoadErrorMessage(error, currentHost = '') {
  const code = error?.code || ''

  if (code === 'permission-denied' || code === 'firestore/permission-denied') {
    return `Acces Firestore refuse pour le profil cloud. Verifie les regles de tablequest_profiles et l utilisateur connecte (domaine: ${currentHost || 'inconnu'}).`
  }
  if (code === 'unavailable' || code === 'firestore/unavailable') {
    return 'Firestore indisponible temporairement. Reessaie dans quelques secondes.'
  }
  if (code === 'failed-precondition' || code === 'firestore/failed-precondition') {
    return 'Firestore n est pas pret (base/regles). Verifie la configuration du projet Firebase.'
  }

  return `Impossible de charger le profil cloud (${code || 'erreur inconnue'}).`
}

function AuthView({
  authBusy,
  authError,
  authMode,
  setAuthMode,
  authEmail,
  setAuthEmail,
  authPassword,
  setAuthPassword,
  authPasswordConfirm,
  setAuthPasswordConfirm,
  authDisplayName,
  setAuthDisplayName,
  onEmailSubmit,
  onGoogleSignIn,
}) {
  return (
    <section className="panel panel-login auth-panel">
      <p className="eyebrow">TABLE QUEST CLOUD</p>
      <h1>Connecte-toi pour garder ta progression sur tous tes appareils</h1>
      <p className="muted">Ton profil, tes stats et tes records restent synchronises (iPad, ordi, mobile).</p>

      <div className="auth-tabs">
        <button
          type="button"
          className={authMode === 'signin' ? 'time-mode-btn active' : 'time-mode-btn'}
          onClick={() => setAuthMode('signin')}
          disabled={authBusy}
        >
          Connexion
        </button>
        <button
          type="button"
          className={authMode === 'signup' ? 'time-mode-btn active' : 'time-mode-btn'}
          onClick={() => setAuthMode('signup')}
          disabled={authBusy}
        >
          Creer un compte
        </button>
      </div>

      <form className="login-form" onSubmit={onEmailSubmit}>
        {authMode === 'signup' && (
          <>
            <label htmlFor="displayName">Pseudo</label>
            <input
              id="displayName"
              value={authDisplayName}
              onChange={(event) => setAuthDisplayName(event.target.value)}
              placeholder="Ex: Leo"
              maxLength={20}
              autoComplete="nickname"
              required
            />
          </>
        )}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={authEmail}
          onChange={(event) => setAuthEmail(event.target.value)}
          placeholder="exemple@email.com"
          autoComplete="email"
          required
        />

        <label htmlFor="password">Mot de passe</label>
        <input
          id="password"
          type="password"
          value={authPassword}
          onChange={(event) => setAuthPassword(event.target.value)}
          placeholder="Minimum 6 caracteres"
          autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
          required
        />

        {authMode === 'signup' && (
          <>
            <label htmlFor="passwordConfirm">Confirmer mot de passe</label>
            <input
              id="passwordConfirm"
              type="password"
              value={authPasswordConfirm}
              onChange={(event) => setAuthPasswordConfirm(event.target.value)}
              autoComplete="new-password"
              required
            />
          </>
        )}

        <button type="submit" className="btn-primary" disabled={authBusy}>
          {authBusy ? 'Patiente...' : authMode === 'signup' ? 'Creer mon compte' : 'Se connecter'}
        </button>
      </form>

      <div className="auth-separator">ou</div>
      <button type="button" className="btn-soft" onClick={onGoogleSignIn} disabled={authBusy}>
        Continuer avec Google
      </button>

      {authError && <p className="auth-error">{authError}</p>}
      <p className="small-note">Le mode multijoueur cloud demande une configuration Firebase complete.</p>
    </section>
  )
}

function App() {
  const navigate = useNavigate()
  const location = useLocation()

  const [authLoading, setAuthLoading] = useState(true)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMode, setAuthMode] = useState('signin')
  const [authError, setAuthError] = useState('')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState('')
  const [authDisplayName, setAuthDisplayName] = useState('')

  const [authUser, setAuthUser] = useState(null)
  const [cloudProfile, setCloudProfile] = useState(null)
  const [profileNameInput, setProfileNameInput] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMessage, setProfileMessage] = useState('')

  const [answerMode, setAnswerMode] = useState('choices')
  const [timeMode, setTimeMode] = useState('timed')
  const [customTables, setCustomTables] = useState([2, 3, 4, 5])
  const [mentalSettings, setMentalSettings] = useState({
    includeMul: true,
    includeAdd: true,
    mulMin: 6,
    mulMax: 25,
    addMin: 20,
    addMax: 300,
  })

  const [soloPhase, setSoloPhase] = useState('idle')
  const [soloMode, setSoloMode] = useState(DEFAULT_MODE)
  const [soloModeConfig, setSoloModeConfig] = useState(() => normalizeModeConfig(DEFAULT_MODE.modeConfig))
  const [soloQuestion, setSoloQuestion] = useState(() => buildRandomQuestion(DEFAULT_MODE.modeConfig))
  const [soloTimeLeft, setSoloTimeLeft] = useState(DEFAULT_MODE.duration)
  const [soloScore, setSoloScore] = useState(0)
  const [soloStreak, setSoloStreak] = useState(0)
  const [soloBestStreak, setSoloBestStreak] = useState(0)
  const [soloCorrect, setSoloCorrect] = useState(0)
  const [soloTotal, setSoloTotal] = useState(0)
  const [soloLocked, setSoloLocked] = useState(false)
  const [soloFeedback, setSoloFeedback] = useState(null)
  const [soloSelectedAnswer, setSoloSelectedAnswer] = useState(null)
  const [soloInputAnswer, setSoloInputAnswer] = useState('')
  const [soloStarsEarned, setSoloStarsEarned] = useState(0)
  const [soloProgressSaved, setSoloProgressSaved] = useState(false)

  const [multiModeId, setMultiModeId] = useState(DEFAULT_MODE.id)
  const [multiDurationType, setMultiDurationType] = useState('timed')
  const [multiCustomDurationSeconds, setMultiCustomDurationSeconds] = useState(DEFAULT_MODE.duration)
  const [multiAnswerWindowSeconds, setMultiAnswerWindowSeconds] = useState(8)
  const [multiRevealCooldownSeconds, setMultiRevealCooldownSeconds] = useState(2)
  const [multiMentalSettingsLocal, setMultiMentalSettingsLocal] = useState({
    includeMul: true,
    includeAdd: true,
    mulMin: 6,
    mulMax: 25,
    addMin: 20,
    addMax: 300,
  })
  const [joinCodeInput, setJoinCodeInput] = useState('')
  const [multiSessionId, setMultiSessionId] = useState('')
  const [multiSession, setMultiSession] = useState(null)
  const [multiBusy, setMultiBusy] = useState(false)
  const [multiStatusMessage, setMultiStatusMessage] = useState('')
  const [multiStartsIn, setMultiStartsIn] = useState(0)
  const [multiTimeLeft, setMultiTimeLeft] = useState(null)
  const [multiPhaseTimeLeft, setMultiPhaseTimeLeft] = useState(null)
  const [multiInputAnswer, setMultiInputAnswer] = useState('')
  const [multiSubmitting, setMultiSubmitting] = useState(false)
  const [multiSelectedAnswer, setMultiSelectedAnswer] = useState(null)
  const [multiFeedback, setMultiFeedback] = useState(null)
  const [multiRewardedSessionId, setMultiRewardedSessionId] = useState('')

  // --- Quest state (player) ---
  const [activeQuests, setActiveQuests] = useState([])
  const [activeQuestRun, setActiveQuestRun] = useState(null)
  const [lastQuestRun, setLastQuestRun] = useState(null)

  // --- Admin state ---
  const [adminProfiles, setAdminProfiles] = useState([])
  const [adminProfilesLoading, setAdminProfilesLoading] = useState(false)
  const [adminQuests, setAdminQuests] = useState([])
  const [adminSelectedProfile, setAdminSelectedProfile] = useState(null)
  const [adminQuestForm, setAdminQuestForm] = useState({
    title: '',
    description: '',
    modeType: 'tables',
    tables: [2, 3, 4, 5],
    operations: ['mul', 'add'],
    mulMin: 6,
    mulMax: 25,
    addMin: 20,
    addMax: 300,
    durationSeconds: 60,
    requiredCompletions: 1,
    requiredScore: 0,
    requiredAnswerMode: 'any',
    targetUid: 'all',
  })
  const [adminQuestSaving, setAdminQuestSaving] = useState(false)
  const [adminQuestMessage, setAdminQuestMessage] = useState('')

  const soloInputRef = useRef(null)
  const soloNextQuestionTimeoutRef = useRef(null)

  const multiInputRef = useRef(null)
  const multiHostSyncBusyRef = useRef(false)

  const devicePlayerId = useMemo(() => getDevicePlayerId(), [])
  const selectedMultiMode = useMemo(() => getModeById(multiModeId), [multiModeId])

  const multiPlayers = useMemo(() => multiSession?.players || {}, [multiSession?.players])
  const multiActivePlayersMap = useMemo(() => Object.fromEntries(getActivePlayerEntries(multiPlayers)), [multiPlayers])
  const multiRankings = useMemo(() => sortPlayersByRank(multiActivePlayersMap), [multiActivePlayersMap])
  const myMultiPlayer = multiPlayers[devicePlayerId] || null
  const myMultiRank = useMemo(
    () => multiRankings.findIndex((player) => player.playerId === devicePlayerId) + 1,
    [multiRankings, devicePlayerId],
  )

  const multiAnswerMode = multiSession?.answerMode || answerMode
  const multiQuestionIndex = multiSession?.currentQuestionIndex || 0
  const multiRoundState = multiSession?.roundState || 'answering'
  const multiRoundResponses = multiSession?.roundResponses || {}
  const myRoundResponse = multiRoundResponses[devicePlayerId] || null
  const multiLastRoundSummary = multiSession?.lastRoundSummary || null
  const multiQuestion =
    multiSession?.status === 'playing' && multiSession?.seed
      ? buildSeededQuestion(multiSession.modeConfig, multiSession.seed, multiQuestionIndex)
      : null

  const isHost = multiSession?.hostPlayerId === devicePlayerId
  const isAdmin = Boolean(ADMIN_EMAIL && cloudProfile?.email === ADMIN_EMAIL)

  const globalAccuracy =
    cloudProfile && cloudProfile.totalAnswers > 0
      ? Math.round((cloudProfile.totalCorrect / cloudProfile.totalAnswers) * 100)
      : 0

  const completedActiveQuests = useMemo(() => {
    if (!cloudProfile?.questProgress || activeQuests.length === 0) {
      return 0
    }

    return activeQuests.reduce((count, quest) => {
      const progress = cloudProfile.questProgress?.[quest.id]
      return progress?.completed ? count + 1 : count
    }, 0)
  }, [activeQuests, cloudProfile?.questProgress])

  const soloAccuracyRate = soloTotal === 0 ? 0 : Math.round((soloCorrect / soloTotal) * 100)
  const multiAccuracyRate =
    myMultiPlayer && myMultiPlayer.total > 0 ? Math.round((myMultiPlayer.correct / myMultiPlayer.total) * 100) : 0

  const profileLevel = levelFromXp(cloudProfile?.xp || 0)
  const currentLevelMinXp = (profileLevel - 1) * (profileLevel - 1) * 120
  const nextLevelXp = profileLevel * profileLevel * 120
  const xpProgressPct =
    nextLevelXp > currentLevelMinXp
      ? Math.max(0, Math.min(100, Math.round((((cloudProfile?.xp || 0) - currentLevelMinXp) / (nextLevelXp - currentLevelMinXp)) * 100)))
      : 0

  const ensureCloudProfile = useCallback(
    async (user) => {
      if (!db) {
        return null
      }

      const profileRef = doc(db, CLOUD_PROFILE_COLLECTION, user.uid)
      const snapshot = await getDoc(profileRef)
      const localSummary = summarizeLocalUsers(readLocalUsersFromStorage())

      if (!snapshot.exists()) {
        const initialProfile = createDefaultCloudProfile(user, localSummary)
        await setDoc(profileRef, {
          ...initialProfile,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        return initialProfile
      }

      const current = snapshot.data()
      if (current.localMigrationV1Done) {
        return current
      }

      const merged = {
        bestScore: Math.max(Number(current.bestScore) || 0, localSummary?.bestScore || 0),
        bestStreak: Math.max(Number(current.bestStreak) || 0, localSummary?.bestStreak || 0),
        gamesPlayed: (Number(current.gamesPlayed) || 0) + (localSummary?.gamesPlayed || 0),
        totalCorrect: (Number(current.totalCorrect) || 0) + (localSummary?.totalCorrect || 0),
        totalAnswers: (Number(current.totalAnswers) || 0) + (localSummary?.totalAnswers || 0),
        stars: (Number(current.stars) || 0) + (localSummary?.stars || 0),
      }

      const nextXp = Math.max(Number(current.xp) || 0, merged.bestScore + merged.stars * 10)

      await updateDoc(profileRef, {
        ...merged,
        xp: nextXp,
        level: levelFromXp(nextXp),
        localMigrationV1Done: true,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      })

      return {
        ...current,
        ...merged,
        xp: nextXp,
        level: levelFromXp(nextXp),
        localMigrationV1Done: true,
      }
    },
    [],
  )

  const applyProgressToCloud = useCallback(
    async ({ score, bestStreak, correct, total, starsDelta, modeTitle, source }) => {
      if (!db || !authUser || !cloudProfile) {
        return
      }

      const profileRef = doc(db, CLOUD_PROFILE_COLLECTION, authUser.uid)

      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(profileRef)
        const base = snapshot.exists() ? snapshot.data() : createDefaultCloudProfile(authUser, null)

        const accuracyRate = total > 0 ? correct / total : 0
        const xpGain = Math.max(8, Math.round(score * 0.5 + correct * 2 + accuracyRate * 40))
        const nextXp = (Number(base.xp) || 0) + xpGain
        const nextLevel = levelFromXp(nextXp)

        const nextRecentRuns = [
          {
            modeTitle,
            source,
            score,
            correct,
            total,
            accuracy: Math.round(accuracyRate * 100),
            starsDelta,
            playedAtMs: Date.now(),
          },
          ...(Array.isArray(base.recentRuns) ? base.recentRuns : []),
        ].slice(0, 30)

        transaction.set(
          profileRef,
          {
            uid: authUser.uid,
            email: authUser.email || '',
            displayName:
              cloudProfile.displayName ||
              authUser.displayName ||
              (authUser.email ? authUser.email.split('@')[0] : 'Joueur'),
            bestScore: Math.max(Number(base.bestScore) || 0, score),
            bestStreak: Math.max(Number(base.bestStreak) || 0, bestStreak),
            gamesPlayed: (Number(base.gamesPlayed) || 0) + 1,
            totalCorrect: (Number(base.totalCorrect) || 0) + correct,
            totalAnswers: (Number(base.totalAnswers) || 0) + total,
            stars: (Number(base.stars) || 0) + starsDelta,
            xp: nextXp,
            level: nextLevel,
            recentRuns: nextRecentRuns,
            lastPlayedMs: Date.now(),
            updatedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        )
      })
    },
    [authUser, cloudProfile],
  )

  const resetMultiplayerLocalState = useCallback(() => {
    setMultiSessionId('')
    setMultiSession(null)
    setJoinCodeInput('')
    setMultiBusy(false)
    setMultiStatusMessage('')
    setMultiStartsIn(0)
    setMultiTimeLeft(null)
    setMultiPhaseTimeLeft(null)
    setMultiInputAnswer('')
    setMultiSubmitting(false)
    setMultiSelectedAnswer(null)
    setMultiFeedback(null)
  }, [])

  const syncMultiplayerRoundStateByHost = useCallback(
    async (referenceNow = Date.now()) => {
      if (!db || !multiSessionId || !isHost || multiHostSyncBusyRef.current) {
        return
      }

      multiHostSyncBusyRef.current = true
      const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

      try {
        await runTransaction(db, async (transaction) => {
          const snapshot = await transaction.get(sessionRef)
          if (!snapshot.exists()) {
            return
          }

          const data = snapshot.data()
          if (data.status !== 'playing') {
            return
          }

          const now = Math.max(referenceNow, Date.now())
          if (data.startAtMs && now < data.startAtMs) {
            return
          }

          const timedRace = data.durationType === 'timed' && typeof data.endAtMs === 'number'
          const effectiveRoundDeadline = timedRace
            ? Math.min(data.roundDeadlineAtMs || Number.POSITIVE_INFINITY, data.endAtMs)
            : data.roundDeadlineAtMs

          const activePlayerEntries = getActivePlayerEntries(data.players || {})
          const activePlayerIds = activePlayerEntries.map(([playerId]) => playerId)
          const roundResponses = data.roundResponses || {}
          const answeredCount = activePlayerIds.filter((playerId) => Boolean(roundResponses[playerId])).length
          const allAnswered = activePlayerIds.length > 0 && answeredCount >= activePlayerIds.length

          if ((data.roundState || 'answering') === 'answering') {
            const roundTimeout =
              typeof effectiveRoundDeadline === 'number' && Number.isFinite(effectiveRoundDeadline)
                ? now >= effectiveRoundDeadline
                : false

            if (!roundTimeout && !allAnswered) {
              return
            }

            const { players, summary, question } = computeRoundResolution(data, now)
            const revealCooldownMs = Math.max(600, Number(data.revealCooldownMs) || 2000)

            transaction.update(sessionRef, {
              players,
              roundState: 'reveal',
              roundResponses: {},
              revealUntilMs: now + revealCooldownMs,
              lastRoundSummary: summary,
              lastWinnerUid: summary.winnerUid,
              lastWinnerName: summary.winnerName,
              lastWinnerAtMs: now,
              lastWinnerAnswer: question.answer,
              lastWinnerQuestionLabel: question.label,
            })
            return
          }

          if ((data.roundState || 'answering') === 'reveal') {
            const revealUntilMs = typeof data.revealUntilMs === 'number' ? data.revealUntilMs : now
            if (now < revealUntilMs) {
              return
            }

            if (timedRace && now >= data.endAtMs) {
              transaction.update(sessionRef, {
                status: 'finished',
                finishedAtMs: now,
              })
              return
            }

            const answerWindowMs = Math.max(1500, Number(data.answerWindowMs) || 8000)
            transaction.update(sessionRef, {
              roundState: 'answering',
              currentQuestionIndex: (data.currentQuestionIndex || 0) + 1,
              questionOpenedAtMs: now,
              roundDeadlineAtMs: now + answerWindowMs,
              revealUntilMs: null,
              roundResponses: {},
            })
          }
        })
      } catch {
        // Silent: normal Firestore contention, will retry on next tick
      } finally {
        multiHostSyncBusyRef.current = false
      }
    },
    [isHost, multiSessionId],
  )

  useEffect(() => {
    return () => {
      if (soloNextQuestionTimeoutRef.current) {
        window.clearTimeout(soloNextQuestionTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isFirebaseConfigured || !auth) {
      setAuthLoading(false)
      return undefined
    }

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setAuthLoading(true)
      setAuthError('')

      if (!user) {
        setAuthUser(null)
        setCloudProfile(null)
        resetMultiplayerLocalState()
        setAuthLoading(false)
        return
      }

      setAuthUser(user)
      try {
        await ensureCloudProfile(user)
      } catch (error) {
        setAuthError(buildProfileLoadErrorMessage(error, window.location.hostname))
      } finally {
        setAuthLoading(false)
      }
    })

    return () => {
      unsubscribe()
    }
  }, [ensureCloudProfile, resetMultiplayerLocalState])


  useEffect(() => {
    if (!authUser || !db) {
      return undefined
    }

    const profileRef = doc(db, CLOUD_PROFILE_COLLECTION, authUser.uid)
    const unsubscribe = onSnapshot(
      profileRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          return
        }

        const nextProfile = snapshot.data()
        setCloudProfile(nextProfile)
        setProfileNameInput(nextProfile.displayName || '')
      },
      () => {
        setProfileMessage('Sync profil indisponible temporairement.')
      },
    )

    return () => {
      unsubscribe()
    }
  }, [authUser])

  // Subscription quêtes actives pour le joueur courant
  useEffect(() => {
    if (!authUser || !db) {
      setActiveQuests([])
      return undefined
    }

    const questsQuery = query(
      collection(db, QUESTS_COLLECTION),
      where('status', '==', 'active'),
    )

    const unsubscribe = onSnapshot(
      questsQuery,
      (snapshot) => {
        const allActive = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))
        const mine = allActive.filter(
          (q) => q.assignedToUid === 'all' || q.assignedToUid === authUser.uid,
        )
        setActiveQuests(mine)
      },
      () => {
        // Quêtes non critiques, échec silencieux
      },
    )

    return () => unsubscribe()
  }, [authUser])

  useEffect(() => {
    if (soloPhase !== 'playing' || soloTimeLeft === null || soloTimeLeft <= 0) {
      return undefined
    }

    const timer = window.setInterval(() => {
      setSoloTimeLeft((previous) => {
        if (previous === null) {
          return null
        }
        return Math.max(previous - 1, 0)
      })
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [soloPhase, soloTimeLeft])

  useEffect(() => {
    if (soloPhase === 'playing' && soloTimeLeft === 0) {
      finishSoloRound()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soloPhase, soloTimeLeft])

  useEffect(() => {
    if (soloPhase === 'playing' && answerMode === 'input' && !soloLocked) {
      soloInputRef.current?.focus()
    }
  }, [soloPhase, answerMode, soloLocked, soloQuestion?.id])

  useEffect(() => {
    if (!multiSessionId || !db || !authUser) {
      return undefined
    }

    const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

    const unsubscribe = onSnapshot(
      sessionRef,
      (snapshot) => {
        if (!snapshot.exists()) {
          setMultiStatusMessage('Cette session n existe plus.')
          resetMultiplayerLocalState()
          return
        }

        const nextSession = {
          id: snapshot.id,
          ...snapshot.data(),
          players: snapshot.data().players || {},
        }

        setMultiSession(nextSession)
      },
      () => {
        setMultiStatusMessage('Erreur reseau sur la session multijoueur.')
      },
    )

    return () => {
      unsubscribe()
    }
  }, [multiSessionId, authUser, resetMultiplayerLocalState])

  useEffect(() => {
    if (location.pathname === '/multiplayer') {
      return
    }

    if (multiSessionId && (multiSession?.status === 'playing' || multiSession?.status === 'lobby')) {
      navigate('/multiplayer')
    }
  }, [location.pathname, multiSessionId, multiSession?.status, navigate])

  // Chargement automatique des données admin à l'arrivée sur /admin
  useEffect(() => {
    if (location.pathname === '/admin' && isAdmin) {
      loadAdminProfiles()
      loadAdminQuests()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, isAdmin])

  useEffect(() => {
    if (!multiSession || multiSession.status !== 'playing') {
      return undefined
    }

    const tick = () => {
      const now = Date.now()
      const startsIn = multiSession.startAtMs ? Math.max(0, Math.ceil((multiSession.startAtMs - now) / 1000)) : 0
      setMultiStartsIn(startsIn)

      if (startsIn > 0) {
        setMultiPhaseTimeLeft(null)
        setMultiTimeLeft(multiSession.durationType === 'infinite' ? null : multiSession.durationSeconds)
        return
      }

      if (multiSession.durationType === 'timed' && typeof multiSession.endAtMs === 'number') {
        setMultiTimeLeft(Math.max(0, Math.ceil((multiSession.endAtMs - now) / 1000)))
      } else {
        setMultiTimeLeft(null)
      }

      if ((multiSession.roundState || 'answering') === 'reveal') {
        if (typeof multiSession.revealUntilMs === 'number') {
          setMultiPhaseTimeLeft(Math.max(0, Math.ceil((multiSession.revealUntilMs - now) / 1000)))
        } else {
          setMultiPhaseTimeLeft(0)
        }
      } else {
        const deadline =
          multiSession.durationType === 'timed' && typeof multiSession.endAtMs === 'number'
            ? Math.min(multiSession.roundDeadlineAtMs || Infinity, multiSession.endAtMs)
            : multiSession.roundDeadlineAtMs

        if (typeof deadline === 'number' && Number.isFinite(deadline)) {
          setMultiPhaseTimeLeft(Math.max(0, Math.ceil((deadline - now) / 1000)))
        } else {
          setMultiPhaseTimeLeft(null)
        }
      }

      if (isHost) {
        syncMultiplayerRoundStateByHost(now)
      }
    }

    tick()
    const interval = window.setInterval(tick, 250)

    return () => {
      window.clearInterval(interval)
    }
  }, [multiSession, isHost, syncMultiplayerRoundStateByHost])

  useEffect(() => {
    if (multiSession?.status !== 'playing') {
      return
    }
    setMultiInputAnswer('')
    setMultiSelectedAnswer(null)
    setMultiSubmitting(false)
    setMultiFeedback(null)
  // Intentionally exclude the full multiSession object — only react to structural changes
  // (question index, round state, status). This prevents resetting local UI state when
  // other players submit answers (which only updates roundResponses in Firestore).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiSession?.currentQuestionIndex, multiSession?.roundState, multiSession?.status])

  useEffect(() => {
    if (
      multiSession?.status === 'playing' &&
      (multiSession?.roundState || 'answering') === 'answering' &&
      multiAnswerMode === 'input' &&
      multiStartsIn === 0
    ) {
      multiInputRef.current?.focus()
    }
  }, [multiSession?.status, multiSession?.roundState, multiAnswerMode, multiStartsIn, multiQuestion?.id])

  useEffect(() => {
    if (!multiSession || multiSession.status !== 'finished' || !multiSessionId || !myMultiPlayer || !cloudProfile) {
      return
    }

    if (multiRewardedSessionId === multiSessionId) {
      return
    }

    const starsFromMulti = Math.max(0, Math.round((myMultiPlayer.score || 0) / 3))

    applyProgressToCloud({
      score: myMultiPlayer.score || 0,
      bestStreak: myMultiPlayer.bestStreak || 0,
      correct: myMultiPlayer.correct || 0,
      total: myMultiPlayer.total || 0,
      starsDelta: starsFromMulti,
      modeTitle: multiSession.modeTitle || 'Multijoueur',
      source: 'multi',
    }).catch(() => {
      setMultiStatusMessage('Sync progression multi impossible.')
    })

    setMultiRewardedSessionId(multiSessionId)
  }, [
    multiSession,
    multiSessionId,
    myMultiPlayer,
    multiRewardedSessionId,
    applyProgressToCloud,
    cloudProfile,
  ])

  const handleEmailAuthSubmit = async (event) => {
    event.preventDefault()

    if (!auth || !isFirebaseConfigured) {
      setAuthError('Firebase non configure.')
      return
    }

    setAuthBusy(true)
    setAuthError('')

    try {
      const email = authEmail.trim().toLowerCase()
      const password = authPassword

      if (authMode === 'signup') {
        const displayName = authDisplayName.trim()
        if (displayName.length < 2) {
          throw new Error('Pseudo trop court.')
        }
        if (password !== authPasswordConfirm) {
          throw new Error('Les mots de passe ne correspondent pas.')
        }

        const credential = await createUserWithEmailAndPassword(auth, email, password)
        await updateProfile(credential.user, { displayName })
        await ensureCloudProfile({ ...credential.user, displayName })
      } else {
        await signInWithEmailAndPassword(auth, email, password)
      }

      setAuthPassword('')
      setAuthPasswordConfirm('')
      setAuthError('')
    } catch (error) {
      setAuthError(buildAuthErrorMessage(error, window.location.hostname))
    } finally {
      setAuthBusy(false)
    }
  }

  const handleGoogleSignIn = async () => {
    if (!auth || !isFirebaseConfigured) {
      setAuthError('Firebase non configure.')
      return
    }

    setAuthBusy(true)
    setAuthError('')

    try {
      const provider = new GoogleAuthProvider()
      provider.setCustomParameters({ prompt: 'select_account' })
      await signInWithPopup(auth, provider)
    } catch (error) {
      setAuthError(buildAuthErrorMessage(error, window.location.hostname))
    } finally {
      setAuthBusy(false)
    }
  }

  const retryCloudProfileLoad = async () => {
    if (!authUser) {
      return
    }

    setAuthBusy(true)
    setAuthError('')
    try {
      await ensureCloudProfile(authUser)
    } catch (error) {
      setAuthError(buildProfileLoadErrorMessage(error, window.location.hostname))
    } finally {
      setAuthBusy(false)
    }
  }

  const handleLogout = async () => {
    if (!auth) {
      return
    }

    try {
      await leaveMultiplayerSession(true)
      await signOut(auth)
    } catch {
      setProfileMessage('Deconnexion partielle, recharge la page si besoin.')
    }
  }

  const saveProfileDisplayName = async () => {
    if (!authUser || !db) {
      return
    }

    const nextName = profileNameInput.trim().slice(0, 24)
    if (nextName.length < 2) {
      setProfileMessage('Pseudo trop court.')
      return
    }

    setProfileSaving(true)
    setProfileMessage('')

    try {
      await updateProfile(authUser, { displayName: nextName })
      await updateDoc(doc(db, CLOUD_PROFILE_COLLECTION, authUser.uid), {
        displayName: nextName,
        updatedAtMs: Date.now(),
        updatedAt: serverTimestamp(),
      })
      setProfileMessage('Profil mis a jour.')
    } catch {
      setProfileMessage('Mise a jour impossible pour le moment.')
    } finally {
      setProfileSaving(false)
    }
  }

  // --- Fonctions Admin ---

  async function loadAdminProfiles() {
    if (!db || !isAdmin) {
      return
    }

    setAdminProfilesLoading(true)
    try {
      const snap = await getDocs(collection(db, CLOUD_PROFILE_COLLECTION))
      const profiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      profiles.sort((a, b) => (b.lastPlayedMs || 0) - (a.lastPlayedMs || 0))
      setAdminProfiles(profiles)
    } catch {
      setAdminQuestMessage('Impossible de charger les profils joueurs.')
    } finally {
      setAdminProfilesLoading(false)
    }
  }

  async function loadAdminQuests() {
    if (!db || !isAdmin) {
      return
    }

    try {
      const snap = await getDocs(
        query(collection(db, QUESTS_COLLECTION), where('status', '==', 'active')),
      )
      const quests = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      quests.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
      setAdminQuests(quests)
    } catch {
      setAdminQuestMessage('Impossible de charger les quetes.')
    }
  }

  async function archiveQuest(questId) {
    if (!db || !isAdmin) {
      return
    }

    try {
      await updateDoc(doc(db, QUESTS_COLLECTION, questId), { status: 'archived' })
      setAdminQuests((prev) => prev.filter((q) => q.id !== questId))
    } catch {
      setAdminQuestMessage('Archivage impossible.')
    }
  }

  async function createAdminQuest() {
    if (!db || !isAdmin || !authUser) {
      return
    }

    const {
      title,
      description,
      modeType,
      tables,
      operations,
      mulMin,
      mulMax,
      addMin,
      addMax,
      durationSeconds,
      requiredCompletions,
      requiredScore,
      requiredAnswerMode,
      targetUid,
    } = adminQuestForm

    if (!title.trim()) {
      setAdminQuestMessage('Le titre est requis.')
      return
    }

    const modeConfig =
      modeType === 'tables'
        ? normalizeModeConfig({ type: 'tables', tables })
        : normalizeModeConfig({ type: 'mixed', operations, mulMin, mulMax, addMin, addMax })

    const targetProfile = adminProfiles.find((p) => p.uid === targetUid)
    const assignedToName =
      targetUid === 'all' ? 'Tous les joueurs' : targetProfile?.displayName || targetUid

    setAdminQuestSaving(true)
    setAdminQuestMessage('')

    try {
      const questRef = doc(collection(db, QUESTS_COLLECTION))
      await setDoc(questRef, {
        title: title.trim(),
        description: description.trim(),
        modeConfig,
        durationSeconds: normalizePositiveNumber(durationSeconds, 60, 10, 600),
        requiredCompletions: normalizePositiveNumber(requiredCompletions, 1, 1, 100),
        requiredScore: normalizePositiveNumber(requiredScore, 0, 0, 100000),
        requiredAnswerMode: normalizeQuestAnswerMode(requiredAnswerMode),
        assignedToUid: targetUid,
        assignedToName,
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        createdByUid: authUser.uid,
        status: 'active',
      })

      setAdminQuestMessage(`Quete "${title.trim()}" creee avec succes.`)
      setAdminQuestForm((prev) => ({ ...prev, title: '', description: '' }))
      await loadAdminQuests()
    } catch {
      setAdminQuestMessage('Creation impossible pour le moment.')
    } finally {
      setAdminQuestSaving(false)
    }
  }

  function updateAdminQuestForm(field, value) {
    setAdminQuestForm((prev) => ({ ...prev, [field]: value }))
  }

  function toggleAdminQuestTable(table) {
    setAdminQuestForm((prev) => {
      const next = prev.tables.includes(table)
        ? prev.tables.length === 1
          ? prev.tables
          : prev.tables.filter((t) => t !== table)
        : [...prev.tables, table].sort((a, b) => a - b)
      return { ...prev, tables: next }
    })
  }

  function toggleAdminQuestOperation(op) {
    setAdminQuestForm((prev) => {
      const next = prev.operations.includes(op)
        ? prev.operations.length === 1
          ? prev.operations
          : prev.operations.filter((o) => o !== op)
        : [...prev.operations, op]
      return { ...prev, operations: next }
    })
  }

  function getSoloModeConfig(mode) {
    if (mode.id === 'mental-hard') {
      return buildMentalModeConfig(mentalSettings)
    }

    return normalizeModeConfig(mode.modeConfig)
  }

  function normalizeQuestRun(questOrRun) {
    const questId = questOrRun?.questId || questOrRun?.id || ''
    return {
      questId,
      title: questOrRun?.title || 'Quete',
      description: questOrRun?.description || '',
      modeConfig: normalizeModeConfig(questOrRun?.modeConfig || { type: 'tables', tables: [2, 3, 4, 5] }),
      durationSeconds: normalizePositiveNumber(questOrRun?.durationSeconds, 60, 10, 600),
      requiredCompletions: normalizePositiveNumber(questOrRun?.requiredCompletions, 1, 1, 100),
      requiredScore: normalizePositiveNumber(questOrRun?.requiredScore, 0, 0, 100000),
      requiredAnswerMode: normalizeQuestAnswerMode(questOrRun?.requiredAnswerMode),
    }
  }

  function startQuestRound(questOrRun) {
    const questRun = normalizeQuestRun(questOrRun)
    if (!questRun.questId) {
      return
    }

    if (questRun.requiredAnswerMode !== 'any') {
      setAnswerMode(questRun.requiredAnswerMode)
    }

    startSoloRound(
      {
        id: `quest-${questRun.questId}`,
        title: questRun.title,
        subtitle: questRun.description,
        duration: questRun.durationSeconds,
        modeConfig: questRun.modeConfig,
      },
      {
        modeConfig: questRun.modeConfig,
        duration: questRun.durationSeconds,
        forceInfinite: false,
        questRun,
      },
    )
  }

  function startSoloRound(mode, options = {}) {
    if (soloNextQuestionTimeoutRef.current) {
      window.clearTimeout(soloNextQuestionTimeoutRef.current)
    }

    const modeConfig = options.modeConfig || getSoloModeConfig(mode)
    const runDuration = options.duration ?? mode.duration
    const infinite = options.forceInfinite ?? timeMode === 'infinite'

    setSoloMode(mode)
    setSoloModeConfig(modeConfig)
    setSoloQuestion(buildRandomQuestion(modeConfig))
    setSoloTimeLeft(infinite ? null : runDuration)
    setSoloScore(0)
    setSoloStreak(0)
    setSoloBestStreak(0)
    setSoloCorrect(0)
    setSoloTotal(0)
    setSoloLocked(false)
    setSoloFeedback(null)
    setSoloSelectedAnswer(null)
    setSoloInputAnswer('')
    setSoloStarsEarned(0)
    setSoloProgressSaved(false)
    setActiveQuestRun(options.questRun || null)
    setLastQuestRun(null)
    setSoloPhase('playing')
    navigate('/play')
  }

  function startCustomTablesMode() {
    startSoloRound(
      {
        id: 'custom',
        title: 'Mode Perso',
        subtitle: `Tables ${customTables.join(', ')}`,
        duration: 60,
        modeConfig: { type: 'tables', tables: customTables },
      },
      {
        modeConfig: { type: 'tables', tables: customTables },
        duration: 60,
      },
    )
  }

  async function finishSoloRound() {
    if (soloPhase !== 'playing') {
      return
    }

    if (soloNextQuestionTimeoutRef.current) {
      window.clearTimeout(soloNextQuestionTimeoutRef.current)
    }

    const accuracy = soloTotal === 0 ? 0 : soloCorrect / soloTotal
    const starsEarned = Math.max(1, Math.round(soloScore / 20 + accuracy * 4))
    setSoloStarsEarned(starsEarned)
    setSoloPhase('result')

    // Capturer avant tout await pour éviter les closures périmées
    const completedQuestRun = activeQuestRun
    setLastQuestRun(completedQuestRun || null)
    setActiveQuestRun(null)

    if (!soloProgressSaved && cloudProfile) {
      try {
        await applyProgressToCloud({
          score: soloScore,
          bestStreak: soloBestStreak,
          correct: soloCorrect,
          total: soloTotal,
          starsDelta: starsEarned,
          modeTitle: soloMode.title,
          source: 'solo',
        })
        setSoloProgressSaved(true)
      } catch {
        setSoloFeedback({
          type: 'error',
          title: 'Erreur cloud',
          detail: 'La progression sera synchronisee a la prochaine partie.',
        })
      }
    }

    // Mettre à jour la progression de la quête si une quête était en cours
    if (completedQuestRun?.questId && authUser && db) {
      try {
        const liveQuest = activeQuests.find((q) => q.id === completedQuestRun.questId)
        const resolvedQuest = normalizeQuestRun(liveQuest || completedQuestRun)
        const profileRef = doc(db, CLOUD_PROFILE_COLLECTION, authUser.uid)

        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(profileRef)
          if (!snap.exists()) {
            return
          }

          const data = snap.data()
          const existing = data.questProgress?.[resolvedQuest.questId] || {
            attempts: 0,
            completions: 0,
            bestScore: 0,
            completed: false,
            completedAtMs: null,
          }

          const requiredScore = normalizePositiveNumber(resolvedQuest.requiredScore, 0, 0, 100000)
          const thisRunValidated = soloScore >= requiredScore
          const nextAttempts = (Number(existing.attempts) || Number(existing.completions) || 0) + 1
          const previousCompletions = Number(existing.completions) || 0
          const nextCompletions = existing.completed
            ? previousCompletions
            : previousCompletions + (thisRunValidated ? 1 : 0)
          const nowDone = existing.completed || nextCompletions >= resolvedQuest.requiredCompletions
          const completionDate = existing.completedAtMs || (nowDone ? Date.now() : null)

          transaction.update(profileRef, {
            [`questProgress.${resolvedQuest.questId}`]: {
              attempts: nextAttempts,
              completions: nextCompletions,
              bestScore: Math.max(Number(existing.bestScore) || 0, soloScore),
              lastScore: soloScore,
              lastRunValidated: thisRunValidated,
              completed: nowDone,
              completedAtMs: completionDate,
              requiredCompletions: resolvedQuest.requiredCompletions,
              requiredScore,
            },
            updatedAtMs: Date.now(),
          })
        })
      } catch {
        // Non critique, échec silencieux
      }
    }
  }

  function answerSoloQuestion(selectedValue) {
    if (soloLocked || soloPhase !== 'playing') {
      return
    }

    setSoloLocked(true)
    setSoloSelectedAnswer(selectedValue)
    setSoloTotal((previous) => previous + 1)

    if (selectedValue === soloQuestion.answer) {
      const nextStreak = soloStreak + 1
      const gain = 10 + Math.min(soloStreak * 2, 20)

      setSoloScore((previous) => previous + gain)
      setSoloStreak(nextStreak)
      setSoloBestStreak((previous) => Math.max(previous, nextStreak))
      setSoloCorrect((previous) => previous + 1)
      setSoloFeedback({
        type: 'success',
        title: 'Excellent!',
        detail: `+${gain} points`,
      })
    } else {
      setSoloStreak(0)
      setSoloFeedback({
        type: 'error',
        title: 'Pas cette fois',
        detail: soloQuestion.label,
        correctAnswer: soloQuestion.answer,
      })
    }

    soloNextQuestionTimeoutRef.current = window.setTimeout(() => {
      setSoloQuestion(buildRandomQuestion(soloModeConfig))
      setSoloLocked(false)
      setSoloFeedback(null)
      setSoloSelectedAnswer(null)
      setSoloInputAnswer('')
    }, 1000)
  }

  function handleSoloInputSubmit(event) {
    event.preventDefault()
    if (soloInputAnswer.trim() === '') {
      return
    }

    const parsed = Number(soloInputAnswer)
    if (!Number.isFinite(parsed)) {
      return
    }

    answerSoloQuestion(parsed)
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

  function updateMentalSetting(field, value) {
    setMentalSettings((previous) => {
      const next = {
        ...previous,
        [field]: value,
      }

      const safeMulMin = normalizePositiveNumber(next.mulMin, 6, 1, 200)
      const safeMulMax = normalizePositiveNumber(next.mulMax, 25, safeMulMin, 500)
      const safeAddMin = normalizePositiveNumber(next.addMin, 20, 0, 5000)
      const safeAddMax = normalizePositiveNumber(next.addMax, 300, safeAddMin, 20000)

      return {
        ...next,
        mulMin: safeMulMin,
        mulMax: safeMulMax,
        addMin: safeAddMin,
        addMax: safeAddMax,
      }
    })
  }

  function updateMultiMentalSettingLocal(key, value) {
    setMultiMentalSettingsLocal((prev) => {
      const next = { ...prev, [key]: value }
      const safeMulMin = normalizePositiveNumber(next.mulMin, 6, 1, 200)
      const safeMulMax = normalizePositiveNumber(next.mulMax, 25, safeMulMin, 500)
      const safeAddMin = normalizePositiveNumber(next.addMin, 20, 0, 5000)
      const safeAddMax = normalizePositiveNumber(next.addMax, 300, safeAddMin, 20000)
      return { ...next, mulMin: safeMulMin, mulMax: safeMulMax, addMin: safeAddMin, addMax: safeAddMax }
    })
  }

  function buildMultiModeConfig(mode) {
    if (mode.id === 'mental-hard') {
      return buildMentalModeConfig(multiMentalSettingsLocal)
    }

    return normalizeModeConfig(mode.modeConfig)
  }

  async function createMultiplayerSession() {
    if (!cloudProfile || !db) {
      setMultiStatusMessage('Connexion cloud requise.')
      return
    }

    setMultiBusy(true)
    setMultiStatusMessage('')

    try {
      let createdCode = ''

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const sessionCode = generateSessionCode(6)
        const sessionRef = doc(db, MULTIPLAYER_COLLECTION, sessionCode)
        const existing = await getDoc(sessionRef)

        if (existing.exists()) {
          continue
        }

        const selectedMode = getModeById(multiModeId)
        const modeConfig = buildMultiModeConfig(selectedMode)
        const answerWindowMs = normalizePositiveNumber(multiAnswerWindowSeconds, 8, 2, 60) * 1000
        const revealCooldownMs = normalizePositiveNumber(multiRevealCooldownSeconds, 2, 1, 15) * 1000

        await setDoc(sessionRef, {
          status: 'lobby',
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          hostPlayerId: devicePlayerId,
          hostUid: cloudProfile.uid,
          hostName: cloudProfile.displayName,
          modeId: selectedMode.id,
          modeTitle: selectedMode.title,
          modeConfig,
          durationType: multiDurationType,
          durationSeconds: multiDurationType === 'infinite' ? null : normalizePositiveNumber(multiCustomDurationSeconds, selectedMode.duration, 10, 3600),
          answerWindowMs,
          revealCooldownMs,
          answerMode,
          seed: createSessionSeed(),
          startAtMs: null,
          endAtMs: null,
          finishedAtMs: null,
          currentQuestionIndex: 0,
          roundState: 'waiting',
          questionOpenedAtMs: null,
          roundDeadlineAtMs: null,
          revealUntilMs: null,
          roundResponses: {},
          lastRoundSummary: null,
          lastWinnerUid: null,
          lastWinnerName: null,
          lastWinnerAtMs: null,
          lastWinnerAnswer: null,
          lastWinnerQuestionLabel: null,
          players: {
            [devicePlayerId]: createSessionPlayer(cloudProfile, devicePlayerId),
          },
        })

        createdCode = sessionCode
        break
      }

      if (!createdCode) {
        throw new Error('session-create-failed')
      }

      setJoinCodeInput(createdCode)
      setMultiSessionId(createdCode)
      setMultiRewardedSessionId('')
      navigate('/multiplayer')
    } catch {
      setMultiStatusMessage('Creation de session impossible pour le moment.')
    } finally {
      setMultiBusy(false)
    }
  }

  async function joinMultiplayerSession() {
    if (!cloudProfile || !db) {
      setMultiStatusMessage('Connexion cloud requise.')
      return
    }

    const normalizedCode = normalizeSessionCode(joinCodeInput)
    setJoinCodeInput(normalizedCode)

    if (normalizedCode.length !== 6) {
      setMultiStatusMessage('Code invalide, 6 caracteres requis.')
      return
    }

    setMultiBusy(true)
    setMultiStatusMessage('')

    try {
      const sessionRef = doc(db, MULTIPLAYER_COLLECTION, normalizedCode)
      const snapshot = await getDoc(sessionRef)
      if (!snapshot.exists()) {
        throw new Error('missing')
      }

      const data = snapshot.data()
      const existingPlayer = data.players?.[devicePlayerId] || null

      if (data.status === 'finished') {
        throw new Error('finished')
      }

      if (data.status === 'playing' && !existingPlayer) {
        throw new Error('already-started')
      }

      await updateDoc(sessionRef, {
        [`players.${devicePlayerId}`]: createSessionPlayer(cloudProfile, devicePlayerId, existingPlayer),
      })

      setMultiSessionId(normalizedCode)
      setMultiRewardedSessionId('')
      navigate('/multiplayer')
    } catch (error) {
      if (error instanceof Error && error.message === 'already-started') {
        setMultiStatusMessage('La session a deja commence.')
      } else if (error instanceof Error && error.message === 'finished') {
        setMultiStatusMessage('Cette session est terminee.')
      } else {
        setMultiStatusMessage('Impossible de rejoindre cette session.')
      }
    } finally {
      setMultiBusy(false)
    }
  }

  async function startMultiplayerRace() {
    if (!db || !multiSession || !multiSessionId || !isHost) {
      return
    }

    const activePlayerIds = getActivePlayerEntries(multiSession.players || {}).map(([playerId]) => playerId)
    if (activePlayerIds.length < 2) {
      setMultiStatusMessage('Il faut au moins 2 joueurs actifs.')
      return
    }

    const now = Date.now()
    const startAtMs = now + 3000
    const answerWindowMs = Math.max(2000, Number(multiSession.answerWindowMs) || 8000)
    const revealCooldownMs = Math.max(600, Number(multiSession.revealCooldownMs) || 2000)
    const endAtMs =
      multiSession.durationType === 'timed' && typeof multiSession.durationSeconds === 'number'
        ? startAtMs + multiSession.durationSeconds * 1000
        : null

    const resetPlayers = { ...(multiSession.players || {}) }
    activePlayerIds.forEach((playerId) => {
      const previous = resetPlayers[playerId]
      resetPlayers[playerId] = {
        ...previous,
        score: 0,
        streak: 0,
        bestStreak: 0,
        correct: 0,
        total: 0,
        questionWins: 0,
        lastUpdateMs: now,
        leftAtMs: null,
      }
    })

    try {
      await updateDoc(doc(db, MULTIPLAYER_COLLECTION, multiSessionId), {
        status: 'playing',
        seed: createSessionSeed(),
        startAtMs,
        endAtMs,
        finishedAtMs: null,
        currentQuestionIndex: 0,
        roundState: 'answering',
        questionOpenedAtMs: startAtMs,
        roundDeadlineAtMs: startAtMs + answerWindowMs,
        revealUntilMs: null,
        roundResponses: {},
        lastRoundSummary: null,
        answerWindowMs,
        revealCooldownMs,
        lastWinnerUid: null,
        lastWinnerName: null,
        lastWinnerAtMs: null,
        lastWinnerAnswer: null,
        lastWinnerQuestionLabel: null,
        players: resetPlayers,
      })
      setMultiStatusMessage('Course lancee. Top depart dans 3s.')
    } catch {
      setMultiStatusMessage('Impossible de lancer la course.')
    }
  }

  async function submitMultiplayerAnswer(rawValue) {
    if (!db || !multiSession || !multiSessionId || !cloudProfile || !multiQuestion || multiSubmitting || multiStartsIn > 0) {
      return
    }

    if ((multiSession.roundState || 'answering') !== 'answering') {
      return
    }

    const answerValue = Number(rawValue)
    if (!Number.isFinite(answerValue)) {
      return
    }

    setMultiSubmitting(true)
    setMultiSelectedAnswer(answerValue)

    const expectedQuestionIndex = multiSession.currentQuestionIndex || 0
    const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

    try {
      const result = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(sessionRef)
        if (!snapshot.exists()) {
          return { kind: 'missing' }
        }

        const data = snapshot.data()
        if (data.status !== 'playing') {
          return { kind: 'closed' }
        }

        const now = Date.now()
        if (data.startAtMs && now < data.startAtMs) {
          return { kind: 'wait' }
        }

        const timedRace = data.durationType === 'timed' && typeof data.endAtMs === 'number'
        if (timedRace && now >= data.endAtMs) {
          return { kind: 'closed' }
        }

        const currentIndex = data.currentQuestionIndex || 0
        if (currentIndex !== expectedQuestionIndex || (data.roundState || 'answering') !== 'answering') {
          return { kind: 'phase-changed' }
        }

        const currentQuestion = buildSeededQuestion(data.modeConfig, data.seed, currentIndex)

        const roundDeadline = timedRace
          ? Math.min(data.roundDeadlineAtMs || Number.POSITIVE_INFINITY, data.endAtMs)
          : data.roundDeadlineAtMs

        if (typeof roundDeadline === 'number' && Number.isFinite(roundDeadline) && now > roundDeadline) {
          return { kind: 'timeout' }
        }

        const players = { ...(data.players || {}) }
        if (!players[devicePlayerId]) {
          players[devicePlayerId] = createSessionPlayer(cloudProfile, devicePlayerId)
        }

        const roundResponses = { ...(data.roundResponses || {}) }
        if (roundResponses[devicePlayerId]) {
          return { kind: 'already-answered' }
        }

        const openedAtMs = typeof data.questionOpenedAtMs === 'number' ? data.questionOpenedAtMs : now
        const isCorrect = answerValue === currentQuestion.answer

        roundResponses[devicePlayerId] = {
          playerId: devicePlayerId,
          uid: cloudProfile.uid,
          name: cloudProfile.displayName,
          answer: answerValue,
          isCorrect,
          answeredAtMs: now,
          latencyMs: Math.max(0, now - openedAtMs),
        }

        const activePlayerEntries = getActivePlayerEntries(players)
        const activePlayerIds = activePlayerEntries.map(([playerId]) => playerId)
        const answeredCount = activePlayerIds.filter((playerId) => Boolean(roundResponses[playerId])).length
        const allAnswered = activePlayerIds.length > 0 && answeredCount >= activePlayerIds.length

        if (allAnswered) {
          const { players: resolvedPlayers, summary, question } = computeRoundResolution(
            {
              ...data,
              players,
              roundResponses,
            },
            now,
          )

          const revealCooldownMs = Math.max(600, Number(data.revealCooldownMs) || 2000)
          transaction.update(sessionRef, {
            players: resolvedPlayers,
            roundState: 'reveal',
            roundResponses: {},
            revealUntilMs: now + revealCooldownMs,
            lastRoundSummary: summary,
            lastWinnerUid: summary.winnerUid,
            lastWinnerName: summary.winnerName,
            lastWinnerAtMs: now,
            lastWinnerAnswer: question.answer,
            lastWinnerQuestionLabel: question.label,
          })

          return {
            kind: 'round-resolved',
            isCorrect,
          }
        }

        transaction.update(sessionRef, {
          players,
          roundResponses,
        })

        return {
          kind: 'accepted',
          isCorrect,
        }
      })

      if (result.kind === 'accepted') {
        setMultiFeedback({
          type: result.isCorrect ? 'success' : 'error',
          title: result.isCorrect ? 'Bonne reponse envoyee' : 'Reponse envoyee',
          detail: result.isCorrect
            ? 'Tu peux prendre des points de vitesse.'
            : 'Attends la resolution du round.',
        })
      } else if (result.kind === 'round-resolved') {
        setMultiFeedback({
          type: result.isCorrect ? 'success' : 'error',
          title: 'Round resolu',
          detail: 'Tous les joueurs ont repondu.',
        })
      } else if (result.kind === 'already-answered') {
        setMultiFeedback({
          type: 'error',
          title: 'Deja repondu',
          detail: 'Attends la resolution du round.',
        })
      } else if (result.kind === 'phase-changed' || result.kind === 'timeout') {
        setMultiFeedback({
          type: 'error',
          title: 'Round clos',
          detail: 'Resultat en cours de calcul...',
        })
      } else if (result.kind === 'wait') {
        setMultiFeedback({
          type: 'error',
          title: 'Depart imminent',
          detail: 'Attends le top depart.',
        })
      } else {
        setMultiFeedback({
          type: 'error',
          title: 'Course terminee',
          detail: 'Le round est fini.',
        })
      }
    } catch {
      setMultiFeedback({
        type: 'error',
        title: 'Erreur reseau',
        detail: 'Reessaie ta reponse.',
      })
    } finally {
      setMultiSubmitting(false)
      setMultiInputAnswer('')
    }
  }

  function handleMultiInputSubmit(event) {
    event.preventDefault()
    if (multiInputAnswer.trim() === '') {
      return
    }

    submitMultiplayerAnswer(Number(multiInputAnswer))
  }

  async function finishMultiplayerSession() {
    if (!db || !multiSessionId || !isHost) {
      return
    }

    try {
      await updateDoc(doc(db, MULTIPLAYER_COLLECTION, multiSessionId), {
        status: 'finished',
        finishedAtMs: Date.now(),
      })
    } catch {
      setMultiStatusMessage('Impossible de terminer la course.')
    }
  }

  async function leaveMultiplayerSession(silent = false) {
    const sessionToLeave = multiSession

    if (db && multiSessionId && sessionToLeave) {
      const sessionRef = doc(db, MULTIPLAYER_COLLECTION, multiSessionId)

      try {
        if (sessionToLeave.status === 'lobby') {
          const otherPlayers = getActivePlayerEntries(sessionToLeave.players || {}).filter(
            ([playerId]) => playerId !== devicePlayerId,
          )

          if (otherPlayers.length === 0) {
            await deleteDoc(sessionRef)
          } else {
            const payload = {
              [`players.${devicePlayerId}`]: deleteField(),
            }

            if (sessionToLeave.hostPlayerId === devicePlayerId) {
              payload.hostPlayerId = otherPlayers[0][0]
              payload.hostUid = otherPlayers[0][1].uid
              payload.hostName = otherPlayers[0][1].name
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
        if (!silent) {
          setMultiStatusMessage('Sortie partielle, recharge si necessaire.')
        }
      }
    }

    resetMultiplayerLocalState()
  }

  async function copySessionCode() {
    if (!multiSessionId) {
      return
    }

    try {
      await navigator.clipboard.writeText(multiSessionId)
      setMultiStatusMessage(`Code ${multiSessionId} copie.`)
    } catch {
      setMultiStatusMessage('Copie impossible, partage manuellement.')
    }
  }

  if (authLoading) {
    return (
      <main className="app-shell">
        <div className="bg-shape bg-shape-top" />
        <div className="bg-shape bg-shape-bottom" />
        <section className="panel panel-login">
          <p className="eyebrow">Chargement</p>
          <h2>Connexion en cours...</h2>
        </section>
      </main>
    )
  }

  if (!isFirebaseConfigured) {
    return (
      <main className="app-shell">
        <div className="bg-shape bg-shape-top" />
        <div className="bg-shape bg-shape-bottom" />
        <section className="panel panel-login">
          <p className="eyebrow">Configuration requise</p>
          <h2>Firebase n est pas configure</h2>
          <p className="muted">Ajoute les variables `VITE_FIREBASE_*` pour activer les comptes cloud et le multijoueur.</p>
        </section>
      </main>
    )
  }

  if (!authUser) {
    return (
      <main className="app-shell">
        <div className="bg-shape bg-shape-top" />
        <div className="bg-shape bg-shape-bottom" />
        <AuthView
          authBusy={authBusy}
          authError={authError}
          authMode={authMode}
          setAuthMode={setAuthMode}
          authEmail={authEmail}
          setAuthEmail={setAuthEmail}
          authPassword={authPassword}
          setAuthPassword={setAuthPassword}
          authPasswordConfirm={authPasswordConfirm}
          setAuthPasswordConfirm={setAuthPasswordConfirm}
          authDisplayName={authDisplayName}
          setAuthDisplayName={setAuthDisplayName}
          onEmailSubmit={handleEmailAuthSubmit}
          onGoogleSignIn={handleGoogleSignIn}
        />
      </main>
    )
  }

  if (!cloudProfile) {
    return (
      <main className="app-shell">
        <div className="bg-shape bg-shape-top" />
        <div className="bg-shape bg-shape-bottom" />
        <section className="panel panel-login auth-panel">
          <p className="eyebrow">Connexion valide</p>
          <h2>Compte connecte, profil cloud en attente</h2>
          <p className="muted">
            Tu es bien connecte, mais le profil Firestore n est pas encore accessible.
          </p>

          {authError && <p className="auth-error">{authError}</p>}

          <div className="result-actions">
            <button type="button" className="btn-primary" onClick={retryCloudProfileLoad} disabled={authBusy}>
              {authBusy ? 'Verification...' : 'Reessayer'}
            </button>
            <button type="button" className="btn-soft" onClick={handleLogout} disabled={authBusy}>
              Se deconnecter
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <div className="bg-shape bg-shape-top" />
      <div className="bg-shape bg-shape-bottom" />

      <div className="page-container">
        <header className="site-nav">
          <div className="nav-brand">
            <p className="eyebrow">TABLE QUEST</p>
            <strong>Cloud</strong>
          </div>

          <nav className="nav-links">
            <NavLink to="/" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Accueil
            </NavLink>
            <NavLink to="/play" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Jouer
            </NavLink>
            <NavLink to="/quests" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Quetes
            </NavLink>
            <NavLink to="/multiplayer" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Multijoueur
            </NavLink>
            <NavLink to="/memory" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Mémoire
            </NavLink>
            <NavLink to="/profile" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
              Profil
            </NavLink>
            {isAdmin && (
              <NavLink
                to="/admin"
                className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
                style={{ color: '#c46210' }}
              >
                Admin
              </NavLink>
            )}
          </nav>

          <div className="nav-user">
            <span>{cloudProfile.displayName}</span>
            <button type="button" className="btn-soft" onClick={handleLogout}>
              Deconnexion
            </button>
          </div>
        </header>

        <Routes>
          <Route
            path="/"
            element={
              <section className="panel panel-home">
                <header className="home-header">
                  <div>
                    <p className="eyebrow">Salut {cloudProfile.displayName}</p>
                    <h2>Choisis ton mode de jeu</h2>
                  </div>
                  <button type="button" className="btn-soft" onClick={() => navigate('/profile')}>
                    Voir mon profil
                  </button>
                </header>

                <div className="stats-grid">
                  <article className="stat-card">
                    <p>Record global</p>
                    <strong>{cloudProfile.bestScore || 0}</strong>
                  </article>
                  <article className="stat-card">
                    <p>Serie max globale</p>
                    <strong>{cloudProfile.bestStreak || 0}</strong>
                  </article>
                  <article className="stat-card">
                    <p>Etoiles globales</p>
                    <strong>{cloudProfile.stars || 0}</strong>
                  </article>
                  <article className="stat-card">
                    <p>Precision globale</p>
                    <strong>{globalAccuracy}%</strong>
                  </article>
                </div>

                <article className="answer-mode-panel">
                  <p className="custom-title">Type de reponse</p>
                  <p className="muted">QCM ou reponse ecrite.</p>
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

                <article className="answer-mode-panel">
                  <p className="custom-title">Temps</p>
                  <p className="muted">Joue avec chrono ou en mode infini.</p>
                  <div className="time-mode-options">
                    <button
                      type="button"
                      className={timeMode === 'timed' ? 'time-mode-btn active' : 'time-mode-btn'}
                      onClick={() => setTimeMode('timed')}
                    >
                      Chrono normal
                    </button>
                    <button
                      type="button"
                      className={timeMode === 'infinite' ? 'time-mode-btn active' : 'time-mode-btn'}
                      onClick={() => setTimeMode('infinite')}
                    >
                      Temps infini
                    </button>
                  </div>
                </article>

                <article className="custom-mode">
                  <p className="custom-title">Calcul mental difficile (personnalise)</p>
                  <p className="muted">Parametres utilises aussi en multi si ce mode est choisi.</p>
                  <div className="mental-grid">
                    <label className="toggle-line">
                      <input
                        type="checkbox"
                        checked={mentalSettings.includeMul}
                        onChange={(event) => updateMentalSetting('includeMul', event.target.checked)}
                      />
                      Multiplications actives
                    </label>
                    <label className="toggle-line">
                      <input
                        type="checkbox"
                        checked={mentalSettings.includeAdd}
                        onChange={(event) => updateMentalSetting('includeAdd', event.target.checked)}
                      />
                      Additions actives
                    </label>
                    <label className="stack-label">
                      Multiplication min
                      <input
                        type="number"
                        min="1"
                        max="200"
                        value={mentalSettings.mulMin}
                        onChange={(event) => updateMentalSetting('mulMin', event.target.value)}
                      />
                    </label>
                    <label className="stack-label">
                      Multiplication max
                      <input
                        type="number"
                        min={mentalSettings.mulMin}
                        max="500"
                        value={mentalSettings.mulMax}
                        onChange={(event) => updateMentalSetting('mulMax', event.target.value)}
                      />
                    </label>
                    <label className="stack-label">
                      Addition min
                      <input
                        type="number"
                        min="0"
                        max="5000"
                        value={mentalSettings.addMin}
                        onChange={(event) => updateMentalSetting('addMin', event.target.value)}
                      />
                    </label>
                    <label className="stack-label">
                      Addition max
                      <input
                        type="number"
                        min={mentalSettings.addMin}
                        max="20000"
                        value={mentalSettings.addMax}
                        onChange={(event) => updateMentalSetting('addMax', event.target.value)}
                      />
                    </label>
                  </div>
                </article>

                <article className="custom-mode quest-summary-card">
                  <p className="custom-title">Quetes</p>
                  <p className="muted">Page dediee pour suivre tes objectifs et les continuer.</p>
                  <p className="quest-progress-label">
                    {activeQuests.length} active{activeQuests.length > 1 ? 's' : ''} &middot; {completedActiveQuests} completee
                    {completedActiveQuests > 1 ? 's' : ''}
                  </p>
                  <button type="button" className="btn-primary" onClick={() => navigate('/quests')}>
                    Ouvrir mes quetes
                  </button>
                </article>

                <div className="mode-grid">
                  {GAME_MODES.map((mode) => (
                    <article key={mode.id} className="mode-card">
                      <h3>{mode.title}</h3>
                      <p>{mode.subtitle}</p>
                      <span>{timeMode === 'infinite' ? 'Infini' : `${mode.duration}s`}</span>
                      <button type="button" className="btn-primary" onClick={() => startSoloRound(mode)}>
                        Jouer
                      </button>
                    </article>
                  ))}
                </div>

                <article className="custom-mode">
                  <p className="custom-title">Mode personnalise (tables)</p>
                  <p className="muted">Choisis les tables a travailler.</p>
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
                  <button type="button" className="btn-primary" onClick={startCustomTablesMode}>
                    Lancer mode perso
                  </button>
                </article>

                <article className="multiplayer-panel">
                  <div className="leaderboard-head">
                    <h3>Multijoueur synchronise</h3>
                    <p>round partage + points de vitesse</p>
                  </div>
                  <p className="small-note">Cree ou rejoins une session depuis la page Multijoueur.</p>
                  <button type="button" className="btn-primary" onClick={() => navigate('/multiplayer')}>
                    Aller au mode multijoueur
                  </button>
                </article>
              </section>
            }
          />

          <Route
            path="/quests"
            element={
              <section className="panel panel-home panel-quests">
                <header className="home-header">
                  <div>
                    <p className="eyebrow">Mes quetes</p>
                    <h2>Objectifs du joueur</h2>
                  </div>
                  <button type="button" className="btn-soft" onClick={() => navigate('/')}>
                    Retour accueil
                  </button>
                </header>

                {activeQuests.length === 0 && (
                  <article className="custom-mode">
                    <p className="custom-title">Aucune quete active</p>
                    <p className="muted">Ton admin peut t en assigner depuis le panneau Administration.</p>
                  </article>
                )}

                {activeQuests.length > 0 && (
                  <div className="quest-list">
                    {activeQuests.map((quest) => {
                      const requiredCompletions = normalizePositiveNumber(quest.requiredCompletions, 1, 1, 100)
                      const requiredScore = normalizePositiveNumber(quest.requiredScore, 0, 0, 100000)
                      const progress = cloudProfile.questProgress?.[quest.id] || {
                        attempts: 0,
                        completions: 0,
                        bestScore: 0,
                        completed: false,
                      }
                      const validatedCompletions = Number(progress.completions) || 0
                      const attempts = Number(progress.attempts) || validatedCompletions
                      const bestScore = Number(progress.bestScore) || 0
                      const pct = Math.min(100, Math.round((validatedCompletions / requiredCompletions) * 100))
                      const modeLabel =
                        quest.modeConfig.type === 'tables'
                          ? `Tables : ${quest.modeConfig.tables.join(', ')}`
                          : 'Calcul mental'
                      const answerConstraint = getQuestAnswerModeLabel(quest.requiredAnswerMode)
                      const isCompleted = Boolean(progress.completed)

                      return (
                        <article key={quest.id} className={isCompleted ? 'quest-card quest-card--done' : 'quest-card'}>
                          <div className="quest-card-header">
                            <div>
                              <p className="custom-title">{quest.title}</p>
                              {quest.description && <p className="muted">{quest.description}</p>}
                            </div>
                            {isCompleted && <span className="quest-check">&#10003;</span>}
                          </div>

                          <p className="quest-meta">
                            {modeLabel} &middot; {normalizePositiveNumber(quest.durationSeconds, 60, 10, 600)}s
                          </p>
                          <p className="quest-meta">Reponse: {answerConstraint}</p>
                          <p className="quest-meta">
                            Validation: score mini {requiredScore} &middot; {requiredCompletions} partie
                            {requiredCompletions > 1 ? 's' : ''} valide
                            {requiredCompletions > 1 ? 'es' : 'e'}
                          </p>

                          <div className="quest-progress-bar">
                            <div className="quest-progress-fill" style={{ width: `${pct}%` }} />
                          </div>

                          <p className="quest-progress-label">
                            Validees: {validatedCompletions}/{requiredCompletions} &middot; Tentatives: {attempts} &middot; Meilleur score:{' '}
                            {bestScore}
                          </p>

                          <button type="button" className="btn-primary" onClick={() => startQuestRound(quest)}>
                            {isCompleted ? 'Rejouer la quete' : 'Continuer la quete'}
                          </button>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            }
          />

          <Route
            path="/play"
            element={
              <section className="panel panel-game">
                {soloPhase === 'idle' && (
                  <div className="empty-state">
                    <p className="eyebrow">Pret a jouer</p>
                    <h2>Choisis un mode sur l accueil</h2>
                    <button type="button" className="btn-primary" onClick={() => navigate('/')}>
                      Retour accueil
                    </button>
                  </div>
                )}

                {soloPhase === 'playing' && (
                  <>
                    <header className="game-top">
                      <div className="pill">{soloTimeLeft === null ? 'Temps infini' : `Temps ${soloTimeLeft}s`}</div>
                      <div className="pill">Score {soloScore}</div>
                      <div className="pill">Serie {soloStreak}</div>
                    </header>

                    <article className="question-card">
                      <p className="eyebrow">{soloMode.title}</p>
                      <h2>
                        {soloQuestion.left} {soloQuestion.operator} {soloQuestion.right}
                      </h2>
                      <p className="muted">
                        {answerMode === 'choices' ? 'Choisis la bonne reponse.' : 'Ecris la reponse puis valide.'}
                      </p>
                    </article>

                    {answerMode === 'choices' ? (
                      <div className="answers-grid">
                        {soloQuestion.options.map((option) => {
                          let buttonClass = 'answer-btn'
                          if (soloLocked && soloSelectedAnswer === option && option === soloQuestion.answer) {
                            buttonClass += ' picked-correct'
                          } else if (soloLocked && soloSelectedAnswer === option && option !== soloQuestion.answer) {
                            buttonClass += ' picked-wrong'
                          }

                          if (soloLocked && soloFeedback?.type === 'error' && option === soloQuestion.answer) {
                            buttonClass += ' reveal-correct'
                          }

                          return (
                            <button
                              key={`${soloQuestion.id}-${option}`}
                              type="button"
                              className={buttonClass}
                              disabled={soloLocked}
                              onClick={() => answerSoloQuestion(option)}
                            >
                              {option}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <form className="input-answer-form" onSubmit={handleSoloInputSubmit}>
                        <input
                          ref={soloInputRef}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          className="input-answer"
                          placeholder="Ta reponse"
                          value={soloInputAnswer}
                          onChange={(event) => setSoloInputAnswer(event.target.value)}
                          disabled={soloLocked}
                        />
                        <button type="submit" className="btn-primary" disabled={soloLocked}>
                          Valider
                        </button>
                      </form>
                    )}

                    <article className={soloFeedback ? `feedback-card active ${soloFeedback.type}` : 'feedback-card'}>
                      {soloFeedback ? (
                        <>
                          <p className="feedback-title">{soloFeedback.title}</p>
                          {soloFeedback.type === 'success' ? (
                            <p className="feedback-points">{soloFeedback.detail}</p>
                          ) : (
                            <p className="feedback-answer">
                              Bonne reponse: <strong>{soloFeedback.detail}</strong> = <b>{soloFeedback.correctAnswer}</b>
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="feedback-placeholder">Reponds pour faire monter ton score.</p>
                      )}
                    </article>

                    <footer className="game-footer">
                      <p>
                        Bonnes reponses {soloCorrect}/{soloTotal} ({soloAccuracyRate}%)
                      </p>
                      <button type="button" className="btn-soft" onClick={finishSoloRound}>
                        Terminer
                      </button>
                    </footer>
                  </>
                )}

                {soloPhase === 'result' && (
                  <>
                    <p className="eyebrow">Fin de partie</p>
                    <h2>Bien joue {cloudProfile.displayName}</h2>

                    <div className="result-grid">
                      <article className="result-card">
                        <p>Score</p>
                        <strong>{soloScore}</strong>
                      </article>
                      <article className="result-card">
                        <p>Precision</p>
                        <strong>{soloAccuracyRate}%</strong>
                      </article>
                      <article className="result-card">
                        <p>Serie max</p>
                        <strong>{soloBestStreak}</strong>
                      </article>
                      <article className="result-card">
                        <p>Etoiles gagnees</p>
                        <strong>+{soloStarsEarned}</strong>
                      </article>
                    </div>

                    <p className="muted">
                      Record cloud actuel: <strong>{Math.max(cloudProfile.bestScore || 0, soloScore)}</strong>
                    </p>
                    {lastQuestRun && (
                      <p className="muted">
                        Quete en cours: <strong>{lastQuestRun.title}</strong>. Rejouer continue cette quete.
                      </p>
                    )}

                    <div className="result-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          if (lastQuestRun) {
                            startQuestRound(lastQuestRun)
                            return
                          }
                          startSoloRound(soloMode)
                        }}
                      >
                        {lastQuestRun ? 'Continuer la quete' : 'Rejouer'}
                      </button>
                      <button
                        type="button"
                        className="btn-soft"
                        onClick={() => {
                          setSoloPhase('idle')
                          navigate('/')
                        }}
                      >
                        Retour accueil
                      </button>
                    </div>
                  </>
                )}
              </section>
            }
          />

          <Route
            path="/multiplayer"
            element={
              <section className="panel panel-multi-lobby">
                {!multiSessionId && (
                  <>
                    <p className="eyebrow">Mode multijoueur</p>
                    <h2>Sessions cloud synchronisees</h2>
                    <p className="muted">Meme question pour tous, points selon vitesse des bonnes reponses.</p>

                    <article className="multiplayer-panel">
                      <div className="multiplayer-setup-grid">
                        <label className="stack-label">
                          Mode de course
                          <select
                            value={multiModeId}
                            onChange={(event) => {
                              setMultiModeId(event.target.value)
                              setMultiCustomDurationSeconds(getModeById(event.target.value).duration)
                            }}
                            disabled={multiBusy}
                          >
                            {GAME_MODES.map((mode) => (
                              <option key={mode.id} value={mode.id}>
                                {mode.title}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="stack-label">
                          Type de reponse
                          <select value={answerMode} onChange={(event) => setAnswerMode(event.target.value)} disabled={multiBusy}>
                            {ANSWER_MODES.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.title}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="stack-label">
                          Duree de course
                          <select
                            value={multiDurationType}
                            onChange={(event) => setMultiDurationType(event.target.value)}
                            disabled={multiBusy}
                          >
                            <option value="timed">Chrono normal</option>
                            <option value="infinite">Temps infini</option>
                          </select>
                        </label>

                        {multiDurationType === 'timed' && (
                          <label className="stack-label">
                            Duree (secondes)
                            <input
                              type="number"
                              min="10"
                              max="3600"
                              step="10"
                              value={multiCustomDurationSeconds}
                              onChange={(event) =>
                                setMultiCustomDurationSeconds(normalizePositiveNumber(event.target.value, selectedMultiMode.duration, 10, 3600))
                              }
                              disabled={multiBusy}
                            />
                          </label>
                        )}

                        <label className="stack-label">
                          Temps par reponse (sec)
                          <input
                            type="number"
                            min="2"
                            max="60"
                            value={multiAnswerWindowSeconds}
                            onChange={(event) =>
                              setMultiAnswerWindowSeconds(normalizePositiveNumber(event.target.value, 8, 2, 60))
                            }
                            disabled={multiBusy}
                          />
                        </label>

                        <label className="stack-label">
                          Affichage resultat (sec)
                          <input
                            type="number"
                            min="1"
                            max="15"
                            value={multiRevealCooldownSeconds}
                            onChange={(event) =>
                              setMultiRevealCooldownSeconds(normalizePositiveNumber(event.target.value, 2, 1, 15))
                            }
                            disabled={multiBusy}
                          />
                        </label>

                        <label className="stack-label">
                          Code pour rejoindre
                          <input
                            value={joinCodeInput}
                            onChange={(event) => setJoinCodeInput(normalizeSessionCode(event.target.value))}
                            placeholder="Ex: 9F7QK2"
                            maxLength={6}
                            disabled={multiBusy}
                          />
                        </label>
                      </div>

                      {multiModeId === 'mental-hard' && (
                        <div className="multi-mental-settings">
                          <p className="multi-mental-title">Reglages calcul mental</p>
                          <div className="mental-grid">
                            <label className="toggle-line">
                              <input
                                type="checkbox"
                                checked={multiMentalSettingsLocal.includeMul}
                                onChange={(e) => updateMultiMentalSettingLocal('includeMul', e.target.checked)}
                                disabled={multiBusy}
                              />
                              Multiplications
                            </label>
                            <label className="toggle-line">
                              <input
                                type="checkbox"
                                checked={multiMentalSettingsLocal.includeAdd}
                                onChange={(e) => updateMultiMentalSettingLocal('includeAdd', e.target.checked)}
                                disabled={multiBusy}
                              />
                              Additions
                            </label>
                            <label className="stack-label">
                              Mul min
                              <input
                                type="number"
                                min="1"
                                max="200"
                                value={multiMentalSettingsLocal.mulMin}
                                onChange={(e) => updateMultiMentalSettingLocal('mulMin', Number(e.target.value))}
                                disabled={multiBusy}
                              />
                            </label>
                            <label className="stack-label">
                              Mul max
                              <input
                                type="number"
                                min={multiMentalSettingsLocal.mulMin}
                                max="500"
                                value={multiMentalSettingsLocal.mulMax}
                                onChange={(e) => updateMultiMentalSettingLocal('mulMax', Number(e.target.value))}
                                disabled={multiBusy}
                              />
                            </label>
                            <label className="stack-label">
                              Add min
                              <input
                                type="number"
                                min="0"
                                max="5000"
                                value={multiMentalSettingsLocal.addMin}
                                onChange={(e) => updateMultiMentalSettingLocal('addMin', Number(e.target.value))}
                                disabled={multiBusy}
                              />
                            </label>
                            <label className="stack-label">
                              Add max
                              <input
                                type="number"
                                min={multiMentalSettingsLocal.addMin}
                                max="20000"
                                value={multiMentalSettingsLocal.addMax}
                                onChange={(e) => updateMultiMentalSettingLocal('addMax', Number(e.target.value))}
                                disabled={multiBusy}
                              />
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="multiplayer-actions">
                        <button type="button" className="btn-primary" onClick={createMultiplayerSession} disabled={multiBusy}>
                          {multiBusy ? 'Patiente...' : 'Creer la session'}
                        </button>
                        <button type="button" className="btn-soft" onClick={joinMultiplayerSession} disabled={multiBusy}>
                          Rejoindre avec code
                        </button>
                      </div>

                      {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
                    </article>
                  </>
                )}

                {multiSessionId && multiSession?.status === 'lobby' && (
                  <>
                    <p className="eyebrow">Session multijoueur</p>
                    <h2>Salle de course</h2>

                    <div className="lobby-code-wrap">
                      <p>Code a partager</p>
                      <strong>{multiSessionId}</strong>
                      <button type="button" className="btn-soft" onClick={copySessionCode}>
                        Copier
                      </button>
                    </div>

                    <div className="lobby-meta">
                      <p>
                        Mode: <strong>{multiSession.modeTitle}</strong>
                      </p>
                      <p>
                        Reponse: <strong>{multiSession.answerMode === 'choices' ? 'QCM' : 'Ecrite'}</strong>
                      </p>
                      <p>
                        Duree: <strong>{multiSession.durationType === 'infinite' ? 'Infini' : `${multiSession.durationSeconds}s`}</strong>
                      </p>
                      <p>
                        Fenetre reponse: <strong>{Math.round((multiSession.answerWindowMs || 8000) / 1000)}s</strong>
                      </p>
                      <p>
                        Cooldown resultat: <strong>{Math.round((multiSession.revealCooldownMs || 2000) / 1000)}s</strong>
                      </p>
                    </div>

                    <article className="leaderboard">
                      <div className="leaderboard-head">
                        <h3>Joueurs connectes</h3>
                        <p>{multiRankings.length} joueurs</p>
                      </div>
                      {multiRankings.map((player) => (
                        <div className="leader-row" key={player.playerId}>
                          <span>{player.playerId === multiSession.hostPlayerId ? 'Host' : 'Player'}</span>
                          <p>{player.name}</p>
                          <strong>{player.playerId === devicePlayerId ? 'Toi' : ''}</strong>
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
                      <button type="button" className="btn-soft" onClick={() => leaveMultiplayerSession(false)}>
                        Quitter
                      </button>
                    </div>

                    {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
                  </>
                )}

                {multiSessionId && multiSession?.status === 'playing' && (
                  <>
                    <header className="multi-game-header">
                      <div className="multi-stat">
                        <span>{multiTimeLeft === null ? '∞' : `${multiTimeLeft}s`}</span>
                        <small>Temps</small>
                      </div>
                      <div className="multi-stat multi-stat-score">
                        <span>{myMultiPlayer?.score || 0}</span>
                        <small>Score</small>
                      </div>
                      <div className="multi-stat">
                        <span>#{myMultiRank || '-'}</span>
                        <small>Rang</small>
                      </div>
                      <div className={`multi-stat multi-phase-pill ${multiRoundState === 'reveal' ? 'reveal' : myRoundResponse ? 'answered' : 'active'}`}>
                        <span>
                          {multiRoundState === 'reveal'
                            ? `${multiPhaseTimeLeft ?? 0}s`
                            : `${multiPhaseTimeLeft ?? '-'}s`}
                        </span>
                        <small>
                          {multiRoundState === 'reveal'
                            ? 'Resultat'
                            : myRoundResponse
                              ? 'Envoye !'
                              : 'A toi !'}
                        </small>
                      </div>
                      <div className="multi-stat">
                        <span>{Object.keys(multiRoundResponses).length}/{getActivePlayerEntries(multiPlayers).length || 0}</span>
                        <small>Reponses</small>
                      </div>
                    </header>

                    <article className="question-card">
                      <p className="eyebrow">#{multiSessionId} · {multiSession.modeTitle}</p>
                      {multiStartsIn > 0 ? (
                        <>
                          <h2>Depart dans {multiStartsIn}...</h2>
                          <p className="muted">Tout le monde a la meme question.</p>
                        </>
                      ) : multiRoundState === 'reveal' ? (
                        <>
                          <h2 className="reveal-answer">
                            {multiLastRoundSummary?.questionLabel
                              ? `${multiLastRoundSummary.questionLabel} = ${multiLastRoundSummary.correctAnswer}`
                              : 'Resultat du round'}
                          </h2>
                          {multiLastRoundSummary?.winnerName && (
                            <p className="reveal-winner">Bravo <strong>{multiLastRoundSummary.winnerName}</strong> !</p>
                          )}
                        </>
                      ) : (
                        <h2>
                          {multiQuestion?.left} {multiQuestion?.operator} {multiQuestion?.right}
                        </h2>
                      )}
                    </article>

                    {multiStartsIn === 0 && multiRoundState === 'answering' && multiAnswerMode === 'choices' && multiQuestion && (
                      <div className="answers-grid">
                        {multiQuestion.options.map((option) => {
                          let buttonClass = 'answer-btn'
                          if (multiSelectedAnswer === option && multiFeedback?.type === 'success') {
                            buttonClass += ' picked-correct'
                          }
                          if (multiSelectedAnswer === option && multiFeedback?.type === 'error') {
                            buttonClass += ' picked-wrong'
                          }

                          return (
                            <button
                              key={`${multiQuestion.id}-${option}`}
                              type="button"
                              className={buttonClass}
                              disabled={multiSubmitting || Boolean(myRoundResponse) || multiSelectedAnswer !== null}
                              onClick={() => submitMultiplayerAnswer(option)}
                            >
                              {option}
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {multiStartsIn === 0 && multiRoundState === 'answering' && multiAnswerMode === 'input' && (
                      <form className="input-answer-form" onSubmit={handleMultiInputSubmit}>
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
                          disabled={multiSubmitting || Boolean(myRoundResponse) || multiSelectedAnswer !== null}
                        />
                        <button
                          type="submit"
                          className="btn-primary"
                          disabled={multiSubmitting || Boolean(myRoundResponse) || multiSelectedAnswer !== null}
                        >
                          Valider
                        </button>
                      </form>
                    )}

                    <article className={multiFeedback && multiRoundState !== 'reveal' ? `feedback-card active ${multiFeedback.type}` : 'feedback-card'}>
                      {multiStartsIn > 0 ? (
                        <p className="feedback-placeholder">Prets pour le depart...</p>
                      ) : multiRoundState === 'reveal' && multiLastRoundSummary ? (
                        <div className="round-summary">
                          <div className="round-summary-players">
                            {multiLastRoundSummary.correctPlayers?.length > 0 ? (
                              multiLastRoundSummary.correctPlayers.map((player) => (
                                <span key={player.playerId} className="round-player correct">
                                  {player.name} +{player.points}
                                </span>
                              ))
                            ) : (
                              <span className="round-player missed">Aucune bonne reponse</span>
                            )}
                            {multiLastRoundSummary.wrongPlayers?.map((player) => (
                              <span key={player.playerId} className="round-player wrong">
                                {player.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : multiFeedback ? (
                        <>
                          <p className="feedback-title">{multiFeedback.title}</p>
                          <p className="feedback-answer">{multiFeedback.detail}</p>
                        </>
                      ) : myRoundResponse ? (
                        <p className="feedback-placeholder">Reponse envoyee — attente des autres...</p>
                      ) : (
                        <p className="feedback-placeholder">Reste focus !</p>
                      )}
                    </article>

                    <article className="live-ranking-card">
                      <div className="leaderboard-head">
                        <h3>Classement live</h3>
                        <p>{multiRankings.length} joueurs · {multiAccuracyRate}% precision</p>
                      </div>
                      {multiRankings.slice(0, 6).map((player, index) => (
                        <div
                          className={`leader-row${player.playerId === devicePlayerId ? ' leader-row-me' : ''}`}
                          key={`${player.playerId}-${index}`}
                        >
                          <span>#{index + 1}</span>
                          <p>{player.name}{player.playerId === devicePlayerId ? ' (toi)' : ''}</p>
                          <strong>{player.score || 0}</strong>
                        </div>
                      ))}
                    </article>

                    <footer className="game-footer">
                      <div className="result-actions compact-actions">
                        {isHost ? (
                          <button type="button" className="btn-soft" onClick={finishMultiplayerSession}>
                            Terminer la course
                          </button>
                        ) : (
                          <button type="button" className="btn-soft" onClick={() => leaveMultiplayerSession(false)}>
                            Quitter
                          </button>
                        )}
                      </div>
                    </footer>
                  </>
                )}

                {multiSessionId && multiSession?.status === 'finished' && (
                  <>
                    <p className="eyebrow">Resultat multijoueur</p>
                    <h2>Course terminee</h2>

                    <div className="result-grid">
                      <article className="result-card">
                        <p>Ton score</p>
                        <strong>{myMultiPlayer?.score || 0}</strong>
                      </article>
                      <article className="result-card">
                        <p>Ton rang</p>
                        <strong>#{myMultiRank || '-'}</strong>
                      </article>
                      <article className="result-card">
                        <p>Precision</p>
                        <strong>{multiAccuracyRate}%</strong>
                      </article>
                      <article className="result-card">
                        <p>Points vitesse</p>
                        <strong>{myMultiPlayer?.questionWins || 0}</strong>
                      </article>
                    </div>

                    <article className="leaderboard">
                      <div className="leaderboard-head">
                        <h3>Classement final</h3>
                        <p>Session {multiSessionId}</p>
                      </div>
                      {multiRankings.map((player, index) => (
                        <div className="leader-row" key={`${player.playerId}-${index}`}>
                          <span>#{index + 1}</span>
                          <p>{player.name}</p>
                          <strong>{player.score || 0}</strong>
                        </div>
                      ))}
                    </article>

                    <div className="result-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={() => {
                          leaveMultiplayerSession(false)
                          navigate('/')
                        }}
                      >
                        Retour accueil
                      </button>
                      <button type="button" className="btn-soft" onClick={copySessionCode}>
                        Copier le code
                      </button>
                    </div>

                    {multiStatusMessage && <p className="multiplayer-status">{multiStatusMessage}</p>}
                  </>
                )}
              </section>
            }
          />

          <Route
            path="/profile"
            element={
              <section className="panel panel-result">
                <p className="eyebrow">Profil cloud</p>
                <h2>{cloudProfile.displayName}</h2>

                <div className="profile-header">
                  <div className="profile-identity">
                    <p>{cloudProfile.email}</p>
                    <label className="stack-label">
                      Pseudo
                      <input
                        value={profileNameInput}
                        onChange={(event) => setProfileNameInput(event.target.value)}
                        maxLength={24}
                        disabled={profileSaving}
                      />
                    </label>
                    <button type="button" className="btn-soft" onClick={saveProfileDisplayName} disabled={profileSaving}>
                      {profileSaving ? 'Sauvegarde...' : 'Mettre a jour pseudo'}
                    </button>
                    {profileMessage && <p className="multiplayer-status">{profileMessage}</p>}
                  </div>

                  <div className="profile-level-card">
                    <p>Niveau</p>
                    <strong>{profileLevel}</strong>
                    <span>
                      XP {cloudProfile.xp || 0} / {nextLevelXp}
                    </span>
                    <div className="xp-bar">
                      <div className="xp-bar-fill" style={{ width: `${xpProgressPct}%` }} />
                    </div>
                  </div>
                </div>

                <div className="profile-grid">
                  <article className="result-card">
                    <p>Record global</p>
                    <strong>{cloudProfile.bestScore || 0}</strong>
                  </article>
                  <article className="result-card">
                    <p>Serie max</p>
                    <strong>{cloudProfile.bestStreak || 0}</strong>
                  </article>
                  <article className="result-card">
                    <p>Etoiles</p>
                    <strong>{cloudProfile.stars || 0}</strong>
                  </article>
                  <article className="result-card">
                    <p>Parties jouees</p>
                    <strong>{cloudProfile.gamesPlayed || 0}</strong>
                  </article>
                  <article className="result-card">
                    <p>Bonnes reponses</p>
                    <strong>{cloudProfile.totalCorrect || 0}</strong>
                  </article>
                  <article className="result-card">
                    <p>Precision globale</p>
                    <strong>{globalAccuracy}%</strong>
                  </article>
                </div>

                <article className="leaderboard">
                  <div className="leaderboard-head">
                    <h3>Parcours recent</h3>
                    <p>{(cloudProfile.recentRuns || []).length} parties</p>
                  </div>

                  <div className="journey-list">
                    {(cloudProfile.recentRuns || []).length === 0 && <p className="muted">Aucune partie encore synchronisee.</p>}
                    {(cloudProfile.recentRuns || []).map((run, index) => (
                      <article key={`${run.playedAtMs || index}-${index}`} className="journey-item">
                        <p>
                          <strong>{run.modeTitle}</strong> ({run.source})
                        </p>
                        <p>Score: {run.score}</p>
                        <p>
                          Precision: {run.accuracy}% ({run.correct}/{run.total})
                        </p>
                        <p>Etoiles: +{run.starsDelta}</p>
                        <p>{new Date(run.playedAtMs).toLocaleString()}</p>
                      </article>
                    ))}
                  </div>
                </article>
              </section>
            }
          />

          <Route
            path="/admin"
            element={
              isAdmin ? (
                <section className="panel panel-admin">
                  <p className="eyebrow">Tableau de bord</p>
                  <h2>Administration</h2>

                  <div className="result-actions" style={{ marginTop: '0.8rem' }}>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => {
                        loadAdminProfiles()
                        loadAdminQuests()
                      }}
                      disabled={adminProfilesLoading}
                    >
                      {adminProfilesLoading ? 'Chargement...' : 'Actualiser les donnees'}
                    </button>
                  </div>

                  {adminQuestMessage && (
                    <p className="multiplayer-status" style={{ marginTop: '0.6rem' }}>
                      {adminQuestMessage}
                    </p>
                  )}

                  {/* Liste des joueurs */}
                  <article className="leaderboard" style={{ marginTop: '1rem' }}>
                    <div className="leaderboard-head">
                      <h3>Joueurs ({adminProfiles.length})</h3>
                      <p className="muted">Cliquer pour voir le detail</p>
                    </div>
                    {adminProfilesLoading && <p className="muted" style={{ padding: '0.5rem 1rem' }}>Chargement...</p>}
                    {adminProfiles.map((profile) => {
                      const lastPlayed = profile.lastPlayedMs
                        ? new Date(profile.lastPlayedMs).toLocaleDateString('fr-FR')
                        : 'jamais'
                      return (
                        <div
                          key={profile.uid}
                          className={
                            adminSelectedProfile?.uid === profile.uid
                              ? 'leader-row admin-row admin-row--selected'
                              : 'leader-row admin-row'
                          }
                          onClick={() =>
                            setAdminSelectedProfile(
                              adminSelectedProfile?.uid === profile.uid ? null : profile,
                            )
                          }
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) =>
                            e.key === 'Enter' && setAdminSelectedProfile(profile)
                          }
                        >
                          <span>Niv.{profile.level || 1}</span>
                          <div>
                            <strong>{profile.displayName || profile.email}</strong>
                            <p className="muted" style={{ fontSize: '0.78rem' }}>
                              {profile.gamesPlayed || 0} parties &middot; derniere: {lastPlayed}
                            </p>
                          </div>
                          <strong>{profile.xp || 0} XP</strong>
                        </div>
                      )
                    })}
                  </article>

                  {/* Detail du joueur sélectionné */}
                  {adminSelectedProfile && (
                    <article className="leaderboard admin-detail-panel" style={{ marginTop: '1rem' }}>
                      <div className="leaderboard-head">
                        <h3>{adminSelectedProfile.displayName}</h3>
                        <button
                          type="button"
                          className="btn-soft"
                          style={{ padding: '0.3rem 0.7rem', fontSize: '0.82rem' }}
                          onClick={() => setAdminSelectedProfile(null)}
                        >
                          Fermer
                        </button>
                      </div>

                      <div className="profile-grid" style={{ padding: '0.5rem 0.8rem', gap: '0.5rem' }}>
                        <article className="result-card">
                          <p>Parties</p>
                          <strong>{adminSelectedProfile.gamesPlayed || 0}</strong>
                        </article>
                        <article className="result-card">
                          <p>Record</p>
                          <strong>{adminSelectedProfile.bestScore || 0}</strong>
                        </article>
                        <article className="result-card">
                          <p>XP total</p>
                          <strong>{adminSelectedProfile.xp || 0}</strong>
                        </article>
                      </div>

                      {(adminSelectedProfile.recentRuns || []).length > 0 && (
                        <div style={{ padding: '0 0.8rem 0.5rem' }}>
                          <p className="custom-title" style={{ marginBottom: '0.4rem' }}>
                            Parties recentes
                          </p>
                          {(adminSelectedProfile.recentRuns || []).slice(0, 5).map((run, i) => (
                            <div key={i} className="leader-row" style={{ alignItems: 'flex-start' }}>
                              <span style={{ fontSize: '0.78rem' }}>{run.source === 'multi' ? 'Multi' : 'Solo'}</span>
                              <div>
                                <strong style={{ fontSize: '0.9rem' }}>{run.modeTitle}</strong>
                                <p className="muted" style={{ fontSize: '0.78rem' }}>
                                  Score {run.score} &middot; {run.accuracy}% de precision
                                </p>
                              </div>
                              <p className="muted" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                {new Date(run.playedAtMs).toLocaleDateString('fr-FR')}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Quetes actives pour ce joueur */}
                      {adminQuests.filter(
                        (q) =>
                          q.assignedToUid === adminSelectedProfile.uid ||
                          q.assignedToUid === 'all',
                      ).length > 0 && (
                        <div style={{ padding: '0 0.8rem 0.5rem' }}>
                          <p className="custom-title" style={{ marginBottom: '0.4rem' }}>
                            Quetes actives
                          </p>
                          {adminQuests
                            .filter(
                              (q) =>
                                q.assignedToUid === adminSelectedProfile.uid ||
                                q.assignedToUid === 'all',
                            )
                            .map((q) => {
                              const progress =
                                adminSelectedProfile.questProgress?.[q.id] || {
                                  attempts: 0,
                                  completions: 0,
                                  bestScore: 0,
                                  completed: false,
                                }
                              const attempts = Number(progress.attempts) || Number(progress.completions) || 0
                              const completions = Number(progress.completions) || 0
                              const requiredScore = normalizePositiveNumber(q.requiredScore, 0, 0, 100000)
                              return (
                                <div key={q.id} className="leader-row">
                                  <span>
                                    {progress.completed
                                      ? '✓'
                                      : `${completions}/${q.requiredCompletions}`}
                                  </span>
                                  <div>
                                    <p>{q.title}</p>
                                    <p className="muted" style={{ fontSize: '0.75rem' }}>
                                      Tentatives {attempts} &middot; meilleur score {Number(progress.bestScore) || 0} &middot; score mini {requiredScore}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    className="btn-soft"
                                    style={{ padding: '0.2rem 0.5rem', fontSize: '0.78rem' }}
                                    onClick={() => archiveQuest(q.id)}
                                  >
                                    Archiver
                                  </button>
                                </div>
                              )
                            })}
                        </div>
                      )}

                      {/* Formulaire création quête */}
                      <div
                        style={{
                          margin: '0.5rem 0.8rem 0.8rem',
                          borderTop: '1px dashed #c8dcf0',
                          paddingTop: '0.8rem',
                        }}
                      >
                        <p className="custom-title" style={{ marginBottom: '0.7rem' }}>
                          Creer une quete pour {adminSelectedProfile.displayName}
                        </p>

                        <div className="multiplayer-setup-grid">
                          <label className="stack-label" style={{ gridColumn: '1 / -1' }}>
                            Titre de la quete
                            <input
                              value={adminQuestForm.title}
                              onChange={(e) => updateAdminQuestForm('title', e.target.value)}
                              placeholder="Ex: Tables de 7 - defi"
                              maxLength={60}
                            />
                          </label>

                          <label className="stack-label" style={{ gridColumn: '1 / -1' }}>
                            Description (optionnel)
                            <input
                              value={adminQuestForm.description}
                              onChange={(e) => updateAdminQuestForm('description', e.target.value)}
                              placeholder="Ex: Complete 3 parties pour progresser"
                              maxLength={120}
                            />
                          </label>

                          <label className="stack-label">
                            Type de mode
                            <select
                              value={adminQuestForm.modeType}
                              onChange={(e) => updateAdminQuestForm('modeType', e.target.value)}
                            >
                              <option value="tables">Tables de multiplication</option>
                              <option value="mixed">Calcul mental</option>
                            </select>
                          </label>

                          <label className="stack-label">
                            Duree (secondes)
                            <input
                              type="number"
                              min="10"
                              max="600"
                              value={adminQuestForm.durationSeconds}
                              onChange={(e) =>
                                updateAdminQuestForm('durationSeconds', Number(e.target.value))
                              }
                            />
                          </label>

                          <label className="stack-label">
                            Parties requises
                            <input
                              type="number"
                              min="1"
                              max="100"
                              value={adminQuestForm.requiredCompletions}
                              onChange={(e) =>
                                updateAdminQuestForm(
                                  'requiredCompletions',
                                  Number(e.target.value),
                                )
                              }
                            />
                          </label>

                          <label className="stack-label">
                            Score minimum (validation)
                            <input
                              type="number"
                              min="0"
                              max="100000"
                              value={adminQuestForm.requiredScore}
                              onChange={(e) =>
                                updateAdminQuestForm('requiredScore', Number(e.target.value))
                              }
                            />
                          </label>

                          <label className="stack-label">
                            Reponse imposee
                            <select
                              value={adminQuestForm.requiredAnswerMode}
                              onChange={(e) => updateAdminQuestForm('requiredAnswerMode', e.target.value)}
                            >
                              {QUEST_ANSWER_MODE_OPTIONS.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.title}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="stack-label">
                            Assigner a
                            <select
                              value={adminQuestForm.targetUid}
                              onChange={(e) => updateAdminQuestForm('targetUid', e.target.value)}
                            >
                              <option value={adminSelectedProfile.uid}>
                                {adminSelectedProfile.displayName} (ce joueur)
                              </option>
                              <option value="all">Tous les joueurs</option>
                            </select>
                          </label>
                        </div>

                        {adminQuestForm.modeType === 'tables' && (
                          <div style={{ marginTop: '0.6rem' }}>
                            <p className="muted" style={{ marginBottom: '0.4rem', fontSize: '0.86rem' }}>
                              Tables a inclure
                            </p>
                            <div className="table-picker">
                              {Array.from({ length: 11 }, (_, i) => i + 2).map((table) => (
                                <button
                                  key={table}
                                  type="button"
                                  className={
                                    adminQuestForm.tables.includes(table)
                                      ? 'table-pill active'
                                      : 'table-pill'
                                  }
                                  onClick={() => toggleAdminQuestTable(table)}
                                >
                                  x{table}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {adminQuestForm.modeType === 'mixed' && (
                          <div style={{ marginTop: '0.6rem' }}>
                            <div className="mental-grid">
                              <label className="toggle-line">
                                <input
                                  type="checkbox"
                                  checked={adminQuestForm.operations.includes('mul')}
                                  onChange={() => toggleAdminQuestOperation('mul')}
                                />
                                Multiplications
                              </label>
                              <label className="toggle-line">
                                <input
                                  type="checkbox"
                                  checked={adminQuestForm.operations.includes('add')}
                                  onChange={() => toggleAdminQuestOperation('add')}
                                />
                                Additions
                              </label>
                              <label className="stack-label">
                                Mul min
                                <input
                                  type="number"
                                  min="1"
                                  max="200"
                                  value={adminQuestForm.mulMin}
                                  onChange={(e) =>
                                    updateAdminQuestForm('mulMin', Number(e.target.value))
                                  }
                                />
                              </label>
                              <label className="stack-label">
                                Mul max
                                <input
                                  type="number"
                                  min={adminQuestForm.mulMin}
                                  max="500"
                                  value={adminQuestForm.mulMax}
                                  onChange={(e) =>
                                    updateAdminQuestForm('mulMax', Number(e.target.value))
                                  }
                                />
                              </label>
                              <label className="stack-label">
                                Add min
                                <input
                                  type="number"
                                  min="0"
                                  max="5000"
                                  value={adminQuestForm.addMin}
                                  onChange={(e) =>
                                    updateAdminQuestForm('addMin', Number(e.target.value))
                                  }
                                />
                              </label>
                              <label className="stack-label">
                                Add max
                                <input
                                  type="number"
                                  min={adminQuestForm.addMin}
                                  max="20000"
                                  value={adminQuestForm.addMax}
                                  onChange={(e) =>
                                    updateAdminQuestForm('addMax', Number(e.target.value))
                                  }
                                />
                              </label>
                            </div>
                          </div>
                        )}

                        <div className="result-actions" style={{ marginTop: '0.8rem' }}>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={createAdminQuest}
                            disabled={adminQuestSaving || !adminQuestForm.title.trim()}
                          >
                            {adminQuestSaving ? 'Creation...' : 'Creer la quete'}
                          </button>
                        </div>
                      </div>
                    </article>
                  )}

                  {/* Liste globale des quêtes actives */}
                  {adminQuests.length > 0 && (
                    <article className="leaderboard" style={{ marginTop: '1rem' }}>
                      <div className="leaderboard-head">
                        <h3>Toutes les quetes actives ({adminQuests.length})</h3>
                      </div>
                      {adminQuests.map((q) => (
                        <div key={q.id} className="leader-row">
                          <span style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
                            {q.modeConfig.type === 'tables'
                              ? `x${q.modeConfig.tables.join(',')}`
                              : 'mental'}
                          </span>
                          <div>
                            <strong style={{ fontSize: '0.9rem' }}>{q.title}</strong>
                            <p className="muted" style={{ fontSize: '0.78rem' }}>
                              {q.assignedToName} &middot; {q.requiredCompletions} partie
                              {q.requiredCompletions > 1 ? 's' : ''} &middot; {q.durationSeconds}s
                            </p>
                            <p className="muted" style={{ fontSize: '0.72rem' }}>
                              Reponse: {getQuestAnswerModeLabel(q.requiredAnswerMode)} &middot; score mini{' '}
                              {normalizePositiveNumber(q.requiredScore, 0, 0, 100000)}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="btn-soft"
                            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                            onClick={() => archiveQuest(q.id)}
                          >
                            Archiver
                          </button>
                        </div>
                      ))}
                    </article>
                  )}
                </section>
              ) : (
                <Navigate to="/" replace />
              )
            }
          />

          <Route path="/memory" element={<MemoryGame />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </main>
  )
}

export default App
