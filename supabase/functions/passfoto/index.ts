// Passfotoautomaten — proxy mot Google Nano Banana Pro (gemini-3-pro-image).
// Håller GEMINI_API_KEY, bygger prompten, kör fyra anrop parallellt,
// returnerar { images: [dataUrl, dataUrl, dataUrl, dataUrl] } (rätt mime per bild).
//
// Deploy: supabase functions deploy passfoto --no-verify-jwt
// Env:    supabase secrets set GEMINI_API_KEY=... ALLOWED_ORIGIN=https://lellehubo.github.io

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// Origin-allowlist. ALLOWED_ORIGIN kan vara en kommaseparerad lista.
// Localhost tas alltid med för lokal utveckling.
const ALLOWED_ORIGINS = [
  ...(Deno.env.get("ALLOWED_ORIGIN") ?? "https://lellehubo.github.io")
    .split(",").map((s) => s.trim()).filter(Boolean),
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const MODEL = "gemini-3-pro-image";
const ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_BODY_BYTES = 8 * 1024 * 1024;   // ~8 MB
const RATE_LIMIT = 10;                     // anrop per IP
const RATE_WINDOW_MS = 60 * 60 * 1000;     // per timme

// Basprompt. Sista raden varieras per bild så att remsan får mikroskillnader.
const BASE_PROMPT =
  "Retuschera detta porträtt till ett passfoto taget i studio. " +
  "Behåll personens ansikte exakt, samma drag, samma ålder, samma hudton, " +
  "samma frisyr, samma glasögon om sådana finns. Ändra ingenting i ansiktet. " +
  "Byt bakgrunden till en jämn ljusgrå yta utan struktur och utan slagskuggor. " +
  "Belys ansiktet mjukt och jämnt framifrån, inga hårda skuggor under näsa eller haka, " +
  "inga blanka reflexer. Huvudet rakt framifrån, axlarna raka, neutralt ansiktsuttryck, " +
  "båda ögonen öppna och synliga. Beskär till stående passfotoformat med huvudet centrerat " +
  "och ungefär tre fjärdedelar av bildhöjden från hakan till hjässan. " +
  "Fotografisk skärpa, ingen skönhetsretusch, ingen utslätning av hud. ";

const VARIANTS = [
  "Ljussättning: neutral, standard studioljus.",
  "Ljussättning: neutral, standard studioljus.",
  "Ljussättning: aningen varmare ljus, som en glödlampa dämpad mot dagsljus.",
  "Ljussättning: aningen varmare ljus, som en glödlampa dämpad mot dagsljus.",
];

// ── Djur-läge ────────────────────────────────────────────────
// Ingen hårdkodad djurlista: en snabb textmodell väljer arten, och ett
// slumpfrö från klienten + hög temperatur ger en ny art varje gång.
const TEXT_MODEL = "gemini-flash-latest";
const TEXT_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent`;

async function pickAnimal(seed: number): Promise<string | null> {
  try {
    const res = await fetch(TEXT_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text:
              "Välj EN slumpmässig djurart från hela djurriket — däggdjur, fågel, reptil, " +
              "groddjur, fisk, havsdjur, insekt eller spindeldjur. Undvik vanliga husdjur " +
              "(ingen katt, hund, kanin) och undvik de självklara valen räv och uggla. " +
              "Var oväntad och variera brett. Svara med ENBART artens namn på svenska, " +
              "gemener, inga andra ord. Slumpfrö: " + seed,
          }],
        }],
        generationConfig: { temperature: 1.6, maxOutputTokens: 24 },
      }),
    });
    if (!res.ok) {
      console.error("animal_pick_error", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const txt = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? "").join("").trim();
    if (!txt) return null;
    return txt.replace(/["'.\n]/g, "").slice(0, 40).toLowerCase();
  } catch (err) {
    console.error("animal_pick_exception", String(err));
    return null;
  }
}

// Bygger djur-prompten. Viktigt: be modellen SKAPA en påhittad djurkaraktär
// inspirerad av selfien — inte "förvandla personen", vilket blockeras (blockReason OTHER).
// Tom art (om valet misslyckas) → låt bildmodellen välja djur själv.
function animalPrompt(species: string): string {
  const kind = species || "ett oväntat djur (inte katt eller hund)";
  return (
    "Skapa ett humoristiskt men proffsigt passfoto taget i studio av en PÅHITTAD, fiktiv " +
    "antropomorf djurkaraktär i form av " + kind + ". Det ska INTE föreställa en verklig person — " +
    "hitta på en helt ny karaktär. Använd referensbilden enbart som stilinspiration: liknande " +
    "frisyr översatt till päls eller fjädrar, liknande hår- och ögonfärg, glasögon om sådana finns, " +
    "och samma lugna, neutrala uttryck och 'vibe'. Karaktären sitter upprätt i ett fotobås, huvudet " +
    "rakt framifrån, neutralt uttryck, axlarna raka, båda ögonen öppna och synliga. Jämn ljusgrå " +
    "studiobakgrund utan struktur och utan slagskuggor. Mjuk, jämn belysning framifrån, inga hårda " +
    "skuggor. Stående passfotoformat med huvudet centrerat och ungefär tre fjärdedelar av bildhöjden " +
    "från hakan till hjässan. Fotorealistisk päls-/fjäderdetalj, elegant men lätt absurt. "
  );
}

// Enkel in-memory rate limit. Räcker för en instans; nollställs vid cold start.
const hits = new Map<string, number[]>();

function pickOrigin(req: Request): string {
  const origin = req.headers.get("Origin") ?? "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = ALLOWED_ORIGINS[0]): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// Ett anrop till Gemini. Returnerar en komplett data-URL (rätt mime) eller null.
async function generateOne(imageB64: string, prompt: string): Promise<string | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: imageB64 } },
            { text: prompt },
          ],
        }],
        // responseModalities måste anges explicit, annars kan modellen svara
        // med text i stället för bild → generation_failed.
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "3:4" },
        },
      }),
    });

    if (!res.ok) {
      console.error("gemini_error", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      const inline = p.inline_data ?? p.inlineData;
      if (inline?.data) {
        const mime = inline.mime_type ?? inline.mimeType ?? "image/png";
        return `data:${mime};base64,${inline.data}`;
      }
    }
    console.error("gemini_no_image", JSON.stringify(data).slice(0, 300));
    return null;
  } catch (err) {
    console.error("gemini_exception", String(err));
    return null;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = pickOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
  if (!GEMINI_API_KEY) return json({ error: "server_misconfigured" }, 500, origin);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429, origin);

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413, origin);

  let image: string;
  let mode = "passport";
  let seed = 0;
  try {
    const body = await req.json();
    image = String(body.image ?? "");
    if (body.mode === "animal") mode = "animal";
    seed = Number(body.seed) || 0;
  } catch {
    return json({ error: "bad_request" }, 400, origin);
  }
  if (!image || image.length < 100) return json({ error: "no_image" }, 400, origin);
  if (image.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413, origin);

  // Passfoto = fast basprompt. Djur = slumpad art via textmodellen, samma art på alla fyra.
  const base = mode === "animal" ? animalPrompt(await pickAnimal(seed) ?? "") : BASE_PROMPT;

  // Fyra parallella anrop — ett misslyckat får inte fälla hela remsan.
  const results = await Promise.all(VARIANTS.map((v) => generateOne(image, base + v)));
  const images = results.filter((b): b is string => b !== null);

  if (images.length === 0) return json({ error: "generation_failed" }, 502, origin);
  return json({ images }, 200, origin);
});
