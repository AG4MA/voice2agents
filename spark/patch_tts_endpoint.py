#!/usr/bin/env python3
"""Aggiunge l'endpoint POST /tts a voice_server.py sulla Spark (idempotente).

Da lanciare sulla Spark dentro ~/projects/ai-voice-os:
    python3 patch_tts_endpoint.py && sudo systemctl restart voice-os

/tts: body JSON {"testo": "..."} -> {"audio": "<mp3 base64>"} via Kokoro locale.
Serve al client vocale su PC per far parlare gli agenti.
Non tocca nient'altro del server live (che e' piu' avanti del repo su PC).
"""
from pathlib import Path

path = Path("app/voice_server.py")
text = path.read_text(encoding="utf-8")

NEW_BLOCK = '''            if p.path == "/tts":
                data = json.loads(self._body() or b"{}")
                testo = (data.get("testo") or "").strip()
                if not testo:
                    self._send(400, b'{"error":"testo mancante"}'); return
                audio = tts_audio(testo[:1200])
                if not audio:
                    self._send(503, b'{"error":"tts non pronto"}'); return
                self._send(200, json.dumps({"audio": audio}).encode()); return
'''

ANCHOR = '            if p.path == "/stt":\n'

if '"/tts"' in text:
    print("Gia' patchato: /tts presente, nessuna modifica.")
    raise SystemExit(0)

count = text.count(ANCHOR)
if count != 1:
    raise SystemExit(f"Ancora attesa 1 volta, trovata {count}: file diverso dal previsto, non tocco nulla.")

text = text.replace(ANCHOR, NEW_BLOCK + ANCHOR, 1)
path.write_text(text, encoding="utf-8")
print("OK: endpoint /tts aggiunto. Ora: sudo systemctl restart voice-os")
