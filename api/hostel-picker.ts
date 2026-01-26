export const runtime = "edge";

// --- 🔒 SECURITY CONFIGURATIE (VIP LIJST) ---
const ALLOWED_ORIGINS = [
    "https://hostel-picker.vercel.app", // Jouw productie URL
    "http://localhost:3000",            // Lokaal testen
];

function getCorsHeaders(request: Request) {
    const origin = request.headers.get("origin") || "";
    
    // CHECK 1: Staat hij hard op de lijst? (Productie & Localhost)
    const isWhitelisted = ALLOWED_ORIGINS.includes(origin);

    // CHECK 2: Is het een Vercel Preview URL? (Eindigt op .vercel.app)
    // Dit zorgt dat al je test-omgevingen ook werken.
    const isVercelPreview = origin.endsWith(".vercel.app");

    if (isWhitelisted || isVercelPreview) {
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        };
    }

    // Geen toegang? Dan sturen we headers zonder Allow-Origin
    return {
        "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    };
}

// --- CONFIGURATIE: LANDEN EN HUN SPREADSHEETS ---
const COUNTRY_MAP: Record<string, string | undefined> = {
    "Guatemala": process.env.SHEET_CSV_GUATEMALA,
    "Belize": process.env.SHEET_CSV_BELIZE
};

// --- STAP 1: DEFINITIES VOOR NORMALISATIE (MAPPINGS) ---

// MAPPING 1: FACILITIES (Vertaling van Frontend Intent naar Backend Keywords)
const FEATURE_MAPPING: Record<string, string[]> = {
    // Werk & Nomad
    "work": ["coworking", "desk", "wifi", "monitor", "digital nomad"],
    "digital nomad": ["coworking", "fast wifi", "desk", "workspace"],
    // Sociaal & Party
    "party": ["bar", "nightclub", "events", "beer pong", "happy hour", "pub crawl"],
    "social": ["common room", "bar", "terrace", "games", "family dinner", "activities"],
    // Gemak & Eten
    "kitchen": ["kitchen", "cooking", "stove", "microwave", "oven"],
    "food": ["restaurant", "cafe", "meals", "breakfast"],
    "pool": ["pool", "swimming", "jacuzzi"],
    "gym": ["gym", "fitness", "workout", "yoga"],
    // Kamer & Privacy
    "privacy": ["curtain", "pod", "private"],
    "ac": ["air conditioning", "a/c", "fan", "climate control"]
};

// MAPPING 2: VIBE (Sfeer labels matching) - AANGEPAST NAAR NIEUWE PROMPT
const VIBE_MAPPING: Record<string, string[]> = {
    "wild party": ["party-animal"],
    "super social": ["social-connector"],
    "small & cozy": ["homely-cozy"],
    "fancy & modern": ["boutique-luxury"],
    "quiet & relaxed": ["chill-zen"],
    "work-ready": ["digital-nomad"],
    "budget & basic": ["budget-nofrills"]
};

/** ---- Simple in-memory cache (Edge warm instance) ---- */
let cachedCsvRaw: string | null = null;
let cachedHostelData: any[] | null = null;
let cacheUpdatedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- AANGEPASTE OPTIONS HANDLER ---
export async function OPTIONS(request: Request) {
    return new Response(null, { 
        status: 204, 
        headers: getCorsHeaders(request) 
    });
}

function parseCSV(csvText: string) {
    if (!csvText || csvText.length < 10) return [];
    
    const cleanText = csvText.trim().replace(/^\uFEFF/, "");
    
    const rows: string[][] = [];
    let currCell = ""; let currRow: string[] = []; let inQuotes = false;
    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i]; const nextChar = cleanText[i + 1];
        if (char === '"' && inQuotes && nextChar === '"') { currCell += '"'; i++; }
        else if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { currRow.push(currCell.trim()); currCell = ""; }
        else if (char === '\n' && !inQuotes) { currRow.push(currCell.trim()); rows.push(currRow); currRow = []; currCell = ""; }
        else { currCell += char; }
    }
    if (currRow.length > 0 || currCell) { currRow.push(currCell.trim()); rows.push(currRow); }

    const headers = rows[0].map(h => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, ""));
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            if (val.includes('{') && val.includes('}')) {
                try { const sanitized = val.replace(/""/g, '"'); obj[header] = JSON.parse(sanitized); }
                catch (e) { obj[header] = val; }
            } else { obj[header] = val; }
        });
        return obj;
    }).filter(h => h.hostel_name && h.hostel_name.length > 1);
}

/** * NIEUW: Pre-calculation logic (Hybrid 3.0 - Full Normalization)
 * Voert harde berekeningen én mappings uit in TypeScript.
 */
function enrichHostelData(hostel: any, userContext: any) {
    // 1. Digital Nomad Score (Harde data uit JSON: Rank * 10)
    let nomadScore = 50; 
    try {
        if (hostel.digital_nomad_score) {
            const val = hostel.digital_nomad_score;
            const json = typeof val === 'string' ? JSON.parse(val) : val;
            nomadScore = (json.rank || 5) * 10;
        }
    } catch (e) { nomadScore = 50; }

    // 2. Solo Traveler Score
    let soloScore = 50;
    try {
        if (hostel.solo_verdict) {
            const val = hostel.solo_verdict;
            const json = typeof val === 'string' ? JSON.parse(val) : val;
            soloScore = (json.rank || 5) * 10;
        }
    } catch (e) { soloScore = 50; }

    // 3. Price Score (Bell-Curve)
    let priceScore = 0;
    const price = parseFloat(hostel.pricing);
    const target = parseFloat(userContext?.maxPrice) || 30;
    if (!isNaN(price)) {
        const diff = Math.abs(price - target);
        priceScore = Math.max(0, 100 - (diff * 2.5)); 
    } else {
        priceScore = 50; 
    }

    // 4. Noise Score (Genormaliseerd: Match tussen Backend Score en User Voorkeur)
    // Stap A: Backend vertalen naar 0-100 schaal
    let noiseLevelBackend = 50; // default medium
    // FIX: String() toegevoegd om crashes te voorkomen als data een getal is
    const noiseTxt = String(hostel.noise_level || "").toLowerCase();
    
    if (noiseTxt.includes("loud") || noiseTxt.includes("party") || noiseTxt.includes("music")) noiseLevelBackend = 90;
    else if (noiseTxt.includes("medium") || noiseTxt.includes("social")) noiseLevelBackend = 50;
    else if (noiseTxt.includes("quiet") || noiseTxt.includes("peace") || noiseTxt.includes("nature")) noiseLevelBackend = 15;

    // Stap B: Matchen met User Input (slider 0-100)
    // Als userContext.noiseLevel ontbreekt, aanname 50.
    const userNoisePref = userContext?.noiseLevel !== undefined ? parseInt(userContext.noiseLevel) : 50;
    // Score is nabijheid (100 - verschil)
    const noiseMatchScore = Math.max(0, 100 - Math.abs(userNoisePref - noiseLevelBackend));

    // 5. VIBE MATCH (Normalisatie via VIBE_MAPPING)
    let vibeMatch = 50;
    // FIX: String() toegevoegd
    const userVibeInput = String(userContext?.vibe || "").toLowerCase();
    const hostelVibeDna = String(hostel.vibe_dna || "").toLowerCase();
    
    let vibeHits = 0;
    let vibeChecks = 0;

    Object.keys(VIBE_MAPPING).forEach(vibeKey => {
        if (userVibeInput.includes(vibeKey)) {
            vibeChecks++;
            const keywords = VIBE_MAPPING[vibeKey];
            if (keywords.some(k => hostelVibeDna.includes(k))) {
                vibeHits++;
            }
        }
    });
    
    if (vibeChecks > 0) {
        vibeMatch = Math.round((vibeHits / vibeChecks) * 100);
        // Bonus: Directe woordmatch
        if (hostelVibeDna.includes(userVibeInput)) vibeMatch = 100;
    }

    // 6. FACILITIES MATCH (Normalisatie via FEATURE_MAPPING)
    let facilitiesMatch = 50;
    let featuresFound = 0;
    let featuresLookedFor = 0;

    // Scan context (vibe + requirements) op keywords
    const combinedReqs = ((userContext?.vibe || "") + " " + (userContext?.requirements || "")).toLowerCase();
    // FIX: String() toegevoegd
    const hostelFacilities = String(hostel.facilities || "").toLowerCase();

    Object.keys(FEATURE_MAPPING).forEach(userKey => {
        if (combinedReqs.includes(userKey)) {
            featuresLookedFor++;
            const backendKeywords = FEATURE_MAPPING[userKey];
            if (backendKeywords.some(keyword => hostelFacilities.includes(keyword))) {
                featuresFound++;
            }
        }
    });

    if (featuresLookedFor > 0) {
        facilitiesMatch = Math.round((featuresFound / featuresLookedFor) * 100);
    }

    // --- NIEUW: 7. AGE MATCH ---
    let ageMatch = 50;
    const userAge = parseInt(userContext?.age) || 25;
    const hostelAvgAge = parseInt(hostel.overal_age) || 25; // Pakt '25' uit de CSV kolom
    const ageDiff = Math.abs(userAge - hostelAvgAge);
    // Score: 100 min 5 punten per jaar verschil. (Vb: User 25, Hostel 30 = 5 jaar diff = score 75)
    ageMatch = Math.max(0, 100 - (ageDiff * 5));

    // --- NIEUW: 8. SIZE MATCH ---
    let sizeMatch = 50;
    const userSize = String(userContext?.size || "").toLowerCase(); // "small", "medium", "large"
    
    // FIX: String() toegevoegd om crashes te voorkomen
    const hostelSizeInfo = String(hostel.rooms_info || "").toLowerCase();
    
    // Simpele woordmatch op de CSV tekst (bijv. "Medium, total capacity 30")
    if (hostelSizeInfo.includes(userSize)) {
        sizeMatch = 100;
    } else if (
        (userSize === "small" && hostelSizeInfo.includes("medium")) ||
        (userSize === "large" && hostelSizeInfo.includes("medium"))
    ) {
        sizeMatch = 70; // Close enough
    } else {
        sizeMatch = 30; // Mismatch (bv Small vs Large)
    }

    // --- NIEUW: 9. NATIONALITY MATCH ---
    let nationalityMatch = 0; // Default 0 (niet relevant als user niks invult)
    const userNat = String(userContext?.nationalityPref || "").trim();
    
    if (userNat.length > 0) {
        try {
            // CSV voorbeeld: {"USA":18,"Germany":8,"England":18}
            // Backend moet dit parsen als het een string is, of direct gebruiken
            let countryData = hostel.country_info;
            if (typeof countryData === 'string') {
                // Soms is JSON "dirty", probeer te fixen of parse direct
                try { countryData = JSON.parse(countryData); } catch(e) {}
            }
            
            // Zoek user input (bv "Dutch" of "Germany") in de keys
            const matchKey = Object.keys(countryData || {}).find(k => 
                k.toLowerCase().includes(userNat.toLowerCase()) || 
                userNat.toLowerCase().includes(k.toLowerCase())
            );

            if (matchKey) {
                // Als nationaliteit gevonden is, score = 100
                nationalityMatch = 100;
            } else {
                nationalityMatch = 20; // Niet gevonden
            }
        } catch (e) {
            nationalityMatch = 50; // Fout in data, geef neutraal
        }
    } else {
        nationalityMatch = 100; // Geen voorkeur? Dan is alles goed.
    }

    // Voeg berekende scores toe aan het object (Original data stays available!)
    return {
        ...hostel,
        _computed_scores: {
            nomad: nomadScore,
            solo: soloScore,
            noise_match: noiseMatchScore, // Veranderd naar 'match' score
            price_match: Math.round(priceScore),
            vibe_match: vibeMatch,
            facilities_match: facilitiesMatch,
            // Nieuwe scores toevoegen:
            age_match: ageMatch,
            size_match: sizeMatch,
            nationality_match: nationalityMatch
        }
    };
}

// --- AANGEPASTE EMAIL FUNCTIE (ENGELS + PARTNERS + TOP 4) ---
async function sendTop3Email(email: string, recommendations: any[], context: any) {
    const resendApiKey = process.env.RESEND_API_KEY;

    if (!resendApiKey) {
        console.error("Geen RESEND_API_KEY gevonden.");
        return;
    }

    // 1. Bouw de Hostel Kaarten (Top 4)
    const listHtml = recommendations.map((rec, i) => `
        <div style="background-color: #ffffff; border: 1px solid #e5e7eb; padding: 20px; margin-bottom: 24px; border-radius: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <h3 style="color: #111; margin: 0; font-size: 18px; font-weight: 700;">#${i + 1}. ${rec.name}</h3>
                <span style="background: ${rec.matchPercentage > 85 ? '#dcfce7' : '#fef9c3'}; color: ${rec.matchPercentage > 85 ? '#166534' : '#854d0e'}; padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: bold; white-space: nowrap;">
                    ${rec.matchPercentage}% Match
                </span>
            </div>

            <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; font-size: 12px; color: #4b5563;">
                <div style="background: #f3f4f6; padding: 4px 8px; border-radius: 6px;">
                    ⭐ ${rec.sentiment_short || 'Great Vibe'}
                </div>
                <div style="background: #f3f4f6; padding: 4px 8px; border-radius: 6px;">
                    👤 ${rec.solo_info || 'Good for solo'}
                </div>
                <div style="background: #f3f4f6; padding: 4px 8px; border-radius: 6px;">
                    💻 ${rec.nomad_info || 'Wifi zone'}
                </div>
            </div>

            <p style="color: #374151; font-size: 14px; line-height: 1.6; margin-top: 0; margin-bottom: 16px;">
                ${rec.reason}
            </p>

            <div style="border-top: 1px dashed #e5e7eb; padding-top: 12px; display: flex; justify-content: space-between; align-items: center;">
                <div style="font-size: 13px; color: #6b7280;">
                    <span style="margin-right: 10px;">💰 ${rec.price}</span>
                    <span>📍 ${rec.location}</span>
                </div>
                <div>
                      <a href="${rec.hostel_img}" style="background: #6366f1; color: #fff; padding: 8px 16px; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: bold; display:inline-block;">View Hostel &rarr;</a>
                </div>
            </div>
        </div>
    `).join("");

    // 2. Het Partner Blok (Vast blokje)
    const partnerBlockHtml = `
        <div style="margin-top: 40px; background-color: #111827; color: #fff; padding: 24px; border-radius: 12px; text-align: center;">
            <h3 style="margin: 0 0 16px 0; font-size: 16px; text-transform: uppercase; letter-spacing: 1px; color: #fbbf24;">✨ Travel Essentials</h3>
            <p style="font-size: 13px; color: #9ca3af; margin-bottom: 20px;">Don't forget these before you fly.</p>
            
            <table width="100%" cellpadding="0" cellspacing="0" style="width: 100%;">
                <tr>
                    <td align="center" style="padding: 5px;">
                        <a href="https://www.airalo.com" target="_blank" style="display: block; background: #262626; padding: 12px; border-radius: 8px; text-decoration: none; color: #fff; border: 1px solid #374151;">
                            <div style="font-weight: bold; font-size: 14px;">📶 Airalo</div>
                            <div style="font-size: 11px; color: #9ca3af;">eSIM Data</div>
                        </a>
                    </td>
                    <td align="center" style="padding: 5px;">
                        <a href="https://www.revolut.com" target="_blank" style="display: block; background: #262626; padding: 12px; border-radius: 8px; text-decoration: none; color: #fff; border: 1px solid #374151;">
                            <div style="font-weight: bold; font-size: 14px;">💳 Revolut</div>
                            <div style="font-size: 11px; color: #9ca3af;">No Fees</div>
                        </a>
                    </td>
                    <td align="center" style="padding: 5px;">
                        <a href="https://www.skyscanner.net" target="_blank" style="display: block; background: #262626; padding: 12px; border-radius: 8px; text-decoration: none; color: #fff; border: 1px solid #374151;">
                            <div style="font-weight: bold; font-size: 14px;">✈️ Skyscanner</div>
                            <div style="font-size: 11px; color: #9ca3af;">Cheap Flights</div>
                        </a>
                    </td>
                </tr>
            </table>
        </div>
    `;

    // 3. Verstuur de email (Layout Container)
    await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: "HostelMatchmaker <hello@trekvice.com>",
            to: [email],
            subject: `🏝️ Your Top 4 Hostels in ${context.destination}`,
            html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; color: #333;">
                    
                    <div style="padding: 24px;">
                        <h1 style="color: #111; font-size: 22px; margin-top: 0;">Hostel Report: ${context.destination}</h1>
                        <p style="font-size: 15px; line-height: 1.6; color: #4b5563;">
                            Hi there! Based on your search (<strong>${context.vibe}</strong>, budget <strong>€${context.maxPrice}</strong>, age <strong>${context.age}</strong>), 
                            we found the following matches for you:
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
                        
                        ${listHtml}
                        
                        ${partnerBlockHtml}
                        
                        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
                        
                        <p style="font-size: 11px; color: #9ca3af; text-align: center;">
                            Generated by HostelMatchmaker AI v4.5
                        </p>
                    </div>
                </div>
            `
        })
    });
}

// --- AANGEPASTE POST HANDLER MET SECURITY CHECK ---
export async function POST(req: Request) {
    const t0 = Date.now();
    
    // 1. HAAL DE VEILIGE HEADERS OP
    const safeHeaders = getCorsHeaders(req);

    let tSheetStart = 0, tSheetEnd = 0;
    let tParseStart = 0, tParseEnd = 0;
    let tReqJsonStart = 0, tReqJsonEnd = 0;
    let tFilterStart = 0, tFilterEnd = 0;
    let tOpenAIStart = 0, tOpenAIEnd = 0;

    try {
        const apiKey = process.env.OPENAI_API_KEY;

        // 1. EERST JSON LEZEN (We hebben de 'context' nodig voor de landkeuze)
        // Dit moet EERST gebeuren, anders weten we niet welk land we moeten laden.
        tReqJsonStart = Date.now();
        const body = await req.json();
        tReqJsonEnd = Date.now();
        const { messages, context, email, recommendations } = body; // <--- LEES HIER OOK 'recommendations' UIT

        // --- NIEUW: DIRECTE EMAIL SHORT-CIRCUIT (VERBETERD) ---
        // Als we een email én kant-en-klare recommendations hebben:
        if (email && email.includes("@") && recommendations && Array.isArray(recommendations) && recommendations.length > 0) {
            
            console.log("🚀 Short-circuit: Processing existing results for email.");

            // STAP A: Filter op de juiste stad (voorkomt die 4e in de verkeerde stad)
            // We kijken of de naam van de stad (context.destination) voorkomt in de locatie van het hostel.
            const targetCity = (context?.destination || "").toLowerCase().trim();
            
            let curatedList = recommendations.filter(rec => 
                rec.location && rec.location.toLowerCase().includes(targetCity)
            );

            // Fallback: Als de filter per ongeluk alles weggooit (bv door een typfout),
            // gebruik dan toch de originele lijst om een lege mail te voorkomen.
            if (curatedList.length === 0) {
                curatedList = recommendations;
            }

            // STAP B: Maximaal 3 limiet (werkt ook als er maar 1 of 2 zijn)
            // .slice(0, 3) pakt index 0, 1 en 2. Als de lijst korter is, pakt hij alles wat er is.
            const finalTop3 = curatedList.slice(0, 3);
            
            await sendTop3Email(email, finalTop3, context);

            return new Response(JSON.stringify({ 
                message: `Email sent successfully. Sent ${finalTop3.length} hostels.`,
                status: "sent"
            }), { 
                status: 200, 
                headers: safeHeaders 
            });
        }
        // -------------------------------------------------------------

        // --- CHECK MODE: EMAIL OF PREVIEW ---
        const isEmailMode = !!(email && email.includes("@"));
        const limit = 4; // <--- AANGEPAST: ALTIJD 4 GENEREREN, OOK ZONDER EMAIL! 

        // 2. BEPAAL WELK LAND HET IS & KIES DE JUISTE URL
        const selectedCountry = context?.country || "Guatemala";
        const csvUrl = COUNTRY_MAP[selectedCountry];

        if (!csvUrl) {
            // Geen URL gevonden? Stop direct.
            return new Response(JSON.stringify({ 
                message: `Configuratie fout: Land '${selectedCountry}' is niet gekoppeld in de backend.`, 
                recommendations: [] 
            }), { status: 400, headers: safeHeaders });
        }

        // 3. NU PAS DE DATA OPHALEN (Met de juiste csvUrl)
        tSheetStart = Date.now();
        const now = Date.now();
        const cacheFresh = cachedHostelData && (now - cacheUpdatedAt) < CACHE_TTL_MS;

        let hostelData: any[] = [];

        // Cache logica: we checken of de cache 'fresh' is. 
        // Bij een landwissel is de cache niet relevant, dus we laden vers of voegen complexere logica toe.
        // Voor nu: als we wisselen, fetchen we vers.
        if (cacheFresh && cachedCsvRaw) {
             // In een productie-omgeving zou je hier checken of de cache matcht met het land.
             // Omdat we nu testen met verschillende landen, doen we de fetch om zeker te zijn.
             // Wil je snelheid? Zet dit blok weer aan en zorg dat de cache per land wordt opgeslagen.
        }
        
        // --- FETCH DE DATA ---
        const sheetRes = await fetch(csvUrl, {
            cache: "no-store", // Zet dit later op 'force-cache' voor snelheid
            headers: { "Cache-Control": "no-cache" }
        });
        
        const csvRaw = await sheetRes.text();
        tSheetEnd = Date.now();

        tParseStart = Date.now();
        hostelData = parseCSV(csvRaw);
        tParseEnd = Date.now();

        // Update de cache voor de volgende keer
        cachedCsvRaw = csvRaw;
        cachedHostelData = hostelData;
        cacheUpdatedAt = now;

        // --- BEVEILIGING TEGEN MISBRUIK ---
        // Check of de laatste input niet belachelijk lang is (max 600 tekens).
        const lastMsg = messages?.[messages.length - 1];
        if (lastMsg && lastMsg.content && lastMsg.content.length > 600) {
            // GEBRUIK safeHeaders IN ERROR RESPONSE
            return new Response(JSON.stringify({ 
                message: "Bericht te lang. Houd het kort a.u.b. (max 600 tekens).", 
                recommendations: [] 
            }), { status: 400, headers: safeHeaders });
        }
        // ----------------------------------

        tFilterStart = Date.now();
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        let pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);
        
        // NIEUW: Verrijk de pool met harde berekeningen & Normalisaties
        pool = pool.map(h => enrichHostelData(h, context));
        
        tFilterEnd = Date.now();

        // ------------------------------------------------------------------
        // DYNAMIC WEIGHTING LOGIC (NOMAD & SOLO)
        // ------------------------------------------------------------------
        const nomadWeight = context?.nomadMode ? "1.5" : "0.5";
        const soloWeight = context?.soloMode ? "1.5" : "0.5";

        const poolJsonChars = JSON.stringify(pool).length;

        tOpenAIStart = Date.now();
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker.

// ==============================
// NEW STRICT QUESTION OVERRIDES
// (ADD-ONLY: do not remove any existing prompt text below)
// ==============================

STRICT INTEL GATHERING (MANDATORY OVERRIDE):
- You MUST ask at least 1 and at most 2 clarifying questions before giving any hostel recommendations.
- Questions must ALWAYS be DEEPENING (verdiepend), never BROADENING (verbredend).
  - Deepening = request precision on signals already present in USER CONTEXT and/or chat history.
  - Not allowed = introducing new preference categories the user did not hint at.
- Every question MUST be grounded in:
  1) USER CONTEXT (fixed fields like vibe, noiseLevel, maxPrice, size, age, nomadMode, soloMode, nationalityPref, destination)
  2) chat history (messages)
- If you ask a question, you MUST return:
  - "recommendations": []
  - 2–4 "suggestions" that are mobile-friendly, tap-ready answers to THAT question.
    - Suggestions must be short, mutually exclusive, and cover clear extremes when relevant.
    - Use emoji and compact labels (examples: "Quiet 💤", "Balanced 🙂", "Loud/Party 🔊" or "Coworking 🧑‍💻", "Room Wi-Fi 🛏️", "Both ✅").
- You may ONLY switch to recommendations mode AFTER at least 1 deepening question has been asked and answered in the conversation.
- You must NEVER ask more than 2 questions total across the whole conversation. If you have already asked 2, you MUST produce recommendations next.

// OPTIONAL SELF-CHECK (internal):
Before output, verify: (question_count_so_far <= 2). If question_count_so_far == 0 => ask a deepening question now.
// ==============================

SCORING ALGORITHM (Weighted):
ALL key metrics (Price, Facilities, Vibe, Noise, Nomad, Solo, Age, Size, Nationality) have been PRE-CALCULATED in '_computed_scores'.
Your job is to apply the weights and synthesize the final verdict based on these numbers.

1. FACILITIES MATCH (Weight 0.8):
   - Use '_computed_scores.facilities_match' (0-100).
   - This score represents strict matching of user requirements (e.g. "Work", "Kitchen", "Party") against available facilities.

2. PRICE MATCH (Weight 1.0):
   - Use '_computed_scores.price_match' (0-100).

3. VIBE MATCH (Weight 1.0):
   - Use '_computed_scores.vibe_match' (0-100).
   - Based on semantic keyword mapping.

4. NOISE MATCH (Weight 0.5):
   - Use '_computed_scores.noise_match'.
   - This score already accounts for user preference (Score 100 = Perfect match for user's desired noise level).

5. SENTIMENT (Weight 0.7):
   - EXTRACT 'score' from 'csv.overal_sentiment' JSON.

6. DIGITAL NOMAD SCORE (Weight ${nomadWeight}):
   - Use '_computed_scores.nomad'.
   - *Logic:* If user is Nomad, this is critical. If not, ignore unless exceptional.

7. SOLO TRAVELER SCORE (Weight ${soloWeight}):
   - Use '_computed_scores.solo'.
   - *Logic:* If user is Solo, this is very important.

8. AGE MATCH (Weight 0.5):
   - Use '_computed_scores.age_match'. 

9. SIZE PREFERENCE (Weight 0.5):
   - Use '_computed_scores.size_match'.

10. NATIONALITY CONNECTION (Weight 0.1):
   - Use '_computed_scores.nationality_match'.

4. Vibe DNA Hierarchy & Ranking (STRICT ORDER):
   Select EXACTLY 3 tags from: [Party-Animal, Social-Connector, Homely-Cozy, Boutique-Luxury, Chill-Zen, Digital-Nomad, Budget-NoFrills].
   
   IMPORTANT: The order in the JSON array must reflect relevance (Rank 1 = Most Dominant).

   - Rank 1: The Core Identity (The "Soul").
     Choose the tag that represents the primary reason people stay here. If reviews mention the party atmosphere more than anything else, "Party-Animal" must be first. If it's famous for being quiet, "Chill-Zen" goes first.

   - Rank 2: The Social/Facility Standard.
     Choose the tag that describes the physical or social setup. (e.g., if it's a social place with pod-beds, use "Social-Connector" or "Boutique-Luxury").

   - Rank 3: The Atmosphere Add-on.
     Choose the supporting vibe. (e.g., if it’s a party place but also has great WiFi, use "Digital-Nomad").

   Selection Logic:
   * "Party-Animal": High-energy, loud, bar crawls, late nights.
   * "Social-Connector": Organized events, family dinners, easy to meet people.
   * "Homely-Cozy": Small, intimate, owner-run, "feels like home".
   * "Boutique-Luxury": Modern design, privacy curtains, high-end bathrooms.
   * "Chill-Zen": Quiet, relaxing, yoga, hammocks, good sleep.
   * "Digital-Nomad": Workspace-focused, fast WiFi, laptop-friendly.
   * "Budget-NoFrills": Basic, cheap, functional, no luxuries.

   - Constraint: NEVER put "Party-Animal" and "Chill-Zen" in the same list. Order them by frequency of mention in the Review Bundle.

TONE OF VOICE:
You are the 'Straight-Talking Traveler'. Helpful, direct, non-corporate.

AUDIT REQUIREMENTS:
In 'audit_log', SHOW THE MATH using the pre-computed values.
Example: "Facilities: (Pre-calc 100% * 1.5) + Vibe: (Pre-calc 80% * 1.2) ... = Total%"

DATABASE: ${JSON.stringify(pool)}
USER CONTEXT: ${JSON.stringify(context)}

OUTPUT CONFIGURATION:
- Return EXACTLY ${limit} recommendation(s). (If fewer than ${limit} fit perfectly, return as many as possible).
- LANGUAGE: ALL TEXT MUST BE IN ENGLISH.

OUTPUT JSON STRUCTURE:
{
  "recommendations": [
    {
      "name": "hostel_name",
      "location": "city",
      "matchPercentage": 0-100,
      "price": "pricing",
      "vibe": "vibe_dna",
      "hostel_img": "EXACT URL FROM csv.hostel_img",
      "alert": "red_flags or 'None'",
      "reason": "MANDATORY: Act as a travel consultant. Don't just list matches; INTERPRET them. If ages match closely, say they'll fit in perfectly. If the price is lower than budget, call it a 'steal'. If they are solo, explain EXACTLY which feature (e.g., family dinners) solves their fear of being alone.",
      "sentiment_short": "e.g. 'Superb 9.2' or 'Very Popular'",
      "solo_info": "e.g. 'Daily events' or 'Social atmosphere'",
      "nomad_info": "e.g. 'Coworking space' or 'Fast WiFi'",
      "audit_log": {
        "score_breakdown": "MUST show the calculation using labels.",
        "facilities_logic": "Explain specific facilities found/missing based on facilities_match.",
        "vibe_logic": "Explain vibe match based on pre-calc score.",
        "sentiment_logic": "Analysis of csv.overal_sentiment.",
        "pulse_summary_proof": "EXTRACT THE EXACT TEXT VALUE from the 'pulse_summary' field in the database. Do NOT write 'RAW DATA'.", 
        "sentiment_proof": "EXTRACT THE EXACT TEXT VALUE from the 'overal_sentiment' field in the database. Do NOT write 'RAW DATA'.", 
        "nomad_proof": "EXTRACT THE EXACT TEXT VALUE from the 'digital_nomad_score' field in the database.", 
        "solo_proof": "EXTRACT THE EXACT TEXT VALUE from the 'solo_verdict' field in the database." 
      }
    }
  ],
  "message": "Strategic advice or clarifying questions.",
  "suggestions": ["Option 1", "Option 2", "Option 3"]
}`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });
        tOpenAIEnd = Date.now();

        const aiData = await response.json();
        const content = aiData.choices[0].message.content;

        // --- EMAIL VERZENDING LOGICA ---
        if (isEmailMode) {
            try {
                const parsed = JSON.parse(content);
                if (parsed.recommendations && parsed.recommendations.length > 0) {
                    await sendTop3Email(email, parsed.recommendations, context);
                }
            } catch (e) {
                console.error("Fout bij verwerken email:", e);
            }
        }

        console.log(JSON.stringify({
            ms_total: Date.now() - t0,
            ms_sheet_fetch_and_text: tSheetEnd - tSheetStart,
            ms_csv_parse: tParseEnd - tParseStart,
            ms_req_json: tReqJsonEnd - tReqJsonStart,
            ms_filter_and_pool: tFilterEnd - tFilterStart,
            ms_openai_fetch_and_json: tOpenAIEnd - tOpenAIStart,
            pool_count: pool.length,
            pool_json_chars: poolJsonChars
        }));
        
        // GEBRUIK safeHeaders IN SUCCESS RESPONSE
        return new Response(content, { 
            status: 200, headers: safeHeaders 
        });

    } catch (error: any) {
        console.log(JSON.stringify({
            ms_total: Date.now() - t0,
            ms_sheet_fetch_and_text: tSheetEnd && tSheetStart ? (tSheetEnd - tSheetStart) : null,
            ms_csv_parse: tParseEnd && tParseStart ? (tParseEnd - tParseStart) : null,
            ms_req_json: tReqJsonEnd && tReqJsonStart ? (tReqJsonEnd - tReqJsonStart) : null,
            ms_filter_and_pool: tFilterEnd && tFilterStart ? (tFilterEnd - tFilterStart) : null,
            ms_openai_fetch_and_json: tOpenAIEnd && tOpenAIStart ? (tOpenAIEnd - tOpenAIStart) : null
        }));
        // GEBRUIK safeHeaders IN ERROR RESPONSE
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: safeHeaders });
    }
}
