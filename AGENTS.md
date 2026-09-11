# AGENTS.md

Guide pour les agents IA et développeurs travaillant sur ce projet.

## Vue d'ensemble

Un script Node.js autonome (fichier unique) qui retire des USDC du protocole Moonwell sur Base en divisant les grands retraits en chunks. Aucun framework, aucune dépendance hors `ethers` v6.

## Structure du projet

- **`moonwell-withdraw-bot-chunked.js`** — Le bot complet (fichier unique)
- **`tests/bot.test.js`** — Tests unitaires (`node --test`), 31 tests, mocks uniquement (aucun réseau, aucune transaction réelle)
- **`README.md`** — Documentation utilisateur

## Stack technique

- **Node.js >= 18**
- **ethers v6** (`const { ethers } = require("ethers")`) — attention : syntaxe v6, pas v5 (ex. `ethers.parseUnits`, pas `ethers.utils.parseUnits`)
- **BigInt** natif pour les montants on-chain (unités brutes, 6 décimales pour USDC)
- **Deux providers** : un RPC public pour les lectures (`JsonRpcProvider`), un WSS Alchemy pour les souscriptions de blocs et les soumissions (`WebSocketProvider`)

## Architecture du code

### Configuration (haut de fichier)

Toutes les constantes sont au début : `WSS_URL`, `PRIVATE_KEY`, `MUSDC_ADDRESS`, `USDC_DECIMALS`, `TOTAL_TARGET`, `MIN_CHUNK`, `GAS_TIERS`. Les secrets se lisent via `process.env` avec des placeholders en fallback.

### Logique principale (fonction `main`)

1. **Validation** — Vérifie que les placeholders secrets ont été remplacés et que le montant cible ne dépasse pas le solde
2. **Initialisation** — Crée wallet, contrats (signé + lecture)
3. **`attemptChunk()`** — La boucle de retrait, déclenchée à chaque nouveau bloc

### Points clés à respecter

- **Garde `txInFlight`** : la fermeture `attemptChunk` refuse de soumettre une nouvelle transaction si une est déjà en cours. Ne pas retirer ce garde sans comprendre la raison (évite les nonces en conflit).
- **Fallback RPC** : `getCash()` tente d'abord le RPC public, puis Alchemy en cas d'erreur. Ne pas simplifier en utilisant uniquement Alchemy — c'est une optimisation de coût délibérée.
- **Vérification des `Failure` events** : pour les contrats Compound-fork, `receipt.status === 1` ne suffit pas. Il faut scanner les logs pour un event `Failure` et, le cas échéant, **ne pas** décrémenter `remainingRaw`.
- **Décrémentation conditionnelle** : `remainingRaw -= chunk` se fait uniquement après confirmation de succès on-chain, jamais avant.
- **Paliers de gaz** : `getGasForChunk()` choisit un palier selon le montant du chunk. Les paliers sont ordonnés du plus grand au plus petit montant (`GAS_TIERS.find`).
- **Arrêt** : quand `remainingRaw <= 0n`, le bot supprime les listeners, détruit le provider et appelle `process.exit(0)`.

## Conventions

- Les montants en unités brutes sont des `BigInt` (suffixe `n` dans les comparaisons : `remainingRaw <= 0n`, `cash === 0n`)
- `fmt(raw)` convertit en unités humaines via `ethers.formatUnits(raw, USDC_DECIMALS)`
- Les messages de log sont préfixés par `->` pour l'indentation et horodatés `[ISO]` pour les boucles
- Les erreurs de chunk sont catchées et loggées, puis la boucle continue (le bot ne doit pas mourir sur une erreur transitoire)

## Pièges courants

- **ethers v6 vs v5** : `ethers.WebSocketProvider`, `parseUnits`/`formatUnits`/`parseLog`/`staticCall` sont des méthodes v6. Ne pas les remplacer par des équivalents v5.
- **Décimales** : `USDC_DECIMALS = 6`. Toute conversion de montant doit passer par `parseUnits`/`formatUnits` avec cette constante.
- **Gestion des listeners** : `provider.removeAllListeners("block")` est appelé avant `process.exit` — s'assurer que toute modification de l'arrêt le conserve.

## Sécurité

- Ne jamais introduire de clé privée en dur dans le code — toujours via `process.env`
- Ne pas logger les secrets
- Les adresses de contrats sont fixes et vérifiées sur BaseScan

## Tests / exécution

Suite de tests unitaires via le runner natif Node (`node:test`) — aucun réseau, aucune transaction réelle, providers et contrats mockés :

```bash
node --test        # ou: yarn test
node --check moonwell-withdraw-bot-chunked.js   # vérification syntaxe
```

Les fonctions pures (`loadConfig`, `getGasForChunk`, `withTimeout`, `getTxStatus`, `computeChunk`) et le runner (`createChunkRunner`, avec état `state.{stopped,txInFlight,remainingRaw}`) sont exportés par le fichier précisément pour être testables. Les tests couvrent notamment les deux correctifs : **P1** (tx jamais minée → timeout → reprise de boucle sans blocage) et **P2** (deux `attemptChunk()` concurrents → une seule soumission).

Pour exécuter le bot :

```bash
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." node moonwell-withdraw-bot-chunked.js
```

Attention : le script soumet de vraies transactions on-chain. Ne l'exécuter que dans un contexte de test contrôlé ou en production délibérée.

### Correctifs appliqués (09/09/2026)

- **P1** — `tx.wait()` encadré par `withTimeout()` (`TX_TIMEOUT_MS`, défaut 60 s). Au timeout, `getTxStatus()` donne le statut réel : `pending`/`dropped` → warning + reprise au bloc suivant sans décrémenter ; `mined` → receipt traité normalement.
- **P2** — `txInFlight = true` posé immédiatement après le garde, avant tout `await`, pour éviter la double soumission au même nonce.
- **Diagnostics au démarrage** — `logStartupParameters()` affiche mUSDC_ADDRESS (avec lien BaseScan), wallet, WSS masqué, RPC, paliers de gaz, etc. Un solde nul déclenche un indice explicite (« vérifiez MUSDC_ADDRESS »).
- **Surveillance du solde** — `createBalanceMonitor()` relit le solde décomposable sur le RPC de lecture toutes les `BALANCE_MONITOR_INTERVAL` s (défaut 60 s, `0` pour désactiver) et log les changements externes (dépôts, retraits manuels, intérêts). Lecture seule : il ne modifie jamais la logique de retrait.
