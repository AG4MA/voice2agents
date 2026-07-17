# Voice2Agents — conversazione ambient con Codex

Conversazione **continua e in tempo reale** con **Codex** (estensione
`openai.chatgpt`), sul modello dell'overlay ai-voice-os: **parte da sola con
VSCode e ascolta sempre** — niente click, niente push-to-talk. Dici
**"Codex, ..."** e la frase parte verso la sua chat; lui risponde **a voce**;
dopo una risposta hai ~25s di **finestra conversazionale** in cui ribatti senza
ripetere il nome. Tutto in locale: Whisper (STT) e Kokoro (TTS) girano sulla
**DGX Spark** via tunnel SSH ristretto (`voice-tunnel`, solo forward 8900).
**Nessun dato a cloud terzi.**

Creato il 2026-07-17. v0.2: target Codex + 18 fix dalla review multi-agente.
v0.3: ambient (avvio automatico, wake word, finestra conversazionale, barge-in).

## Come funziona

```
  tu parli                                          Codex ti risponde a voce
     │                                                        ▲
     ▼                                                        │ mp3 (Kokoro, Spark)
[estensione VSCode] ── WAV ──► /stt (Spark) ── testo ──►  [estensione]
 ffmpeg + silencedetect                │                      ▲
 (taglia le frasi sui silenzi)         ▼                      │ nuove risposte
                          incolla + Invio nella           watcher su
                          chat di Codex (SendKeys)     ~/.codex/sessions/*.jsonl
```

- **Sempre attivo**: parte all'apertura di VSCode (`avvioAutomatico`). La status
  bar mostra "Codex: ci sono"; un click (o `Ctrl+Alt+V`) spegne/riaccende tutto.
- **Wake word**: in ambient ciò che dici viene trascritto ma NON inviato, a meno
  che la frase contenga "codex" (configurabile) o arrivi nella finestra
  conversazionale (~25s dopo una sua risposta). Così telefonate e colleghi non
  finiscono in chat; tutto resta comunque nel log Output → Voice2Agents.
- **Barge-in** (`bargeIn`, per CUFFIE): se parli mentre lui parla, si zittisce
  subito. Con le casse lascialo off: senza cancellazione d'eco si
  auto-interromperebbe; lì l'eco viene filtrata confrontando il trascritto con
  la frase appena pronunciata (+ scarto dei chunk registrati durante il playback).
- **Kill switch voce**: file `MUTE` in questa cartella = nessun audio.

## Impostazioni principali (`voice2agents.*`)

| chiave | default | note |
|---|---|---|
| `target` | `codex` | `focus` = scrive dove hai il cursore invece che nella chat Codex |
| `autoInvio` | `true` | Invio automatico dopo l'incolla (mani libere); `false` = solo incolla |
| `focusCodex` | `true` | apre/porta a fuoco la chat Codex prima di incollare |
| `voceCodex` | `true` | leggi a voce le risposte di Codex |
| `maxParlato` | `500` | caratteri massimi letti per risposta |
| `silenceDb` / `silenceSec` | `-35dB` / `1.2` | sensibilità del taglio frasi |

⚠️ Con `autoInvio` attivo il testo viene incollato + Invio nella finestra a fuoco:
se togli il focus a VSCode mentre detti, il testo può finire altrove. La chat
Codex viene ri-focalizzata prima di ogni incolla (`focusCodex`).

## Lato Spark (già fatto, per riferimento)

- Endpoint `/tts` aggiunto al `voice_server.py` **live** con
  [spark/patch_tts_endpoint.py](spark/patch_tts_endpoint.py) (idempotente — il
  server sulla Spark è più avanti del repo su PC, mai sovrascriverlo).
- Avvio dopo un boot: `docker compose -f ~/projects/ai-voice-os/docker-compose.services.yml up -d`
  poi `sudo systemctl restart voice-os`. Verifica: `curl 127.0.0.1:8900/health/ready`.

## Hook Claude Code (opzionali, ora DISATTIVATI)

[hooks/speak.ps1](hooks/speak.ps1) può leggere a voce anche le risposte degli
agenti Claude Code (hook Stop/Notification in `C:\projects\.claude\settings.json`).
Al momento `disableAllHooks: true`: la voce è solo per Codex, come richiesto.

## Requisiti PC

ffmpeg (c'è), OpenSSH client (c'è), chiave `~/.ssh/spark_tunnel_key` (c'è),
Spark accesa. Installazione: `npx @vscode/vsce package` → `code --install-extension voice2agents-0.2.0.vsix`.
