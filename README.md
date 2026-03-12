# Table Quest - Multiplications Gamifiees

Jeu React/Vite mobile-first (iPad, smartphone, desktop) pour apprendre les tables de multiplication.

## Fonctionnalites

- Solo rapide avec feedback visuel fort (vert/rouge).
- Choix du mode de reponse: QCM ou reponse ecrite.
- Vrai compte cloud Firebase:
  - Email + mot de passe
  - Google Sign-In
  - Progression globale synchronisee sur tous les appareils
- Site multipage:
  - Accueil
  - Jouer
  - Multijoueur
  - Profil (parcours + progression)
- Mode multijoueur synchronise en temps reel:
  - Creation de session avec code partageable.
  - Rejoindre la meme session sur plusieurs appareils web.
  - Meme question pour tous.
  - Fenetre de reponse configurable.
  - Resultat de round + cooldown configurable.
  - Points distribues selon la vitesse des bonnes reponses.

## Prerequis

- Node.js 20.19+ recommande (Vite 7).
- npm 10+

## Installation locale

```bash
npm install
cp .env.example .env
# remplir les variables Firebase dans .env
npm run dev
```

## Configuration Firebase (obligatoire)

1. Cree un projet Firebase.
2. Active `Authentication`:
   - `Email/Password`
   - `Google`
3. Dans `Authentication > Settings > Authorized domains`, ajoute:
   - `localhost`
   - ton domaine Vercel (ex: `mathgame-rho.vercel.app`)
3. Active `Firestore Database` en mode natif.
4. Recupere les cles Web SDK et renseigne `.env`.
5. Utilise ces regles Firestore minimales pour demarrer (a durcir ensuite):

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tablequest_profiles/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /tablequest_sessions/{sessionId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

Variables attendues:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

## Scripts

```bash
npm run dev
npm run build
npm run preview
npm run lint
```

## Deploiement (Vercel)

1. Pousse le projet sur GitHub.
2. Importe le repo dans Vercel.
3. Ajoute les variables `VITE_FIREBASE_*` dans les Environment Variables Vercel.
4. Deploy.

Build command:

```bash
npm run build
```

Output directory:

```bash
dist
```

## Notes

- Le multijoueur fonctionne sur n importe quel navigateur moderne web, donc iPad + ordinateur + mobile.
- Le code de session est le point d entree commun pour tous les joueurs.
- La progression globale est stockee dans `tablequest_profiles/{uid}`.
