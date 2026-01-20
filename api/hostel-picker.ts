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

// MAPPING 2: VIBE (Sfeer labels matching)
const VIBE_MAPPING: Record<string, string[]> = {
    "party": ["party", "nightlife", "loud", "active", "social"],
    "chill": ["chill", "quiet", "relax", "nature", "hammock", "peaceful"],
    "social": ["social", "community", "gathering", "family"],
    "work": ["digital nomad", "focused", "quiet", "hub", "coworking"],
    "nature": ["nature", "garden", "view", "eco", "jungle"]
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

// --- EMAIL HELPERS & CONFIGURATION ---

const TRAVEL_TOOLS = [
    {
        name: "Airalo E-Sim",
        desc: "Instant internet, no crazy roaming fees.",
        link: "https://www.airalo.com/", // Insert your affiliate link
        icon: "📱"
    },
    {
        name: "Revolut",
        desc: "Best card for travel. Zero exchange fees.",
        link: "https://www.revolut.com/", // Insert your affiliate link
        icon: "💳"
    },
    {
        name: "Busbud",
        desc: "Book local buses safely online.",
        link: "https://www.busbud.com/", // Insert your affiliate link
        icon: "🚌"
    }
];

const PERSONAL_FOOTER = {
    name: "Trekvice Team", // Change to your name
    role: "Hostel Explorer",
    // Replace with a real URL to your photo
    photoUrl: "https://ui-avatars.com/api/?name=Trek+Vice&background=6366f1&color=fff&size=128", 
    bio: "I built this tool because I was tired of opening 50 tabs on Hostelworld. Hope this list helps you find your people!",
    instagram: "https://instagram.com/trekvice"
};

function generateHostelHtml(rec: any, index: number) {
    // Fallbacks if AI didn't strictly follow JSON output, though prompt asks for it
    const nomadScore = rec.nomad_score || "N/A";
    const soloScore = rec.solo_score || "N/A";
    const sentiment = rec.sentiment_label || "Great Vibe";

    return `
    <div style="border: 1px solid #e5e7eb; padding: 20px; margin-bottom: 24px; border-radius: 12px; font-family: sans-serif; background-color: #ffffff;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
            <div>
                <h3 style="color: #111; margin: 0; font-size: 18px; font-weight: 700;">#${index + 1}. ${rec.name}</h3>
                <div style="margin-top: 4px; font-size: 13px; color: #6b7280;">
                    📍 ${rec.location} &nbsp;|&nbsp; 💰 ${rec.price}
                </div>
            </div>
            <div style="background: ${rec.matchPercentage > 85 ? '#dcfce7' : '#fef9c3'}; color: ${rec.matchPercentage > 85 ? '#166534' : '#854d0e'}; padding: 6px 12px; border-radius: 99px; font-size: 13px; font-weight: bold; white-space: nowrap;">
                ${rec.matchPercentage}% Match
            </div>
        </div>
        
        <div style="background-color: #f3f4f6; padding: 10px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; color: #374151; display: flex; flex-wrap: wrap; gap: 12px;">
            <span>💻 Nomad: <strong>${nomadScore}/10</strong></span>
            <span>🎒 Solo: <strong>${soloScore}/10</strong></span>
            <span>❤️ Vibe: <strong>${sentiment}</strong></span>
        </div>

        <p style="color: #374151; font-size: 14px; line-height: 1.6; margin-top: 0; margin-bottom: 16px;">
            ${rec.reason}
        </p>
        
        <div>
             <a href="${rec.hostel_img}" style="background: #4f46e5; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: bold; display:inline-block; text-align: center;">View Hostel &rarr;</a>
        </div>
    </div>
    `;
}

function generateToolsHtml() {
    const tools = TRAVEL_TOOLS.map(tool => `
        <div style="flex: 1; min-width: 140px; background: #fafafa; padding: 15px; border-radius: 8px; text-align: center; margin: 5px;">
            <div style="font-size: 24px; margin-bottom: 8px;">${tool.icon}</div>
            <div style="font-weight: bold; font-size: 14px; color: #111; margin-bottom: 4px;">${tool.name}</div>
            <div style="font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.4;">${tool.desc}</div>
            <a href="${tool.link}" style="color: #4f46e5; font-size: 12px; font-weight: bold; text-decoration: none;">Check it out &rarr;</a>
        </div>
    `).join("");

    return `
        <div style="margin-top: 40px; margin-bottom: 40px;">
            <h3 style="text-align: center; font-size: 16px; margin-bottom: 20px; color: #111;">🧳 Smart Travel Tools</h3>
            <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                ${tools}
            </div>
        </div>
    `;
}

function generateFooterHtml() {
    return `
        <div style="background-color: #f9fafb; padding: 25px; border-radius: 12px; margin-top: 30px; display: flex; align-items: center; gap: 20px;">
            <img src="${PERSONAL_FOOTER.photoUrl}" alt="${PERSONAL_FOOTER.name}" style="width: 60px; height: 60px; border-radius: 50%; object-fit: cover; border: 2px solid #e5e7eb;">
            <div>
                <p style="margin: 0; font-weight: bold; color: #111; font-size: 14px;">${PERSONAL_FOOTER.name}</p>
                <p style="margin: 4px 0 0 0; font-size: 13px; color: #4b5563; line-height: 1.5;">${PERSONAL_FOOTER.bio}</p>
            </div>
        </div>
        <div style="text-align: center; margin-top: 20px; font-size: 11px; color: #9ca3af;">
            <p>Some links in this email may be affiliates. It costs you nothing extra but helps keep the server running!</p>
            <p>&copy; ${new Date().getFullYear()} HostelMatchmaker AI</p>
        </div>
    `;
}

// --- EMAIL FUNCTIE (RESEND) ---
async function sendTop3Email(email: string, recommendations: any[], context: any) {
    const resendApiKey = process.env.RESEND_API_KEY; 
    
    if (!resendApiKey) {
        console.error("Geen RESEND_API_KEY gevonden.");
        return;
    }

    // 1. Generate Recommendations List
    const hostelsHtml = recommendations.map((rec, i) => generateHostelHtml(rec, i)).join("");
    
    // 2. Generate Travel Tools
    const toolsHtml = generateToolsHtml();

    // 3. Generate Personal Footer
    const footerHtml = generateFooterHtml();

    await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: "HostelMatchmaker <hello@trekvice.com>", 
            to: [email],
            subject: `🏝️ Your Top 5 Hostels in ${context.destination}`,
            html: `
                <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; padding: 10px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #111; font-size: 24px; margin-bottom: 10px;">Hostel Report: ${context.destination}</h1>
                        <p style="font-size: 16px; line-height: 1.6; color: #4b5563;">
                            Hi there! Based on your search for a <strong>${context.vibe}</strong> vibe with a budget of <strong>€${context.maxPrice}</strong>, 
                            here are your best matches.
                        </p>
                    </div>

                    ${hostelsHtml}

                    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />

                    ${toolsHtml}

                    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;" />

                    ${footerHtml}
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
        const { messages, context, email } = body; // <--- LEES HIER OOK EMAIL

        // --- CHECK MODE: EMAIL OF PREVIEW ---
        const isEmailMode = !!(email && email.includes("@"));
        // AANGEPAST: Limiet naar 5 voor email
        const limit = isEmailMode ? 5 : 1; 

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

TONE OF VOICE:
You are the 'Straight-Talking Traveler'. Helpful, direct, non-corporate.
IMPORTANT: All textual output (reasons, questions, summaries) must be in ENGLISH.

AUDIT REQUIREMENTS:
In 'audit_log', SHOW THE MATH using the pre-computed values.
Example: "Facilities: (Pre-calc 100% * 1.5) + Vibe: (Pre-calc 80% * 1.2) ... = Total%"

DATABASE: ${JSON.stringify(pool)}
USER CONTEXT: ${JSON.stringify(context)}

OUTPUT CONFIGURATION:
- Return EXACTLY ${limit} recommendation(s).
${isEmailMode ? "- MODE: EMAIL REPORT. Be detailed, persuasive, and thorough. English Only." : "- MODE: QUICK PREVIEW. Be concise. Only show the absolute winner. English Only."}

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
      "nomad_score": "Score/10 (e.g. 8.5)",
      "solo_score": "Score/10 (e.g. 9.0)",
      "sentiment_label": "Short sentiment summary (e.g. 'Super Social' or 'Chill Vibes')",
      "reason": "MANDATORY: Act as a travel consultant. Don't just list matches; INTERPRET them. If ages match closely, say they'll fit in perfectly. If the price is lower than budget, call it a 'steal'. If they are solo, explain EXACTLY which feature (e.g., family dinners) solves their fear of being alone. (ENGLISH)",
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
  "message": "Strategic advice or clarifying questions (ENGLISH).",
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
