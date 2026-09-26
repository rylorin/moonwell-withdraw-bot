# PLAN — Correctifs & améliorations du bot Moonwell

**Statut : ✅ TOUS TRAITÉS** (sept. 2026 — correctifs appliqués + tests unitaires `tests/bot.test.js`, 73 tests).  
**Version : 1.0.0** — bot stabilisé, prêt pour production.  
Cible : `dist/moonwell-withdraw-bot-chunked.js`.

## Barème de priorité

| Priorité | Signification                                                             |
| -------- | ------------------------------------------------------------------------- |
| 🔴 P1    | Risque de blocage du bot / perte de fonctionnalité — à traiter en premier |
| 🟠 P2    | Bug de concurrence réel, déclencheur aléatoire                            |
| 🟡 P3    | Robustesse face aux pannes réseau                                         |
| 🟣 P4-P6 | Améliorations de confort / fiabilité cosmétique                           |

---

## ✅ 🔴 P1 — Stall permanent si une transaction n'est jamais minée (TRAITÉ)

**Localisation** : [moonwell-withdraw-bot-chunked.js:188](../moonwell-withdraw-bot-chunked.js#L188)

**Problème** : `await tx.wait()` sans timeout, aucune gestion de nonce ni d'augmentation de frais. Avec les plafonds `maxFee` de 0.1–0.6 gwei ([GAS_TIERS ligne 49](../moonwell-withdraw-bot-chunked.js#L49)), un pic de base fee sur Base (mint populaire, etc.) fait passer base fee > `maxFeePerGas`. La tx reste pending indéfiniment → `txInFlight` reste `true` → **tous les blocs suivants sont ignorés** → bot bloqué jusqu'au Ctrl-C manuel. Même scénario si la tx est remplacée/orpheline (cf. P2).

**Correctif appliqué (09/09/2026)** : `tx.wait()` est encadré par `withTimeout()` (configurable via `TX_TIMEOUT_MS`, défaut 60 s). Au timeout, `getTxStatus()` interroge le provider → `pending`/`dropped` : log clair, `txInFlight = false`, **aucun** décrément de `remainingRaw`, reprise au bloc suivant ; `mined` : le receipt est récupéré et traité normalement. Voir tests `withTimeout`, `getTxStatus` et `P1: tx pending forever…`.

**Critère de validation** : simuler un hash jamais miné (mock) → le bot doit logger un warning et reprendre sa boucle au bloc suivant, sans blocage. ✅ couvert par `tests/bot.test.js`.

---

## ✅ 🟠 P2 — Course : le garde `txInFlight` est posé trop tard (TRAITÉ)

**Localisation** : garde à la [ligne 130](../moonwell-withdraw-bot-chunked.js#L130), `txInFlight = true` à la [ligne 169](../moonwell-withdraw-bot-chunked.js#L169)

**Problème** : le handler `attemptChunk` est async ; entre le garde et l'assignation de `txInFlight`, il y a des `await` (`getCash` lignes 138–143). Deux events `block` (Base en produit toutes les ~2 s) peuvent franchir le garde pendant la lecture. Résultat : deux soumissions concurrentes → ethers v6 lit deux fois le même nonce → **deux txs au même nonce**, l'une devient orpheline → rejoint le P1.

**Correctif appliqué (09/09/2026)** : `txInFlight = true` est posé immédiatement après le garde, avant tout `await`. Le `finally` existant ressort toujours le flag.

**Critère de validation** : déclencher deux `attemptChunk()` simultanément (simulation bloc + appel initial) → une seule tx soumise, l'autre retourne immédiatement. ✅ couvert par `tests/bot.test.js` (`P2: two concurrent attemptChunk calls submit exactly one tx`).

---

## ✅ 🟡 P3 — Aucune reconnexion / surveillance du WSS Alchemy (TRAITÉ)

**Localisation** : [createWssWatchdog (watchdog) ligne 664](../moonwell-withdraw-bot-chunked.js#L664), [watchdog instancié dans main() ligne 1047](../moonwell-withdraw-bot-chunked.js#L1047)

**Problème** : aucun handler `error` / `close` sur `WebSocketProvider`. Si Alchemy ferme la connexion (idle, rate-limit, rebalance), les events `block` s'arrêtent **silencieusement** : le bot continue d'afficher des logs mais ne réagit plus.

**Correctif appliqué (11/09/2026)** : nouveau factory `createWssWatchdog` exporté — heartbeat (`WS_CHECK_MS`) + seuil de silence (`WS_STALL_MS`) ; sa propre souscription `block` alimente l'horloge, et les events `error` / `close` du provider/websocket sont loggés (URL masquée, jamais de clé). En cas de stall : si une tx est en vol, la reconnexion est différée (budget non consommé) ; sinon l'ancien provider est détruit, un nouveau est créé (`buildWss`), la souscription `block` est relancée et `runner.setConnection` rebranche la soumission sur le nouveau provider. Comportement piloté par `WS_ON_STALL` : `reconnect` (défaut, jusqu'à `WS_MAX_RECONNECTS` tentatives avant arrêt) ou `exit` (alerte + arrêt immédiat, également sur `close` du socket).

**Amélioration backoff (12/09/2026)** : une reconnexion échouée ne fait plus **quitter** le processus — elle est relancée en _backoff_ exponentiel (`WS_BACKOFF_BASE_MS` = 5 s, ×2 par échec, plafonné à `WS_BACKOFF_MAX_MS` = 60 s). Le budget par défaut monte à **10** (`WS_MAX_RECONNECTS`) ; avec l'espacement du backoff, ~8 min de réseau absent peuvent être absorbées — de quoi survivre à un réveil de veille Mac dont la DNS est transitoirement morte (crash `getaddrinfo ENOTFOUND` sur le socket ws, à l'origine du correctif). Avant d'adopter un socket frais, une sonde de santé (`getBlockNumber` via `withTimeout`, 5 s) vérifie qu'il répond réellement.

**Correctif complémentaire (12/09/2026)** : le getter `WebSocketProvider.websocket` d'ethers v6 **lève** `Error("websocket closed")` une fois le socket détruit (il ne renvoie pas `null`) — l'optional chaining `?.` ne protège pas d'un getter qui throw. Au réveil de veille, `fatal()` → `stop()` → `unbind()` accédait à `boundProvider.websocket` (déjà mort) et faisait crasher le processus par un rejet non géré _au lieu_ du `process.exit(1)` prévu. `unbind()`/`bind()`/`buildWss()` accèdent désormais au socket uniquement via un helper `safeWs()` (`try { return p?.websocket || null } catch { return null }`). Tests de régression : `watchdog: un getter websocket qui THROW après close ne crashe pas fatal() (régression)` et `watchdog: getter websocket qui THROW dès le bind → stop()/fatal() propres`. ✅ 73 tests verts.

**Critère de validation** : couper la connexion réseau en cours d'exécution → log explicite et soit reconnexion, soit arrêt propre. ✅ couvert par les tests `watchdog:*` et `runner: setConnection …`.

---

## ✅ 🟣 P4 — Boucle infinie sur les poussières (< MIN_CHUNK) (TRAITÉ)

**Localisation** : [ligne 161-165](../moonwell-withdraw-bot-chunked.js#L161)

**Problème** : si le reliquat passe sous `MIN_CHUNK` (ex. cible 100.5 → 3 chunks de 33, il reste 1.5 < 5), le bot imprime « Below MIN_CHUNK » à **chaque bloc, indéfiniment**, sans jamais s'arrêter — alors qu'il ne peut plus rien retirer par conception.

**Correctif appliqué (12/09/2026)** : dans `attemptChunk`, dès que `remainingRaw` reste > 0 mais < `minChunkRaw` (poussière), le bot log un message explicite puis s'arrête proprement via `done()` (`stopped = true` → destroy provider → `process.exit(0)`) — plus de boucle « Below MIN_CHUNK » à chaque bloc.

**Critère de validation** : configurer un reliquat < MIN → le bot s'arrête seul avec un message explicite. ✅ couvert par les tests `P4: remaining dust below MIN_CHUNK stops cleanly`.

---

## ⛔ 🟣 P5 — Double conversion des montants en `parseFloat` (**NON IMPLÉMENTÉ**)

**Localisation** : `loadConfig` lignes 86-87 (`WITHDRAW_AMOUNT`, `MIN_CHUNK`)

### Analyse détaillée

**Implémentation actuelle** :

```javascript
totalTarget: env.WITHDRAW_AMOUNT ? parseFloat(env.WITHDRAW_AMOUNT) : null,
minChunkUsdc: env.MIN_CHUNK ? parseFloat(env.MIN_CHUNK) : 5,
```

Puis plus loin, re-conversion vers BigInt via `ethers.parseUnits(config.totalTarget.toString(), 6)` (lignes 351, 1060) et `config.minChunkUsdc.toString()` (ligne 346).

**Problème théorique** : double arrondi silencieux si input > 6 décimales (ex. `70000.1234567` → `parseFloat` → re-parse).

**Pourquoi NE PAS l'implémenter** :

| Facteur                                    | Évaluation                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **Cas réel** : montants USDC > 6 décimales | Impossible on-chain (USDC = 6 décimales max)                                              |
| **Validation existante**                   | `parseAmount()` (lignes 34-55) rejette déjà > 6 décimales avec erreur explicite           |
| **Impact utilisateur**                     | Quasi nul — montants saisis sont entiers ou 2 décimales                                   |
| **Risque régression**                      | **Élevé** — refactor majeur touchant :                                                    |
|                                            | • `config.totalTarget` utilisé comme `number` (comparaisons, `!== null`, logs)            |
|                                            | • `config.minChunkUsdc` utilisé comme `number` (seuils gas ligne 490, logs, comparaisons) |
|                                            | • `parseFloat(fmt(chunk))` ligne 490 pour sélection tier gas                              |
|                                            | • 73 tests valident comportements numériques actuels                                      |
| **Gain**                                   | Minime — corriger un cas d'erreur qui n'arrive pas en pratique                            |

**Alternative low-risk (si besoin futur)** : ajouter une validation précoce dans `loadConfig` qui rejette > 6 décimales _avant_ le `parseFloat`, sans changer les types internes :

```javascript
function validateDecimals(raw, maxDecimals = 6) {
  const s = String(raw).trim();
  const dot = s.indexOf(".");
  if (dot !== -1 && s.length - dot - 1 > maxDecimals) {
    throw new Error(
      `${maxDecimals} decimal places max, got ${s.length - dot - 1}`,
    );
  }
}
```

**Décision** : **WONTFIX** — le gain ne justifie pas le risque. L'implémentation actuelle est pragmatique pour des montants USDC standards. La validation `parseAmount` en aval suffit.

---

## ✅ 🟣 P6 — Nettoyage des providers en fin de vie (TRAITÉ)

**Localisation** : [readProvider ligne 97](../moonwell-withdraw-bot-chunked.js#L97)

**Problème** : `readProvider` n'est jamais détruit et aucun handler `error` n'y est attaché. Sans impact aujourd'hui (le `process.exit(0)` s'en charge), mais voué à fuiter si le processus est refactorisé.

**Correctif appliqué (12/09/2026)** : nouveau `createShutdownHandler()` exporté — stop des jobs de fond (moniteur de balance, watchdog) puis destruction des deux providers (WSS + RPC de lecture) sur SIGINT/SIGTERM, idempotent (un second signal est ignoré), `process.exit(0)` sur succès / `process.exit(1)` sur erreur. Un handler `error` est aussi attaché au `readProvider`.

---

## Améliorations optionnelles (à évaluer, non validées)

- **Notification** : alerte (télégramme / webhook) à la fin du retrait ou en cas d'échec répété — le bot tournant en fond, l'utilisateur ne surveille pas les logs.
- **Nonce explicite** : gérer le nonce manuellement (ou `nonce` dans les options de tx) pour éliminer toute ambiguïté en cas de multi-exécution.
- **Estimation `gasLimit`** explicite (actuellement ethers l'estime par défaut) pour éviter un revert d'estimation à l'envoi.
- **Variable `READ_RPC_URL`** : documenter la nécessité d'un endpoint fiable (drpc.org public peut être lent/rate-limité) et envisager plusieurs endpoints avec rotation.

---

## Ordre de traitement réalisé

1. **P2** (minimal, 2 lignes) → réduit aussi la probabilité du P1
2. **P1** (timeout + reprise de boucle) — la correction la plus importante pour la fiabilité
3. **P3** (reconnexion WSS + backoff exponentiel + fix getter websocket)
4. **P4** (arrêt propre sur poussière) + **P6** (nettoyage providers)
5. **P5** analysé → **WONTFIX** (gain minime, risque élevé)

---

## Checklist de validation finale ✅

- [x] `node --check moonwell-withdraw-bot-chunked.js` → aucune erreur de syntaxe
- [x] Lancement à blanc sans vraie clé → erreurs placeholder toujours actives (pas de fuite de secrets)
- [x] Simuler une tx non minée → reprise de boucle sous 60 s (P1)
- [x] Simuler 2 events simultanés → une seule soumission (P2)
- [x] Couper le réseau → log explicite / reconnexion (P3) — couvert par tests watchdog 53–66
- [x] Reliquat < MIN → arrêt propre (P4)
- [x] **P5 : WONTFIX** — documenté ci-dessus, validation `parseAmount` suffisante
- [x] Nettoyage providers à l'arrêt (P6)
- [x] **73 tests passent** (`node --test`)
- [x] Version **1.0.0** taggée
