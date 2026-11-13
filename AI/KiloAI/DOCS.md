# Kilo AI — Tor + Gateway Anonyme

> **Cible :** `https://api.kilo.ai/api/gateway/v1` (gateway OpenAI-compatible, accès anonyme sans clé API)  
> **Modèle (ex. observé/documenté) :** `reflection/beam-free`  
> **Principe :** requêtes API via proxy Tor (`SOCKS5`) + rotation d’IP de sortie pour contourner les limites par IP  
> **Statut :** documentation technique (fonctionnement, mise en œuvre, limites)

---

## Table des matières

- [Vue d’ensemble](#vue-densemble)
- [Architecture & flux réseau](#architecture--flux-réseau)
- [Pourquoi ça marche](#pourquoi-ça-marche)
  - [1. Gateway sans authentification par clé](#1-gateway-sans-authentification-par-clé)
  - [2. Contrôle d’accès/quotas principalement par IP](#2-contrôle-daccèsquotas-principalement-par-ip)
  - [3. Tor comme plan de rotation d’IP](#3-tor-comme-plan-de-rotation-dip)
  - [4. Compatibilité API (format chat/completions)](#4-compatibilité-api-format-chatcompletions)
- [Mise en œuvre](#mise-en-œuvre)
  - [Prérequis](#prérequis)
  - [Exemple `curl` (baseline)](#exemple-curl-baseline)
  - [Rotation d’identité Tor](#rotation-didentité-tor)
  - [Paramètres utiles](#paramètres-utiles)
- [Limites & contraintes](#limites--contraintes)
  - [Limites du gateway](#limites-du-gateway)
  - [Limites liées à Tor](#limites-liées-à-tor)
  - [Limites d’anonymat & traçabilité](#limites-danonymat--traçabilité)
  - [Fiabilité & reproductibilité](#fiabilité--reproductibilité)
  - [Comportement modèle/prompt](#comportement-modèleprompt)
- [Dépannage rapide](#dépannage-rapide)
- [Référence rapide](#référence-rapide)

---

## Vue d’ensemble

Le gateway Kilo AI expose une interface de type **OpenAI Chat Completions** accessible **sans clé API** (`keyless`). Dans ce mode, le service applique typiquement des contrôles (quotas/rate limits, filtrage, disponibilité) au niveau réseau/usage plutôt que via un compte authentifié. 

En routant les requêtes via **Tor** (`--socks5-hostname 127.0.0.1:9050`), le client sort avec l’IP d’un **nœud de sortie Tor**. En changeant de circuit/identité Tor, l’IP de sortie change, ce qui permet de **répartir ou réinitialiser** les limites associées à une IP source donnée.

**En bref :**
- *Accès* → gateway anonyme (pas de clé)
- *Distribution de charge des quotas* → changement d’IP via Tor
- *Interface* → endpoint `/chat/completions` compatible OpenAI

---

## Architecture & flux réseau

```text
┌──────────────┐      SOCKS5 (9050)      ┌─────────────┐      TLS/HTTPS      ┌──────────────────────────────┐
│ Client (curl │ ──────────────────────▶ │  Tor local  │ ─────────────────▶ │  api.kilo.ai (Gateway v1)    │
│ / app)       │   DNS via proxy (.onion │  (client)   │   IP de sortie =   │  /api/gateway/v1/...         │
└──────────────┘   & hostname résolu)    └──────┬──────┘   exit node Tor    └──────────────┬───────────────┘
                                                │                                      │
                                         [Circuit Tor]                                 ▼
                                       entry → middle → exit                    ┌───────────────┐
                                                                                │  Modèle LLM   │
                                                                                │ (ex. beam)    │
                                                                                └───────────────┘

Rotation: "New Identity" / nouveau circuit  ⇒  nouvelle IP de sortie  ⇒  nouveau “compteur” côté IP
```

**Point clé :** `--socks5-hostname` (et non `--socks5`) demande au proxy de résoudre le nom d’hôte, évitant une fuite DNS locale dans ce chemin d’appel.

---

## Pourquoi ça marche

### 1. Gateway sans authentification par clé

- L’endpoint est exposé en mode **keyless** : aucune `Authorization: Bearer <API_KEY>` n’est requise pour effectuer une requête valide.
- Sans identité de compte forte, le service ne peut pas lier l’usage à un utilisateur authentifié ; il s’appuie donc sur des signaux disponibles (IP source, empreintes, volume, patterns, tokens de session/anti-abus éventuels côté gateway).

**Conséquence :** la barrière d’entrée est basse (requête HTTP JSON standard).

### 2. Contrôle d’accès/quotas principalement par IP

- Les gateways anonymes/gratuits appliquent fréquemment des **rate limits** et quotas par **adresse IP** (requêtes/min, tokens/jour, concurrence, etc.).
- Une IP épuisée ou limitée reçoit des erreurs/throttling ; une IP “neuve” n’a pas (encore) consommé le même budget.

**Conséquence :** changer d’IP observable par le gateway peut restaurer la capacité d’appel.

### 3. Tor comme plan de rotation d’IP

- Tor route le trafic via un **circuit** (garde → relais intermédiaire → nœud de sortie). Le serveur distant voit l’IP du **nœud de sortie**.
- En demandant une **nouvelle identité/circuit**, le client obtient (généralement) un autre exit node, donc une **autre IP source** côté gateway.
- La rotation peut être manuelle (signal/control port) ou naturelle selon la gestion des circuits.

**Conséquence :** Tor fournit un mécanisme pratique de rotation d’IP sans infrastructure propre de proxies.

### 4. Compatibilité API (format chat/completions)

- Le gateway parle un schéma **OpenAI-compatible** (`/chat/completions`, `model`, `messages`, `max_tokens`, etc.).
- Les clients/outils existants fonctionnent avec un simple changement de `base URL` et sans clé.

**Conséquence :** intégration immédiate (curl, SDKs compatibles, scripts).

---

## Mise en œuvre

### Prérequis

- **Tor** en cours d’exécution avec un proxy SOCKS5 local (par défaut `127.0.0.1:9050`).
  - Debian/Ubuntu : `apt install tor && systemctl start tor`
  - Vérification rapide : `ss -ltnp | grep 9050` ou `curl --socks5-hostname 127.0.0.1:9050 https://check.torproject.org/api/ip`
- **curl** (ou tout client HTTP supportant SOCKS5 + résolution distante).
- Connectivité sortante vers les nœuds Tor et vers `api.kilo.ai`.

### Exemple `curl` (baseline)

```bash
curl -sS --socks5-hostname 127.0.0.1:9050 \
  https://api.kilo.ai/api/gateway/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "reflection/beam-free",
    "messages": [
      {"role": "system", "content": "<PROMPT_SYSTEME>"},
      {"role": "user", "content": "Explique brièvement ton fonctionnement."}
    ],
    "max_tokens": 400,
    "reasoning_effort": "none"
  }'
```

**Notes :**
- Remplacer `<PROMPT_SYSTEME>` par le prompt souhaité.
- Pour les modèles orientés “reasoning”, un réglage bas (`reasoning_effort: "none"` ou `"low"`) peut réduire la latence/verbosité de raisonnement selon le modèle.

### Rotation d’identité Tor

```bash
# Si le ControlPort est activé (ex. 9051) avec cookie/auth configuré :
# Exemple conceptuel (à adapter selon config torrc) :
#   echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT' | nc 127.0.0.1 9051

# Alternative simple : redémarrer le service Tor (plus lent, moins discret)
#   systemctl restart tor
```

- `SIGNAL NEWNYM` demande de nouveaux circuits ; l’effet sur l’IP de sortie dépend de la disponibilité des exits et des politiques de réutilisation de circuits (pas toujours instantané/garanti à chaque appel).
- Bon pattern : détecter `429`/erreurs de quota → attendre brièvement → nouvelle identité → retry (backoff).

### Paramètres utiles

| Paramètre | Rôle | Remarque |
|---|---|---|
| `model` | Sélection du modèle backend | ex. `reflection/beam-free` (disponibilité variable) |
| `messages` | Contexte/conversation (`system`, `user`, `assistant`) | format OpenAI |
| `max_tokens` | Borne de sortie | impact latence/coût/quotas côté gateway |
| `temperature`, `top_p` | Échantillonnage | selon support gateway/modèle |
| `reasoning_effort` | Effort de raisonnement (si supporté) | `none`/`low` pour réponses plus directes/légères |
| `stream` | Streaming token-par-token (si supporté) | à tester selon implémentation |

---

## Limites & contraintes

### Limites du gateway

| Limite | Détail |
|---|---|
| **Rate limits / quotas** | Par IP, par fenêtre temporelle, par volume de tokens, ou par concurrence ; peuvent persister malgré rotation (quotas globaux, heuristiques). |
| **Disponibilité modèle** | Modèles `*-free`/anonymes pouvant être retirés, renommés, saturés ou dégradés sans préavis. |
| **Changements d’API** | Endpoint, schéma, champs acceptés ou politiques pouvant évoluer (breaking changes). |
| **Filtrage côté gateway** | Blocage de prompts/réponses, modération, ou refus selon politiques du fournisseur/gateway, indépendamment du prompt système. |
| **Pas de SLA** | Service best-effort : pas de garantie d’uptime, de latence ni de capacité. |

### Limites liées à Tor

| Limite | Détail |
|---|---|
| **Latence & débit** | Circuits multi-sauts ⇒ RTT élevé, throughput réduit, streaming moins fluide. |
| **Stabilité** | Circuits pouvant se rompre ; timeouts/retries nécessaires. |
| **Blocage des exits** | Certains services bloquent ou challengent les IP de sortie Tor (CAPTCHA, 403/429, listes de réputation). |
| **Qualité variable des exits** | IPs déjà “brûlées”/rate-limitées par d’autres usages. |
| **Résolution DNS** | Utiliser `--socks5-hostname` pour éviter les fuites DNS ; mauvaise config = exposition hors tunnel. |

### Limites d’anonymat & traçabilité

| Limite | Détail |
|---|---|
| **Anonymat ≠ invulnérabilité** | Tor réduit l’exposition de l’IP client mais n’anonymise pas le contenu, les identifiants applicatifs, ni les patterns d’usage. |
| **Corrélation & fingerprinting** | Horodatage, volume, style, en-têtes, fingerprint TLS/HTTP, et corrélation trafic entrée/sortie peuvent réduire l’anonymat. |
| **Métadonnées applicatives** | Comptes, cookies, tokens ou identifiants réutilisés côté client annulent les bénéfices réseau. |
| **Point de sortie visible** | Le gateway voit l’IP exit (et ses opérateurs/logs éventuels) ; le trafic entre exit et destination dépend du TLS mais la terminaison/observation côté service reste possible. |
| **Juridique/conformité** | Le cadre légal, les CGU du service et les lois applicables restent en vigueur quel que soit le transport. |

### Fiabilité & reproductibilité

- Réponses **non déterministes** (température, versions modèle, charge) : difficile de garantir la même sortie.
- Rotation d’IP ≠ réinitialisation garantie (délai `NEWNYM`, réutilisation d’exits, limites non-IP).
- Dépendance à une infra tierce non contractuelle : possibilité d’interruption à tout moment.

### Comportement modèle/prompt

- Le **prompt système** influence fortement le comportement mais ne garantit pas l’absence de refus/filtrage si le gateway ou le modèle impose ses propres politiques.
- `reasoning_effort` (quand supporté) ajuste le style/effort de raisonnement, pas la disponibilité du service.
- Les capacités réelles dépendent du modèle exposé derrière l’alias (contexte, outils, multimodalité, fraîcheur des données).

---

## Dépannage rapide

| Symptôme | Piste |
|---|---|
| `Connection refused` sur `127.0.0.1:9050` | Tor non démarré / port SOCKS différent |
| Timeout / très lent | Circuit Tor dégradé, exit saturé ; retenter ou renouveler le circuit |
| `429` / rate limited | Attendre, renouveler l’identité Tor, réduire le débit/taille des requêtes |
| `403` / bloqué | Exit Tor blacklisté ; changer de circuit/IP |
| `404` sur la racine `/v1` | Normal si le chemin exact attendu est `/chat/completions` (ou autre route) |
| Réponse vide / erreur JSON | Vérifier `model`, schéma `messages`, `max_tokens`, et support des paramètres |

---

## Référence rapide

- **Base URL (gateway v1) :** `https://api.kilo.ai/api/gateway/v1`
- **Endpoint chat :** `POST /chat/completions`
- **Auth :** aucune clé requise (mode anonyme)
- **Transport recommandé :** `curl --socks5-hostname 127.0.0.1:9050 ...`
- **Modèle (ex.) :** `reflection/beam-free`
- **Levier de déblocage quota IP :** rotation d’identité/circuit Tor

---

*Document de référence technique — comportement observé/supposé du mode anonyme Kilo AI via Tor, sujet à évolution.*