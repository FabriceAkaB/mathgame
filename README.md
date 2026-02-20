# Table Quest - Multiplications Gamifiees

Jeu React/Vite mobile-first (iPad, smartphone, desktop) pour apprendre les tables de multiplication.

## Fonctionnalites

- Solo rapide avec feedback visuel fort (vert/rouge).
- Choix du mode de reponse: QCM ou reponse ecrite.
- Profils locaux et records sauvegardes sur l appareil.
- Mode multijoueur vitesse en temps reel:
  - Creation de session avec code partageable.
  - Rejoindre la meme session sur plusieurs appareils web.
  - Lobby, depart synchronise, classement live et classement final.

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

## Configuration Firebase (obligatoire pour le multijoueur)

1. Cree un projet Firebase.
2. Active `Authentication` puis `Anonymous`.
3. Active `Firestore Database` en mode natif.
4. Recupere les cles Web SDK et renseigne `.env`.
5. Utilise ces regles Firestore minimales pour demarrer (a durcir ensuite):

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
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
