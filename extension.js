"use strict";
// Voice2Agents — conversazione a voce con Codex in VSCode:
//   1. Entri in VSCode: c'è UN pulsante in status bar ("Codex: collega una chat").
//   2. Click → lista delle chat agentiche aperte (sessioni Codex) → ne clicchi una.
//   3. Si collega a quella → parte l'ASCOLTO FISSO (un ffmpeg perenne, mai staccato).
//   4. Conversazione: quando Codex ha qualcosa da chiederti te lo dice a voce, in modo
//      umano e corto; se parli tu, si trascrive e si invia. Niente wake word: connesso
//      = tutto quello che dici va a quella chat.
//   5. Altro click sul pulsante = STOP TOTALE IMMEDIATO (voce zittita anche a metà
//      frase, mic chiuso, code svuotate).
// Tutto in locale via DGX Spark (Whisper/Kokoro, tunnel SSH ristretto voice-tunnel).
const vscode = require("vscode");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const EXT = "Voice2Agents";
const SPEAKING_LOCK = path.join(os.tmpdir(), "voice2agents-speaking.lock");
const MUTE_FILE = "C:\\projects\\voice2agents\\MUTE";
const CODEX_SESSIONS = path.join(process.env.USERPROFILE || "", ".codex", "sessions");

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * 2;
const PREROLL_FRAMES = 15;

let statusBar;
let output;
let connectedTo = null;   // percorso della sessione collegata; null = scollegato
let connectedLabel = "";
let connectedUuid = "";   // UUID della sessione: destinazione di `codex exec resume`
let connectedCwd = "";    // cwd della sessione, usato come working dir dell'exec
let codexExe = null;
let sendQueue = Promise.resolve(); // gli invii a Codex vanno in fila, mai in parallelo
let execChild = null;     // exec resume in corso (da uccidere allo stop)
let pendingTexts = [];    // tronconi di parlato in attesa: si accorpano in UN messaggio
let pendingSendTimer = null;
let stopping = false;
let audioProc = null;
let audioRetryTimer = null;
let vad = null;
let transcribeQueue = Promise.resolve();
let retryQueue = [];
let tunnelProc = null;
let tunnelTimer = null;
let ffmpegCmd = null;
let micName = null;
let playbackCount = 0;
let playbackProc = null;
const allPlayers = new Set();
let recentTts = [];
let spokenRecently = new Map();
let pendingSpeak = null;
let pendingSpeakTimer = null;
let lastReplyFull = ""; // ultima risposta di Codex per intero: per "rileggi"/"leggi tutto"
let speakChain = Promise.resolve();
let errorUntil = 0;
let codexWatch = null;
let extVersion = "?";
let chatPanel = null;
let chatLog = []; // { role: 'user'|'assistant'|'sys', text }

function cfg() {
  return vscode.workspace.getConfiguration("voice2agents");
}

const LOG_FILE = path.join(os.tmpdir(), "voice2agents.log");

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  output.appendLine(line);
  try {
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.unlinkSync(LOG_FILE); } catch {}
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// Bip di conferma: "ti ho sentito e ho inviato" — feedback immediato senza parole.
function beep(freq, ms) {
  if (!cfg().get("beep", true)) return;
  const p = spawn("powershell.exe", ["-NoProfile", "-Command", `[console]::beep(${freq},${ms})`],
    { stdio: "ignore", windowsHide: true });
  p.on("error", () => {});
}

function connected() {
  return connectedTo !== null;
}

// ── ffmpeg / microfono ─────────────────────────────────────

function findFfmpeg() {
  if (ffmpegCmd) return ffmpegCmd;
  try {
    execSync("where ffmpeg", { timeout: 3000, windowsHide: true, stdio: "ignore" });
    return (ffmpegCmd = "ffmpeg");
  } catch { /* non in PATH */ }
  const home = process.env.USERPROFILE || "";
  const dirs = [
    path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links"),
    path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Packages"),
    "C:\\ffmpeg\\bin",
    "C:\\ProgramData\\chocolatey\\bin",
  ];
  for (const dir of dirs) {
    const direct = path.join(dir, "ffmpeg.exe");
    if (fs.existsSync(direct)) return (ffmpegCmd = direct);
    const found = findFileRecursive(dir, "ffmpeg.exe", 4);
    if (found) return (ffmpegCmd = found);
  }
  throw new Error("ffmpeg non trovato. Installa con: winget install Gyan.FFmpeg e riavvia VSCode.");
}

let ffplayCmd = null;
function findFfplay() {
  if (ffplayCmd !== null) return ffplayCmd || null;
  try {
    execSync("where ffplay", { timeout: 3000, windowsHide: true, stdio: "ignore" });
    return (ffplayCmd = "ffplay");
  } catch { /* non in PATH */ }
  try {
    const f = findFfmpeg();
    if (f !== "ffmpeg") {
      const cand = path.join(path.dirname(f), "ffplay.exe");
      if (fs.existsSync(cand)) return (ffplayCmd = cand);
    }
  } catch {}
  ffplayCmd = "";
  return null;
}

function findFileRecursive(dir, filename, depth) {
  if (depth <= 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === filename) return full;
    if (e.isDirectory()) {
      const found = findFileRecursive(full, filename, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function detectMicrophone() {
  if (micName) return Promise.resolve(micName);
  const ffmpeg = findFfmpeg();
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ["-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("close", () => {
      const m = out.match(/"([^"]+)"\s*\(audio\)/);
      if (m) { micName = m[1]; resolve(micName); }
      else reject(new Error("Nessun microfono trovato: controlla che sia collegato e abilitato."));
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg non parte: ${err.message}`)));
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("Timeout rilevamento microfono")); }, 5000);
  });
}

// ── Stream audio fisso + VAD in memoria ────────────────────

function silenceThreshold() {
  const db = parseFloat(String(cfg().get("silenceDb", "-35dB")));
  return Math.pow(10, (isNaN(db) ? -35 : db) / 20);
}

function frameRms(buf, offset) {
  let sum = 0;
  const n = FRAME_BYTES / 2;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(offset + i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

async function startAudio() {
  if (audioProc || stopping || !connected()) return;
  const proc = spawn(findFfmpeg(), [
    "-hide_banner", "-loglevel", "error",
    "-f", "dshow",
    "-i", `audio=${micName}`,
    "-ar", String(SAMPLE_RATE),
    "-ac", "1",
    "-f", "s16le",
    "-",
  ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  audioProc = proc;
  resetVad();
  let leftover = Buffer.alloc(0);
  proc.stdout.on("data", (data) => {
    let buf = leftover.length ? Buffer.concat([leftover, data]) : data;
    let off = 0;
    while (buf.length - off >= FRAME_BYTES) {
      processFrame(buf, off);
      off += FRAME_BYTES;
    }
    leftover = Buffer.from(buf.slice(off));
  });
  proc.once("close", (code) => {
    if (audioProc === proc) audioProc = null;
    if (stopping || !connected()) return;
    log(`Stream microfono caduto (codice ${code}), riapro tra 2s`);
    scheduleAudioRetry(2000);
  });
  proc.once("error", (e) => {
    if (audioProc === proc) audioProc = null;
    if (stopping || !connected()) return;
    log(`Stream microfono errore: ${e.message}`);
    scheduleAudioRetry(5000);
  });
  log(`Microfono aperto fisso (${micName})`);
}

function scheduleAudioRetry(ms) {
  if (audioRetryTimer || stopping) return;
  audioRetryTimer = setTimeout(() => { audioRetryTimer = null; if (connected()) startAudio(); }, ms);
}

function resetVad() {
  vad = {
    inSpeech: false,
    voicedRunMs: 0,
    silenceRunMs: 0,
    preroll: [],
    frames: [],
    speechMs: 0,
    tainted: false,
  };
}

function processFrame(buf, off) {
  const v = vad;
  if (!v || !connected()) return;
  const frame = Buffer.from(buf.slice(off, off + FRAME_BYTES));
  const voiced = frameRms(buf, off) > silenceThreshold();

  if (!v.inSpeech) {
    v.preroll.push(frame);
    if (v.preroll.length > PREROLL_FRAMES) v.preroll.shift();
    if (voiced) {
      v.voicedRunMs += FRAME_MS;
      if (v.voicedRunMs >= 60) {
        v.inSpeech = true;
        v.frames = v.preroll.slice();
        v.preroll = [];
        v.speechMs = v.voicedRunMs;
        v.silenceRunMs = 0;
        v.tainted = !cfg().get("bargeIn", false) && assistantIsSpeaking();
        if (cfg().get("bargeIn", false) && playbackProc) {
          try { playbackProc.kill(); } catch {}
          log("Barge-in: ti ascolto");
        }
      }
    } else {
      v.voicedRunMs = 0;
    }
    return;
  }

  v.frames.push(frame);
  if (!cfg().get("bargeIn", false) && assistantIsSpeaking()) v.tainted = true;
  if (voiced) {
    v.speechMs += FRAME_MS;
    v.silenceRunMs = 0;
  } else {
    v.silenceRunMs += FRAME_MS;
  }

  const maxed = v.frames.length * FRAME_MS >= cfg().get("maxChunkSec", 45) * 1000;
  if (v.silenceRunMs >= cfg().get("silenceSec", 0.8) * 1000 || maxed) {
    const segment = { frames: v.frames, speechMs: v.speechMs, tainted: v.tainted };
    resetVad();
    finishSegment(segment);
  }
}

function finishSegment(seg) {
  if (!connected()) return;
  if (seg.speechMs < cfg().get("minSpeechSec", 0.6) * 1000) return;
  // Anche i segmenti "sporchi" (registrati mentre parlava lui) si trascrivono:
  // servono a captare "basta/zitto" detto sopra la sua voce. Non vanno mai in chat.
  const wav = pcmToWav(Buffer.concat(seg.frames));
  const soloStop = !!seg.tainted;
  transcribeQueue = transcribeQueue.then(() => transcribeSegment(wav, soloStop)).catch(() => {});
}

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribeSegment(wav, soloStop = false) {
  if (!connected()) return;
  try {
    setStatus("elaboro");
    const t0 = Date.now();
    const url = `${cfg().get("backendUrl")}/stt?lang=${cfg().get("language", "it")}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: wav,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`STT HTTP ${resp.status}`);
    const text = ((await resp.json()).text || "").trim();
    const sttMs = Date.now() - t0;
    if (!text) { log(`STT ${sttMs}ms: (vuoto)`); return; }
    if (!connected()) return; // scollegato mentre trascriveva: non mandare nulla
    if (soloStop) {
      // Registrato mentre lui parlava: vale SOLO come eventuale "basta".
      if (comandoStop(normalizza(text))) { log(`STOP a voce sopra la lettura: "${text}"`); fermaLettura(); }
      else log(`(sovrapposto alla voce, ignorato) "${text}"`);
      return;
    }
    if (isEchoOfTts(text)) { log(`STT ${sttMs}ms, eco scartata: "${text}"`); return; }
    log(`STT ${sttMs}ms — TU → "${text}"`);
    beep(880, 120); // ti ho sentito: parte l'invio
    await deliverText(text);
  } catch (e) {
    const netErr = /fetch|ECONNREFUSED|ETIMEDOUT|abort|network|socket/i.test(String(e && e.message));
    if (netErr) {
      retryQueue.push({ wav, addedAt: Date.now() });
      if (retryQueue.length > 5) retryQueue.shift();
      setStatusError("Spark non raggiungibile: frase in coda, riprovo appena torna il tunnel");
    } else {
      setStatusError(`trascrizione fallita: ${e.message}`);
    }
    log(`Trascrizione fallita: ${e.message}`);
  } finally {
    refreshStatus();
  }
}

function flushRetryQueue() {
  if (!retryQueue.length || !connected()) return;
  const now = Date.now();
  const batch = retryQueue.splice(0);
  for (const item of batch) {
    if (now - item.addedAt > 5 * 60 * 1000) continue;
    log("Riprovo una frase rimasta in coda");
    transcribeQueue = transcribeQueue.then(() => transcribeSegment(item.wav)).catch(() => {});
  }
}

// ── Tunnel SSH verso la Spark ──────────────────────────────

function backendPort() {
  try { return new URL(cfg().get("backendUrl")).port || "8900"; } catch { return "8900"; }
}

function portReachable(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port, timeout: 700 });
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("timeout", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(false));
  });
}

function tunnelKey() {
  const custom = cfg().get("tunnelKeyPath", "");
  if (custom) return custom;
  return path.join(process.env.USERPROFILE || "", ".ssh", "spark_tunnel_key");
}

async function tunnelTick() {
  if (!cfg().get("tunnelEnabled", true)) return;
  const port = backendPort();
  if (await portReachable(port)) { flushRetryQueue(); return; }
  if (tunnelProc && tunnelProc.exitCode === null) return;
  const host = cfg().get("tunnelHost", "");
  if (!host) { log("Configura voice2agents.tunnelHost nelle impostazioni (es. voice-tunnel@100.x.y.z)"); return; }
  log(`Tunnel giù, riapro: ssh -N -L ${port} ${host}`);
  tunnelProc = spawn("ssh", [
    "-i", tunnelKey(),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=20",
    "-N",
    "-L", `${port}:127.0.0.1:${port}`,
    host,
  ], { stdio: "ignore", windowsHide: true });
  tunnelProc.on("error", (e) => log(`Errore ssh: ${e.message} (OpenSSH Client installato?)`));
}

function startTunnelWatchdog() {
  if (tunnelTimer) return;
  tunnelTick();
  tunnelTimer = setInterval(tunnelTick, 12000);
}

function stopTunnelWatchdog() {
  if (tunnelTimer) { clearInterval(tunnelTimer); tunnelTimer = null; }
  if (tunnelProc) { try { tunnelProc.kill(); } catch {} tunnelProc = null; }
}

// ── Anti-eco ───────────────────────────────────────────────

function assistantIsSpeaking() {
  if (playbackCount > 0) return true;
  try {
    const st = fs.statSync(SPEAKING_LOCK);
    return Date.now() - st.mtimeMs < 3000;
  } catch { return false; }
}

function normalizeWords(t) {
  return String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

function isEchoOfTts(text) {
  const words = normalizeWords(text);
  if (words.length < 3) return false;
  const now = Date.now();
  recentTts = recentTts.filter((e) => now - e.at < 60000);
  for (const e of recentTts) {
    const hit = words.filter((w) => e.words.has(w)).length;
    if (hit / words.length >= 0.7) return true;
  }
  return false;
}

// ── Consegna del testo DENTRO la chat scelta (codex exec resume) ──

function findCodexExe() {
  if (codexExe && fs.existsSync(codexExe)) return codexExe;
  const extRoot = path.join(process.env.USERPROFILE || "", ".vscode", "extensions");
  let dirs = [];
  try { dirs = fs.readdirSync(extRoot).filter((d) => d.startsWith("openai.chatgpt-")).sort(); } catch {}
  for (const d of dirs.reverse()) {
    const p = path.join(extRoot, d, "bin", "windows-x86_64", "codex.exe");
    if (fs.existsSync(p)) return (codexExe = p);
  }
  throw new Error("codex.exe non trovato: estensione Codex (openai.chatgpt) non installata?");
}

// Inietta il messaggio nella sessione scelta: l'agente continua LI', la risposta
// arriva nello stesso rollout e il watcher la legge. Zero UI, zero tastiera simulata.
// Bozza vocale: i tronconi si accumulano e SEI TU a decidere quando parte.
//   "invia" / "manda" / "vai così"  → parte subito
//   "aspetta" / "fammi pensare"     → resta in bozza a lungo (pensa pure)
//   "annulla tutto"                 → bozza cestinata
// Altrimenti: risposta corta → da sola dopo 2.5s; discorso lungo → dopo 7s di silenzio.
const PAROLE_INVIA = ["invia", "manda", "vai cosi", "vai così", "a te", "ho finito", "finito"];
const PAROLE_ATTESA = ["aspetta", "un attimo", "aspetta un attimo", "fammi pensare", "momento", "un momento", "no", "non ancora", "sto pensando", "sto riflettendo", "ci sto pensando"];
const PAROLE_ANNULLA = ["annulla", "annulla tutto", "cancella", "cancella tutto"];
const PAROLE_SI = ["si", "sì", "si ho finito", "sì ho finito", "yes"];
// "Basta/zitto/stop": ferma la lettura in corso e svuota la coda (resta connesso).
function comandoStop(norm) {
  return ["basta", "zitto", "stop", "ferma", "fermati", "basta cosi", "basta così", "silenzio", "stop lettura", "basta leggere"].includes(norm);
}

function fermaLettura() {
  for (const p of allPlayers) { try { p.kill(); } catch {} }
  allPlayers.clear();
  playbackProc = null;
  speakChain = Promise.resolve();
  log("Lettura fermata");
}

// Rilettura riconosciuta per INTENTO, generosa: qualunque frase CORTA che contiene
// il verbo ("me lo rileggi?", "dai rileggi", "allora leggi tutto") è un comando per
// l'assistente — MAI in chat. Eccezione: se parla di file/codice è un task per Codex.
function comandoRilettura(norm) {
  if (!norm) return false;
  if (norm.split(" ").length > 8) return false; // discorso lungo = contenuto
  if (!/\b(rileggi\w*|ripeti\w*|rileggere|ripetere|leggi\w*|leggere)\b/.test(norm)) return false;
  if (/\b(file|codice|funzione|classe|test|log|documento|readme|cartella|riga|commit|branch)\b/.test(norm)) return false;
  return true;
}

// Parole italiane che lasciano la frase APERTA: se il discorso finisce qui,
// l'utente sta ancora pensando, non ha concluso.
const FINALI_APERTI = new Set([
  "e", "ma", "però", "pero", "quindi", "allora", "cioè", "cioe", "tipo", "che",
  "per", "con", "di", "da", "in", "su", "a", "al", "alla", "il", "lo", "la",
  "un", "una", "poi", "anche", "o", "oppure", "se", "perché", "perche",
  "mentre", "dove", "quando", "come", "più", "piu", "meno", "ehm", "uhm",
  "mmm", "insomma", "diciamo", "praticamente", "magari", "vorrei", "voglio",
  "devi", "dovresti", "dovrebbe", "tra", "fra", "del", "della", "dei", "delle",
  "questo", "questa", "quel", "quella", "non", "tutto", "però",
]);

function sembraIncompiuto(t) {
  const raw = String(t).trim();
  if (!raw) return false;
  if (/\.\.\.$/.test(raw)) return true;            // puntini: sospeso
  if (/[.!?]$/.test(raw)) return false;            // frase chiusa
  if (/[,;:]$/.test(raw)) return true;             // virgola/punto e virgola: sospeso
  const words = normalizza(raw).split(" ");
  return FINALI_APERTI.has(words[words.length - 1] || "");
}

function normalizza(t) {
  return String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

let hoChiestoSeFinito = false; // una domanda sola per giro, niente tormentone

function flushPending(motivo) {
  clearTimeout(pendingSendTimer);
  const msg = pendingTexts.join(" ").trim();
  pendingTexts = [];
  hoChiestoSeFinito = false;
  if (!msg) return;
  log(`INVIO (${motivo}): "${msg.slice(0, 100)}${msg.length > 100 ? "…" : ""}"`);
  sendMessage(msg);
}

function armaTimer(ms, azione) {
  clearTimeout(pendingSendTimer);
  pendingSendTimer = setTimeout(azione, ms);
}

function chiediSeFinito() {
  if (hoChiestoSeFinito) {
    // Già chiesto e nessuna risposta chiara: si tiene tutto, comanda lui.
    log("Bozza tenuta in attesa: parte solo se dice 'invia' o completa il discorso");
    speakChain = speakChain.then(() => playTts("Tengo tutto da parte. Continua pure, o dimmi invia.")).catch(() => {});
    return;
  }
  hoChiestoSeFinito = true;
  log("La frase sembra a metà: chiedo a voce");
  speakChain = speakChain.then(() => playTts("Hai finito o ci stai ancora pensando?")).catch(() => {});
  armaTimer(30000, chiediSeFinito);
}

// Io parlo, tu ascolti; quando ho FINITO invii. Il "quando ho finito" si capisce
// dal contenuto: frase chiusa → parte; frase sospesa → si aspetta e, se serve,
// si chiede a voce. La bozza non si butta MAI da sola.
// Lettura integrale a pezzi: mai troncata, frase per frase.
function speakFull(testo) {
  if (!testo) {
    speakChain = speakChain.then(() => playTts("Non ho una risposta da rileggere.")).catch(() => {});
    return;
  }
  let resto = testo;
  while (resto.length > 0) {
    let pezzo;
    if (resto.length <= 450) { pezzo = resto; resto = ""; }
    else {
      let cut = resto.lastIndexOf(". ", 450);
      if (cut < 200) cut = resto.lastIndexOf(" ", 450);
      if (cut < 1) cut = 450;
      pezzo = resto.slice(0, cut + 1).trim();
      resto = resto.slice(cut + 1).trim();
    }
    const p = pezzo;
    speakChain = speakChain.then(() => playTts(p)).catch(() => {});
  }
}

function deliverText(text) {
  const norm = normalizza(text);
  // "scrivi ...": tutto quello che segue va DRITTO in chat, nessuna interpretazione.
  if (norm === "scrivi") return Promise.resolve();
  if (norm.startsWith("scrivi ")) {
    const contenuto = text.replace(/^\s*scrivi[\s,.:]*/i, "").trim();
    if (contenuto) { pendingTexts.push(contenuto); flushPending("comando scrivi"); }
    return Promise.resolve();
  }
  // Comandi per ME (non vanno mai in chat):
  if (comandoStop(norm)) { fermaLettura(); return Promise.resolve(); }
  // Rilettura per INTENTO, non a stringa esatta — "rileggi ultima cosa che hai scritto", ecc.
  if (comandoRilettura(norm)) {
    log(`Comando di rilettura: "${norm}"`);
    speakFull(lastReplyFull);
    return Promise.resolve();
  }
  // Risposte alla mia domanda "hai finito?" e comandi secchi:
  if (PAROLE_INVIA.includes(norm) || (hoChiestoSeFinito && PAROLE_SI.includes(norm))) {
    flushPending("confermato a voce");
    return Promise.resolve();
  }
  if (PAROLE_ANNULLA.includes(norm)) {
    clearTimeout(pendingSendTimer);
    pendingTexts = [];
    hoChiestoSeFinito = false;
    log("Bozza annullata su tua richiesta");
    return Promise.resolve();
  }
  if (PAROLE_ATTESA.includes(norm)) {
    hoChiestoSeFinito = false;
    armaTimer(cfg().get("attesaEstesaSec", 60) * 1000, chiediSeFinito);
    log("Ok, penso che stai riflettendo: aspetto");
    return Promise.resolve();
  }
  // "…, invia" in coda alla frase: si stacca il comando e si parte subito.
  for (const w of PAROLE_INVIA) {
    if (norm.endsWith(" " + w)) {
      const cut = text.toLowerCase().lastIndexOf(w.split(" ")[0]);
      if (cut > 0) pendingTexts.push(text.slice(0, cut).trim());
      flushPending("hai detto invia");
      return Promise.resolve();
    }
  }
  pendingTexts.push(text);
  hoChiestoSeFinito = false;
  const totale = pendingTexts.join(" ").trim();
  if (sembraIncompiuto(totale)) {
    // Sta pensando: nessun invio automatico. Dopo 12s di silenzio si chiede a voce.
    armaTimer(12000, chiediSeFinito);
  } else {
    // Discorso compiuto: breve respiro e parte.
    armaTimer(totale.length < 40 ? 2500 : cfg().get("attesaInvioSec", 5) * 1000, () => flushPending("discorso concluso"));
  }
  return Promise.resolve();
}

// ── Pannello conversazione dell'estensione ─────────────────
// Il pannello di Codex non si aggiorna dall'esterno: questo è NOSTRO, vive sul
// file di sessione (stessa fonte della voce) e mostra tutto in tempo reale.
// La casella in fondo scrive nella stessa sessione degli invii vocali.

function postChat(role, text) {
  chatLog.push({ role, text });
  if (chatLog.length > 300) chatLog.shift();
  if (chatPanel) { try { chatPanel.webview.postMessage({ type: "msg", role, text }); } catch {} }
}

function ensureChatPanel() {
  if (chatPanel) {
    try { chatPanel.title = connectedLabel || "Conversazione"; chatPanel.reveal(undefined, true); } catch {}
    return;
  }
  chatPanel = vscode.window.createWebviewPanel(
    "voice2agentsChat",
    connectedLabel || "Conversazione",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  chatPanel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:var(--vscode-font-family);padding:0;margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);display:flex;flex-direction:column;height:100vh}
  #log{flex:1;overflow-y:auto;padding:10px}
  .m{margin:6px 0;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;max-width:92%;font-size:13px;line-height:1.45}
  .user{background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-left:auto}
  .assistant{background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border,#444)}
  .sys{opacity:.65;font-style:italic;text-align:center;background:none;font-size:12px}
  #bar{display:flex;padding:8px;gap:6px;border-top:1px solid var(--vscode-widget-border,#444)}
  #inp{flex:1;padding:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:6px;font-family:inherit}
  button{padding:8px 14px;border:none;border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
  </style></head><body>
  <div id="log"></div>
  <div id="bar"><input id="inp" placeholder="Scrivi agli agenti (Invio per mandare)"/><button id="btn">Invia</button></div>
  <script>
  const vs = acquireVsCodeApi();
  const log = document.getElementById('log'); const inp = document.getElementById('inp');
  function add(role, text){ const d = document.createElement('div'); d.className = 'm ' + role; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; }
  window.addEventListener('message', (e) => { const m = e.data; if (m.type === 'msg') add(m.role, m.text); });
  function send(){ const t = inp.value.trim(); if (!t) return; inp.value = ''; vs.postMessage({ type: 'send', text: t }); }
  document.getElementById('btn').onclick = send;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  vs.postMessage({ type: 'ready' });
  </script></body></html>`;
  chatPanel.webview.onDidReceiveMessage((m) => {
    if (!m) return;
    if (m.type === "ready") {
      for (const e of chatLog) { try { chatPanel.webview.postMessage({ type: "msg", role: e.role, text: e.text }); } catch {} }
    } else if (m.type === "send" && typeof m.text === "string" && m.text.trim()) {
      if (!connected()) { postChat("sys", "Non collegato: premi il bottone e scegli una chat"); return; }
      sendMessage(m.text.trim());
    }
  });
  chatPanel.onDidDispose(() => { chatPanel = null; });
}

// Invio DIRETTO nella sessione scelta (codex exec resume): completamente
// indipendente da cursore/focus — l'utente può fare altro mentre parla.
// La conversazione si VEDE nel pannello nostro (aggiornato dal rollout).
function sendMessage(text) {
  sendQueue = sendQueue.then(() => new Promise((resolve) => {
    if (!connected()) { resolve(); return; }
    let exe;
    try { exe = findCodexExe(); } catch (e) { setStatusError(e.message); resolve(); return; }
    const uuid = connectedUuid;
    log("Invio alla chat (indipendente dal tuo cursore)");
    const child = spawn(exe, ["exec", "resume", "--skip-git-repo-check", uuid, text], {
      cwd: connectedCwd && fs.existsSync(connectedCwd) ? connectedCwd : undefined,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    execChild = child;
    let errTail = "";
    child.stderr.on("data", (d) => { errTail = (errTail + d.toString()).slice(-400); });
    postChat("sys", "⏳ in lavorazione…");
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 30 * 60 * 1000);
    child.on("close", (code) => {
      clearTimeout(killer);
      if (execChild === child) execChild = null;
      if (code === 0) {
        log("Turno completato");
      } else if (connected()) {
        log(`Invio fallito (exit ${code}): ${errTail.split("\n").slice(-2).join(" ")}`);
        pendingTexts.unshift(text); // mai perdere nulla: torna in bozza
        postChat("sys", "⚠ invio fallito: testo tenuto in bozza");
        speakChain = speakChain.then(() => playTts("Non sono riuscito a inviare: tengo il messaggio da parte, dimmi invia per riprovare.")).catch(() => {});
      }
      resolve();
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      if (execChild === child) execChild = null;
      log(`Invio fallito: ${e.message}`);
      resolve();
    });
  })).catch(() => {});
  return Promise.resolve();
}

// ── Lista chat e collegamento ──────────────────────────────

function listRecentRollouts(giorni = 2) {
  const all = [];
  for (let i = 0; i < giorni; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(CODEX_SESSIONS,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"));
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      all.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// I titoli veri delle chat (quelli della history di Codex) stanno in session_index.jsonl.
function readSessionIndex() {
  const map = new Map(); // uuid → { name, updatedAt }
  try {
    const raw = fs.readFileSync(path.join(process.env.USERPROFILE || "", ".codex", "session_index.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.id && o.thread_name) map.set(o.id, { name: o.thread_name, updatedAt: o.updated_at || "" });
      } catch { /* riga rotta */ }
    }
  } catch { /* niente indice */ }
  return map;
}

function rolloutUuid(file) {
  const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m ? m[1] : "";
}

function sessionLabel(file) {
  // Ora della sessione dal nome file: rollout-2026-07-17T12-46-11-....jsonl
  const tm = path.basename(file).match(/T(\d{2})-(\d{2})-\d{2}/);
  const ora = tm ? `${tm[1]}:${tm[2]}` : "";
  let raw = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(262144); // la prima riga (session_meta) può essere enorme
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    raw = buf.slice(0, read).toString("utf8");
  } catch {
    return ora ? `sessione delle ${ora}` : path.basename(file);
  }
  // cwd e prima frase utente pescate con regex: reggono qualunque formato di riga.
  let cwd = "";
  const cwdM = raw.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (cwdM) { try { cwd = JSON.parse('"' + cwdM[1] + '"'); } catch {} }
  let firstUser = "";
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let t;
    try { t = JSON.parse('"' + m[1] + '"'); } catch { continue; }
    t = t.trim();
    // Salta instructions/environment (<user_instructions>, <environment_context>...) e blobs.
    if (!t || t.startsWith("<") || t.length > 4000) continue;
    firstUser = t;
    break;
  }
  const cwdShort = cwd ? (cwd.replace(/^.*[\\/]projects[\\/]?/i, "") || "projects") : "";
  const hint = firstUser ? `«${firstUser.replace(/\s+/g, " ").slice(0, 45)}${firstUser.length > 45 ? "…" : ""}»` : "";
  const parts = [cwdShort, hint].filter(Boolean).join(" — ");
  if (parts) return parts;
  return ora ? `sessione delle ${ora}` : path.basename(file);
}

async function pickAndConnect() {
  const rollouts = listRecentRollouts(14); // due settimane: le chat con titolo possono essere vecchie
  if (!rollouts.length) {
    vscode.window.showWarningMessage(`${EXT}: nessuna chat Codex trovata. Apri Codex, avvia una chat e riprova.`);
    return;
  }
  const byUuid = new Map();
  for (const r of rollouts) {
    const u = rolloutUuid(r.file);
    if (u && !byUuid.has(u)) byUuid.set(u, r); // il più recente vince (lista già ordinata)
  }
  const index = readSessionIndex();
  const items = [];
  const usati = new Set();

  // 1) Le chat coi TITOLI veri (come nella history di Codex), più recenti in alto.
  const titolate = [...index.entries()]
    .filter(([u]) => byUuid.has(u))
    .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
  for (const [u, info] of titolate) {
    usati.add(u);
    const quando = info.updatedAt ? new Date(info.updatedAt).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    items.push({
      label: `$(comment-discussion) ${info.name}`,
      description: quando,
      file: byUuid.get(u).file,
    });
  }

  // 2) Sessioni senza titolo (agenti, exec...): dedup per contenuto, tiene la più recente.
  const altre = [];
  const vistiLabel = new Set();
  for (const [u, r] of byUuid) {
    if (usati.has(u)) continue;
    if (Date.now() - r.mtimeMs > 36 * 3600 * 1000) continue; // solo le ultime 36h
    const lbl = sessionLabel(r.file);
    if (vistiLabel.has(lbl)) continue; // la stessa chat ripetuta con timestamp diversi: una sola
    vistiLabel.add(lbl);
    altre.push({
      label: `$(terminal) ${lbl}`,
      description: new Date(r.mtimeMs).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      file: r.file,
    });
    if (altre.length >= 8) break;
  }
  if (altre.length) {
    items.push({ label: "sessioni senza titolo (agenti)", kind: vscode.QuickPickItemKind.Separator });
    items.push(...altre);
  }

  if (!items.length) {
    vscode.window.showWarningMessage(`${EXT}: nessuna chat recente trovata.`);
    return;
  }
  const sel = await vscode.window.showQuickPick(items, {
    placeHolder: "A quale chat di Codex mi collego?",
  });
  if (!sel || !sel.file) return;
  await connectTo(sel.file);
}

function sessionCwd(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(262144);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.slice(0, read).toString("utf8").match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse('"' + m[1] + '"');
  } catch {}
  return "";
}

async function connectTo(file) {
  const um = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  if (!um) {
    vscode.window.showErrorMessage(`${EXT}: non riesco a ricavare l'ID sessione da ${path.basename(file)}`);
    return;
  }
  try {
    findFfmpeg();
    await detectMicrophone();
  } catch (e) {
    setStatusError(e.message);
    vscode.window.showErrorMessage(`${EXT}: ${e.message}`);
    return;
  }
  connectedTo = file;
  connectedUuid = um[1];
  connectedCwd = sessionCwd(file);
  const titolo = readSessionIndex().get(um[1]);
  connectedLabel = titolo ? titolo.name : sessionLabel(file);
  startCodexWatcher(file);
  startTunnelWatchdog();
  await startAudio();
  // Pannello conversazione NOSTRO: live sul file di sessione, non ruba mai il focus.
  ensureChatPanel();
  postChat("sys", `— Collegato a: ${connectedLabel} —`);
  refreshStatus();
  log(`COLLEGATO a: ${connectedLabel} — chat aperta nel pannello, parla pure`);
  vscode.window.setStatusBarMessage(`$(broadcast) Collegato: ${connectedLabel} — parla pure`, 5000);
  // Annuncio vocale: prima si aspetta che la Spark risponda (il tunnel può metterci qualche secondo).
  speakChain = speakChain.then(async () => {
    for (let i = 0; i < 20; i++) {
      if (await portReachable(backendPort())) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await playTts(`Collegato a ${connectedLabel}. Dimmi pure.`);
  }).catch(() => {});
}

// STOP TOTALE IMMEDIATO: voce, mic, code — tutto morto in questo istante.
function stopAll() {
  connectedTo = null;
  connectedLabel = "";
  connectedUuid = "";
  connectedCwd = "";
  sendQueue = Promise.resolve();
  pendingTexts = [];
  hoChiestoSeFinito = false;
  clearTimeout(pendingSendTimer);
  if (execChild) { try { execChild.kill(); } catch {} execChild = null; }
  for (const p of allPlayers) { try { p.kill(); } catch {} }
  allPlayers.clear();
  playbackProc = null;
  speakChain = Promise.resolve();
  spokenRecently.clear();
  pendingSpeak = null;
  clearTimeout(pendingSpeakTimer);
  if (audioRetryTimer) { clearTimeout(audioRetryTimer); audioRetryTimer = null; }
  if (audioProc) { try { audioProc.kill(); } catch {} audioProc = null; }
  resetVad();
  retryQueue = [];
  stopCodexWatcher();
  refreshStatus();
  postChat("sys", "— Scollegato —");
  log("STOP TOTALE: scollegato, mic chiuso, voce zittita");
  vscode.window.setStatusBarMessage("$(mute) Voce Codex FERMATA", 3000);
}

async function toggle() {
  if (connected()) stopAll();
  else await pickAndConnect();
}

// ── Voce di Codex: watcher sulla sessione scelta + TTS ─────

function startCodexWatcher(file) {
  stopCodexWatcher();
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  codexWatch = {
    file,
    offset: size, // solo quello che arriva DA ORA: mai lo storico
    carry: "",
    lastSizes: new Map(), // dimensioni note dei rollout recenti: chi cresce è la chat viva
    recent: [],
    dirRescanAt: 0,
    afterSendUntil: 0,    // finestra post-invio per agganciare la chat a schermo
    sendDetected: true,
    timer: setInterval(codexWatchTick, 500),
  };
}

function stopCodexWatcher() {
  if (!codexWatch) return;
  clearInterval(codexWatch.timer);
  codexWatch = null;
}

function extractUserText(obj) {
  const p = obj && obj.payload ? obj.payload : obj;
  if (!p) return null;
  let t = null;
  if (p.type === "user_message" && typeof p.message === "string") t = p.message;
  else {
    const role = p.role || (p.message && p.message.role);
    const content = p.content || (p.message && p.message.content);
    if (role === "user" && Array.isArray(content)) {
      const parts = content.filter((c) => c && typeof c.text === "string").map((c) => c.text);
      if (parts.length) t = parts.join(" ");
    }
  }
  if (!t) return null;
  t = t.trim();
  if (!t || t.startsWith("<") || t.length > 4000) return null; // instructions/environment
  return t;
}

const shownRecently = new Map(); // dedup pannello: il rollout scrive doppioni
function giaMostrato(text) {
  const key = normalizeWords ? normalizeWords(text).join(" ") : text;
  const now = Date.now();
  for (const [k, ts] of shownRecently) { if (now - ts > 120000) shownRecently.delete(k); }
  if (shownRecently.has(key)) return true;
  shownRecently.set(key, now);
  return false;
}

function extractAssistantText(obj) {
  const p = obj && obj.payload ? obj.payload : obj;
  if (!p) return null;
  if (p.type === "agent_message" && typeof p.message === "string") return p.message;
  const role = p.role || (p.message && p.message.role);
  const content = p.content || (p.message && p.message.content);
  if (role === "assistant" && Array.isArray(content)) {
    const parts = content
      .filter((c) => c && typeof c.text === "string" && (c.type === "output_text" || c.type === "text"))
      .map((c) => c.text);
    if (parts.length) return parts.join(" ");
  }
  return null;
}

function codexWatchTick() {
  const w = codexWatch;
  if (!w || !connected()) return;
  const now = Date.now();
  // Censimento dei rollout recenti (cache 5s): chi cresce è la chat davvero attiva.
  if (now >= w.dirRescanAt) {
    w.dirRescanAt = now + 5000;
    w.recent = listRecentRollouts(2).slice(0, 25).map((r) => r.file);
  }
  for (const f of w.recent) {
    let stf;
    try { stf = fs.statSync(f); } catch { continue; }
    const prev = w.lastSizes.get(f);
    w.lastSizes.set(f, stf.size);
    if (prev === undefined || stf.size <= prev) continue;
    if (f === w.file) { w.sendDetected = true; continue; }
    if (now < w.afterSendUntil) {
      // Subito dopo un NOSTRO invio è cresciuta UN'ALTRA sessione: la chat a schermo
      // è quella — la voce si sposta lì e continua da quel punto (niente storico).
      w.sendDetected = true;
      w.file = f;
      w.offset = prev;
      w.carry = "";
      const t = readSessionIndex().get(rolloutUuid(f));
      const nuova = t ? t.name : sessionLabel(f);
      if (nuova !== connectedLabel) {
        log(`La chat a schermo è "${nuova}", non quella scelta dalla lista: ti seguo lì`);
        connectedLabel = nuova;
        refreshStatus();
      }
    }
  }
  let st;
  try { st = fs.statSync(w.file); } catch { return; }
  if (st.size <= w.offset) return;
  let fd;
  try {
    fd = fs.openSync(w.file, "r");
    const len = st.size - w.offset;
    const buf = Buffer.alloc(Math.min(len, 1024 * 1024));
    const read = fs.readSync(fd, buf, 0, buf.length, w.offset);
    w.offset += read;
    const chunk = w.carry + buf.slice(0, read).toString("utf8");
    const lines = chunk.split("\n");
    w.carry = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const at = extractAssistantText(obj);
      if (at) {
        if (!giaMostrato(at)) { postChat("assistant", at); speakText(at); }
        continue;
      }
      const ut = extractUserText(obj);
      if (ut && !giaMostrato(ut)) postChat("user", ut);
    }
  } catch (e) {
    log(`Watcher Codex: ${e.message}`);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function speakText(raw) {
  if (!connected()) return;
  if (!cfg().get("voceCodex", true)) return;
  if (fs.existsSync(MUTE_FILE)) return;
  let testo = String(raw)
    .replace(/```[\s\S]*?```/g, " (codice omesso) ")
    .replace(/[#*_`|>\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (testo.length < 3) return;
  const key = normalizeWords(testo).join(" ");
  const now = Date.now();
  for (const [k, t] of spokenRecently) { if (now - t > 120000) spokenRecently.delete(k); }
  if (spokenRecently.has(key)) return; // doppione del rollout
  spokenRecently.set(key, now);
  lastReplyFull = testo; // conservata integrale: "rileggi"
  // Si legge TUTTO quello che scrive, integrale e in ordine. Per zittirlo: "basta".
  speakFull(testo);
}

async function playTts(testo) {
  if (!connected()) return;
  if (fs.existsSync(MUTE_FILE)) return;
  log(`CODEX → "${testo}"`);
  let mp3Path = null;
  playbackCount++;
  recentTts.push({ words: new Set(normalizeWords(testo)), at: Date.now() });
  if (recentTts.length > 10) recentTts.shift();
  try {
    const resp = await fetch(`${cfg().get("backendUrl")}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ testo }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    const audio = (await resp.json()).audio;
    if (!audio) throw new Error("TTS senza audio");
    if (!connected()) return; // fermato mentre generava: non partire proprio
    mp3Path = path.join(os.tmpdir(), `voice2agents_play_${Date.now()}.mp3`);
    fs.writeFileSync(mp3Path, Buffer.from(audio, "base64"));
    if (!connected()) return;
    await new Promise((resolve) => {
      // ffplay suona fino alla FINE REALE del file ed esce da solo: gli mp3 di
      // Kokoro dichiarano durate sballate e MediaPlayer troncava la lettura.
      const ffplay = findFfplay();
      let p;
      if (ffplay) {
        p = spawn(ffplay, ["-nodisp", "-autoexit", "-loglevel", "quiet", mp3Path],
          { stdio: "ignore", windowsHide: true });
      } else {
        p = spawn("powershell.exe", [
          "-NoProfile", "-STA", "-Command",
          `Add-Type -AssemblyName PresentationCore; $pl = New-Object System.Windows.Media.MediaPlayer; ` +
          `$pl.Open([Uri]'${mp3Path.replace(/'/g, "''")}'); ` +
          `$dl = (Get-Date).AddSeconds(10); while (-not $pl.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $dl) { Start-Sleep -Milliseconds 100 }; ` +
          `$pl.Play(); Start-Sleep -Milliseconds 500; ` +
          `while ($pl.Position -lt $pl.NaturalDuration.TimeSpan -or -not $pl.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 250; if ((Get-Date) -gt $dl.AddMinutes(3)) { break } }; ` +
          `$pl.Close()`,
        ], { stdio: "ignore", windowsHide: true });
      }
      playbackProc = p;
      allPlayers.add(p);
      p.on("close", () => { allPlayers.delete(p); resolve(); });
      p.on("error", () => { allPlayers.delete(p); resolve(); });
      setTimeout(resolve, 180000);
    });
  } catch (e) {
    log(`Voce di Codex fallita: ${e.message}`);
  } finally {
    playbackProc = null;
    // Grace corta: quando lui finisce di parlare, TU rispondi subito — è il caso
    // normale di una conversazione. 400ms coprono la coda d'eco delle casse senza
    // mangiarsi la tua risposta immediata (i sovrapposti veri li becca il taint).
    const grace = cfg().get("bargeIn", false) ? 100 : 400;
    setTimeout(() => { playbackCount = Math.max(0, playbackCount - 1); }, grace);
    if (mp3Path) setTimeout(() => { try { fs.unlinkSync(mp3Path); } catch {} }, 5000);
  }
}

// ── Status bar ─────────────────────────────────────────────

function setStatus(state, detail) {
  if (!statusBar) return;
  if (state !== "errore" && Date.now() < errorUntil) return;
  if (state === "ascolto") {
    statusBar.text = `$(broadcast) Codex: connesso · v${extVersion}`;
    statusBar.tooltip = detail || `Collegato a: ${connectedLabel}\nTi ascolto: parla e invio; lui ti risponde a voce.\nDi' «invia» per mandare subito, «aspetta» per pensare con calma.\nClick = STOP totale immediato.`;
    statusBar.backgroundColor = undefined;
  } else if (state === "elaboro") {
    statusBar.text = "$(loading~spin) Codex: trascrivo";
    statusBar.tooltip = "Trascrizione sulla Spark...";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else if (state === "errore") {
    statusBar.text = "$(warning) Codex: problema";
    statusBar.tooltip = detail || "Errore";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBar.text = `$(mic) Codex: collega una chat · v${extVersion}`;
    statusBar.tooltip = "Click: scegli la chat di Codex e parte la conversazione a voce";
    statusBar.backgroundColor = undefined;
  }
  statusBar.command = "voice2agents.toggle";
}

function setStatusError(detail) {
  errorUntil = 0;
  setStatus("errore", detail);
  errorUntil = Date.now() + 5000;
  setTimeout(refreshStatus, 5200);
}

function refreshStatus() {
  if (Date.now() < errorUntil) return;
  if (connected()) setStatus("ascolto");
  else setStatus("spento");
}

// ── Lifecycle ──────────────────────────────────────────────

function activate(context) {
  output = vscode.window.createOutputChannel(EXT);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  extVersion = (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || "?";
  log(`Voice2Agents v${extVersion} attivo`);
  startTunnelWatchdog(); // tunnel caldo da subito: l'annuncio vocale al collegamento non fallisce
  refreshStatus();
  statusBar.show();
  context.subscriptions.push(statusBar, output);
  context.subscriptions.push(vscode.commands.registerCommand("voice2agents.toggle", toggle));
  context.subscriptions.push(vscode.commands.registerCommand("voice2agents.pickSession", pickAndConnect));
}

function deactivate() {
  stopping = true;
  stopAll();
  stopTunnelWatchdog();
}

module.exports = { activate, deactivate };
