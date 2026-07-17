# Voice2Agents — hook TTS: legge l'ultima risposta dell'agente e la dice a voce.
# Chiamato dagli hook di Claude Code (Stop / Notification). Legge il JSON dell'evento
# da stdin, estrae il testo, lo manda a /tts sulla Spark (via tunnel localhost:8900)
# e riproduce l'mp3. Tutto in locale: il testo non esce dalla LAN/tailnet.
param()
$ErrorActionPreference = 'SilentlyContinue'

# Kill switch: se esiste il file MUTE, niente voce (crearlo/cancellarlo per mutare/riattivare).
if (Test-Path 'C:\projects\voice2agents\MUTE') { exit 0 }

$raw = [Console]::In.ReadToEnd()
if (-not $raw) { exit 0 }
$evt = $raw | ConvertFrom-Json
if (-not $evt) { exit 0 }

# ── Testo da pronunciare ──────────────────────────────────────────────
$testo = $null
if ($evt.hook_event_name -eq 'Notification') {
    # Richiesta di attenzione (permessi, input): frase breve e diretta.
    $testo = "Serve il tuo intervento. " + $evt.message
} else {
    # Stop: ultima risposta dell'assistente dal transcript JSONL.
    $tp = $evt.transcript_path
    if (-not $tp -or -not (Test-Path -LiteralPath $tp)) { exit 0 }
    $lastText = $null
    # -Encoding UTF8 obbligatorio: il transcript e' UTF-8 senza BOM e PS 5.1
    # altrimenti lo legge come ANSI storpiando tutti gli accenti nel TTS.
    foreach ($line in Get-Content -LiteralPath $tp -Encoding UTF8) {
        $j = $line | ConvertFrom-Json
        if ($j.type -eq 'assistant' -and $j.message.content) {
            $parts = @($j.message.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
            if ($parts.Count -gt 0) { $lastText = ($parts -join ' ') }
        }
    }
    if (-not $lastText) { exit 0 }
    $testo = $lastText
}

# Pulizia: via markdown pesante e blocchi di codice, tienila corta per il TTS.
$testo = $testo -replace '(?s)```.*?```', ' (codice omesso) '
$testo = $testo -replace '[#*_`|>\[\]()]', ' '
$testo = ($testo -replace '\s+', ' ').Trim()
if ($testo.Length -lt 3) { exit 0 }
if ($testo.Length -gt 400) { $testo = $testo.Substring(0, 400) + ' ... il resto lo trovi a schermo.' }

# ── TTS sulla Spark ───────────────────────────────────────────────────
$body = @{ testo = $testo } | ConvertTo-Json -Compress
try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:8900/tts' -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec 60
} catch { exit 0 }
if (-not $resp.audio) { exit 0 }

# Spazza gli mp3 orfani di esecuzioni precedenti (Remove-Item puo' fallire a caldo).
try { Get-ChildItem -Path (Join-Path $env:TEMP 'voice2agents_tts_*.mp3') -ErrorAction Stop | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-10) } | Remove-Item -Force } catch {}

$mp3 = Join-Path $env:TEMP "voice2agents_tts_$PID.mp3"
[IO.File]::WriteAllBytes($mp3, [Convert]::FromBase64String($resp.audio))

# Lock: mentre parla l'assistente, l'estensione scarta cio' che sente il microfono.
$lock = Join-Path $env:TEMP 'voice2agents-speaking.lock'
Set-Content -Path $lock -Value 'speaking' -Force

try {
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open([Uri]$mp3)
    # Aspetta che i metadati (durata) siano pronti, poi riproduci per intero.
    $deadline = (Get-Date).AddSeconds(10)
    while (-not $player.NaturalDuration.HasTimeSpan -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    $player.Play()
    if ($player.NaturalDuration.HasTimeSpan) {
        $ms = $player.NaturalDuration.TimeSpan.TotalMilliseconds
        $elapsed = 0
        while ($elapsed -lt $ms) {
            Start-Sleep -Milliseconds 250
            $elapsed += 250
            # Tieni fresco il lock durante la riproduzione.
            (Get-Item $lock).LastWriteTime = Get-Date
        }
    } else {
        Start-Sleep -Seconds 8
    }
    $player.Close()
} finally {
    # Tieni vivo il lock oltre il silenzio che chiude un chunk lato estensione
    # (silenceSec 1.2s + margine), altrimenti l'ultima frase del TTS viene trascritta.
    $end = (Get-Date).AddMilliseconds(2600)
    while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 250; try { (Get-Item $lock).LastWriteTime = Get-Date } catch {} }
    Remove-Item $lock -Force
    try { Remove-Item $mp3 -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 300; try { Remove-Item $mp3 -Force } catch {} }
}
exit 0
