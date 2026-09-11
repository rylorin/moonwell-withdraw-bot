# AGENTS.md

Guide pour les agents IA et développeurs travaillant sur ce projet.

## Vue d'ensemble

Un script Node.js autonome (fichier unique) qui retire des USDC du protocole Moonwell sur Base en divisant les grands retraits en chunks. Aucun framework, aucune dépendance hors `ethers` v6.

## Structure du projet

- **`moonwell-withdraw-bot-chunked.js`** — Le bot complet (fichier unique)
- **`tests/bot.test.js`** — Tests unitaires (`node --test`), 63 tests, mocks uniquement (aucun réseau, aucune transaction réelle)
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
- **Vérification des `Failure` events** : pour les contrats Compound-fork, `receipt.status === 1` ne suffit pas. Il faut scanner les logs pour un event `Failure` et, le cas échéant, **ne pas** comptabiliser le chunk (ni incrémenter `processedRaw`, ni décrémenter `knownBalanceRaw`).
- **Comptabilisation conditionnelle** : le succès on-chain n'incrémente que `processedRaw += chunk` (et décrémente `knownBalanceRaw -= chunk`). Rien n'est comptabilisé avant confirmation.
- **Modèle de re-sync du solde** : `processedRaw` (montant traité) et `knownBalanceRaw` (solde connu, source unique du plafond de chunk) sont écrits aux seuls deux moments légitimes — confirmation on-chain et lecture du moniteur de balance. `remainingRaw` est un *getter* dérivé : `targetRaw - processedRaw` en mode cible fixe, `knownBalanceRaw` en mode solde complet (sans `WITHDRAW_AMOUNT`), donc les dépôts externes sont retirés automatiquement et un retrait manuel réduit la cible.
- **Garde anti-double-compte** : une lecture du moniteur de balance n'écrase `knownBalanceRaw` que si `!txInFlight` — jamais pendant qu'une transaction est en cours (évite de compter deux fois le même retrait).
- **`CHUNK_CAP_SOURCE`** : `monitor` (dernière valeur lue par le moniteur, défaut) ou `fresh` (relecture du solde via le RPC de lecture à chaque tour). Sans moniteur (`BALANCE_MONITOR_INTERVAL=0`), le bot bascule en `fresh` avec un warning.
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

Les fonctions pures (`loadConfig`, `getGasForChunk`, `withTimeout`, `getTxStatus`, `computeChunk`) et le runner (`createChunkRunner`, avec état `state.{stopped,txInFlight,processedRaw,knownBalanceRaw,remainingRaw}`) sont exportés par le fichier précisément pour être testables. Le helper `createBalanceWiring` est également exporté pour connecter le moniteur de balance au runner. Les tests couvrent les correctifs **P1**, **P2** et **P3** (watchdog WSS + reconnexion) ainsi que le modèle de re-sync du solde : mode solde complet, réaction aux dépôts/ retraits externes, garde anti-double-compte, bascule monitor→fresh.

Pour exécuter le bot :

```bash
BASE_WSS_URL="wss://..." PRIVATE_KEY="..." node moonwell-withdraw-bot-chunked.js
```

Attention : le script soumet de vraies transactions on-chain. Ne l'exécuter que dans un contexte de test contrôlé ou en production délibérée.

### Correctifs appliqués (09/09/2026)

- **P1** — `tx.wait()` encadré par `withTimeout()` (`TX_TIMEOUT_MS`, défaut 60 s). Au timeout, `getTxStatus()` donne le statut réel : `pending`/`dropped` → warning + reprise au bloc suivant sans décrémenter ; `mined` → receipt traité normalement.
- **P2** — `txInFlight = true` posé immédiatement après le garde, avant tout `await`, pour éviter la double soumission au même nonce.
- **P3 (11/09/2026)** — `createWssWatchdog()` surveille le WSS Alchemy : heartbeat + seuil de silence (`WS_STALL_MS`) détectent une coupure, les events `error`/`close` sont loggés (URL masquée via `maskUrl`, jamais de clé), et la reconnexion reconstruit le provider (`buildWss`) puis rebranche la souscription `block` via `runner.setConnection`. Comportement piloté par `WS_ON_STALL` (`reconnect` par défaut / `exit`) avec un budget `WS_MAX_RECONNECTS` ; reconnexion différée tant qu'une tx est en vol.
- **Diagnostics au démarrage** — `logStartupParameters()` affiche mUSDC_ADDRESS (avec lien BaseScan), wallet, WSS masqué, RPC, paliers de gaz, etc. Un solde nul déclenche un indice explicite (« vérifiez MUSDC_ADDRESS »).
- **Surveillance du solde** — `createBalanceMonitor()` relit le solde décomposable sur le RPC de lecture toutes les `BALANCE_MONITOR_INTERVAL` s (défaut 60 s, `0` pour désactiver) et log les changements externes (dépôts, retraits manuels, intérêts).
- **Re-synchronisation du solde (11/09/2026)** — le moniteur alimente désormais la logique de retrait via `createBalanceWiring()` : `remainingRaw` est un getter dérivé de `targetRaw - processedRaw` (mode cible fixe) ou de `knownBalanceRaw` (mode solde complet). Les dépôts externes sont retirés automatiquement, un retrait manuel réduit la cible. Garde anti-double-compte : une lecture du moniteur n'écrase `knownBalanceRaw` que si `!txInFlight`. `CHUNK_CAP_SOURCE` (`monitor`/`fresh`) choisit la source du plafond de chunk — sans moniteur, bascule automatique en `fresh` avec warning.
