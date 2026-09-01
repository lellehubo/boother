# BOOTHER

En fristående webbapp som ser ut som en skandinavisk fotoautomat från 60-talet
och gör fyra passfoton av en selfie. Statisk `index.html` på GitHub Pages + en
Supabase edge function som proxar mot Google Nano Banana Pro.

## Struktur

```
index.html                       # Hela gränssnittet, kamera, capture, nedladdning
sw.js                            # Service worker — app-shell offline
manifest.json                    # PWA-manifest — spara på hemskärmen
icon.svg / icon-180/192/512      # Retro-kamera-ikon (SVG + PNG för iOS/Android)
supabase/functions/passfoto/     # Proxyn: håller nyckeln, anropar Gemini
```

## Kör lokalt

Kameran kräver HTTPS eller `localhost`. Enklast:

```bash
python -m http.server 8000
# öppna http://localhost:8000
```

Utan proxy (`PROXY_URL = ""` i `index.html`) kör appen i **testläge**: hela
flödet fungerar men remsan visar råbilden istället för framkallade foton.

## Deploy — sida

1. Pusha repot till GitHub, `index.html` i roten.
2. Settings → Pages → Deploy from branch → `main` / root.
3. Sätt `PROXY_URL` i `index.html` till din function-URL (se nedan).

## Proxy (Supabase) — DEPLOYAD

Funktionen `passfoto` är deployad i projektet `cntmgjiomjjivdngnqui`
(lelle.hultman.boye@gmail.com's Project) med `verify_jwt = false`.

Function-URL (redan inlagd i `index.html`):
`https://cntmgjiomjjivdngnqui.supabase.co/functions/v1/passfoto`

### Kvarvarande steg: sätt nyckeln

`ALLOWED_ORIGIN` har rätt default i koden (`https://lellehubo.github.io`),
så bara `GEMINI_API_KEY` behöver sättas. Gör det på ett av två sätt:

**Dashboard (nyckeln hamnar inte i terminalhistoriken):**
Supabase → projektet → Edge Functions → Secrets → lägg till
`GEMINI_API_KEY`. Hämta nyckeln i Google AI Studio.

**CLI (i din egen terminal):**
```bash
supabase secrets set GEMINI_API_KEY=din-nyckel --project-ref cntmgjiomjjivdngnqui
```

### Testa proxyn med curl

```bash
# Utan nyckel svarar den {"error":"server_misconfigured"} (HTTP 500) — det är väntat.
# När nyckeln är satt:
B64=$(base64 -w0 test.jpg)
curl -X POST https://cntmgjiomjjivdngnqui.supabase.co/functions/v1/passfoto \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"$B64\"}" | jq '.images | length'
# Förväntat: 4 (eller färre om enskilda anrop misslyckas)
```

### Uppdatera funktionskoden senare

Redigera `supabase/functions/passfoto/index.ts` och deploya om — via
Supabase CLI (`supabase functions deploy passfoto --no-verify-jwt`) eller
be Claude deploya om via MCP.

## Säkerhet & gränser

- Nyckeln ligger enbart i `GEMINI_API_KEY`, aldrig i sidan.
- CORS är låst till `ALLOWED_ORIGIN`, inget wildcard.
- Rate limit: 10 anrop per IP och timme (in-memory, nollställs vid cold start —
  vill du ha hårdare gräns, flytta till en tabell eller Upstash).
- Bilderna loggas aldrig; endast fel loggas.
- Googles bildmodell lägger in osynlig SynthID-vattenmärkning.
- Retuscherade/AI-behandlade foton godtas inte av alla myndigheter. Svenska pass
  fotograferas hos polisen — appen passar bäst för visum, medlemskort o.d.

## Djur-läge (mässingsspaken)

Efter leverans dyker en mässingsspak upp under utlösaren. Dra ner den så skickas
samma selfie till proxyn med `mode:"animal"`: en textmodell (`gemini-flash-latest`)
slumpar en djurart — inget hårdkodat bibliotek, ett slumpfrö + hög temperatur ger
ny art varje gång — och bildmodellen gör fyra passfoton av dig som det djuret. Dra
igen för att slå om (re-roll). Misslyckas artvalet får bildmodellen välja själv.

## Att bestämma (redan valt)

- Remsan sparas **inte** mellan sessioner (försvinner vid omladdning).
- Strikt passfotoläge för den gröna knappen; djur-läget ligger på spaken.
- Nedräkningen har mekaniskt klickljud (Web Audio, ingen ljudfil).
