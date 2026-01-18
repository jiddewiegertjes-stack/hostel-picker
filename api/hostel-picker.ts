export const runtime = "edge";

// --- 🔒 SECURITY CONFIGURATIE (VIP LIJST) ---
const ALLOWED_ORIGINS = [
    "https://hostel-picker.vercel.app", // Jouw productie URL
    "http://localhost:3000",            // Lokaal testen
];

function getCorsHeaders(request) {
    const origin = request.headers.get("origin") || "";
    
    // CHECK 1: Staat hij hard op de lijst? (Productie & Localhost)
    const isWhitelisted = ALLOWED_ORIGINS.includes(origin);

    // CHECK 2: Is het een Vercel Preview URL? (Eindigt op .vercel.app)
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
const COUNTRY_MAP = {
    "Guatemala": process.env.SHEET_CSV_GUATEMALA,
    "Belize": process.env.SHEET_CSV_BELIZE
};

// --- STAP 1: DEFINITIES VOOR NORMALISATIE (MAPPINGS) ---

// MAPPING 1: FACILITIES
const FEATURE_MAPPING = {
    "work": ["coworking", "desk", "wifi", "monitor", "digital nomad"],
    "digital nomad": ["coworking", "fast wifi", "desk", "workspace"],
    "party": ["bar", "nightclub", "events", "beer pong", "happy hour", "pub crawl"],
    "social": ["common room", "bar", "terrace", "games", "family dinner", "activities"],
    "kitchen": ["kitchen", "cooking", "stove", "microwave", "oven"],
    "food": ["restaurant", "cafe", "meals", "breakfast"],
    "pool": ["pool", "swimming", "jacuzzi"],
    "gym": ["gym", "fitness", "workout", "yoga"],
    "privacy": ["curtain", "pod", "private"],
    "ac": ["air conditioning", "a/c", "fan", "climate control"]
};

// MAPPING 2: VIBE
const VIBE_MAPPING = {
    "party": ["party", "nightlife", "loud", "active", "social"],
    "chill": ["chill", "quiet", "relax", "nature", "hammock", "peaceful"],
    "social": ["social", "community", "gathering", "family"],
    "work": ["digital nomad", "focused", "quiet", "hub", "coworking"],
    "nature": ["nature", "garden", "view", "eco", "jungle"]
};

/** ---- Simple in-memory cache (Edge warm instance) ---- */
let cachedCsvRaw = null;
let cachedHostelData = null;
let cacheUpdatedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// --- AANGEPASTE OPTIONS HANDLER ---
export async function OPTIONS(request) {
    return new Response(null, { 
        status: 204, 
        headers: getCorsHeaders(request) 
    });
}

function parseCSV(csvText) {
    if (!csvText || csvText.length < 10) return [];
    
    const cleanText = csvText.trim().replace(/^\uFEFF/, "");
    
    const rows = [];
    let currCell = ""; let currRow = []; let inQuotes = false;
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
        const obj = {};
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

/** * NIEUW: Pre-calculation logic (Hybrid 3.0 - Full Normalization) */
function enrichHostelData(hostel, userContext) {
    // 1. Digital Nomad Score
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

    // 4. Noise Score
    let noiseLevelBackend = 50; 
    const noiseTxt = String(hostel.noise_level || "").toLowerCase();
    
    if (noiseTxt.includes("loud") || noiseTxt.includes("party") || noiseTxt.includes("music")) noiseLevelBackend = 90;
    else if (noiseTxt.includes("medium") || noiseTxt.includes("social")) noiseLevelBackend = 50;
    else if (noiseTxt.includes("quiet") || noiseTxt.includes("peace") || noiseTxt.includes("nature")) noiseLevelBackend = 15;

    const userNoisePref = userContext?.noiseLevel !== undefined ? parseInt(userContext.noiseLevel) : 50;
    const noiseMatchScore = Math.max(0, 100 - Math.abs(userNoisePref - noiseLevelBackend));

    // 5. VIBE MATCH
    let vibeMatch = 50;
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
        if (hostelVibeDna.includes(userVibeInput)) vibeMatch = 100;
    }

    // 6. FACILITIES MATCH
    let facilitiesMatch = 50;
    let featuresFound = 0;
    let featuresLookedFor = 0;

    const combinedReqs = ((userContext?.vibe || "") + " " + (userContext?.requirements || "")).toLowerCase();
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

    // 7. AGE MATCH
    let ageMatch = 50;
    const userAge = parseInt(userContext?.age) || 25;
    const hostelAvgAge = parseInt(hostel.overal_age) || 25;
    const ageDiff = Math.abs(userAge - hostelAvgAge);
    ageMatch = Math.max(0, 100 - (ageDiff * 5));

    // 8. SIZE MATCH
    let sizeMatch = 50;
    const userSize = String(userContext?.size || "").toLowerCase();
    const hostelSizeInfo = String(hostel.rooms_info || "").toLowerCase();
    
    if (hostelSizeInfo.includes(userSize)) {
        sizeMatch = 100;
    } else if (
        (userSize === "small" && hostelSizeInfo.includes("medium")) ||
        (userSize === "large" && hostelSizeInfo.includes("medium"))
    ) {
        sizeMatch = 70;
    } else {
        sizeMatch = 30;
    }

    // 9. NATIONALITY MATCH
    let nationalityMatch = 0;
    const userNat = String(userContext?.nationalityPref || "").trim();
    
    if (userNat.length > 0) {
        try {
            let countryData = hostel.country_info;
            if (typeof countryData === 'string') {
                try { countryData = JSON.parse(countryData); } catch(e) {}
            }
            
            const matchKey = Object.keys(countryData || {}).find(k => 
                k.toLowerCase().includes(userNat.toLowerCase()) || 
                userNat.toLowerCase().includes(k.toLowerCase())
            );

            if (matchKey) {
                nationalityMatch = 100;
            } else {
                nationalityMatch = 20;
            }
        } catch (e) {
            nationalityMatch = 50;
        }
    } else {
        nationalityMatch = 100;
    }

    return {
        ...hostel,
        _computed_scores: {
            nomad: nomadScore,
            solo: soloScore,
            noise_match: noiseMatchScore,
            price_match: Math.round(priceScore),
            vibe_match: vibeMatch,
            facilities_match: facilitiesMatch,
            age_match: ageMatch,
            size_match: sizeMatch,
            nationality_match: nationalityMatch
        }
    };
}

// --- AANGEPASTE POST HANDLER ---
export async function POST(req) {
    const t0 = Date.now();
    const safeHeaders = getCorsHeaders(req);

    let tSheetStart = 0, tSheetEnd = 0;
    let tParseStart = 0, tParseEnd = 0;
    let tReqJsonStart = 0, tReqJsonEnd = 0;
    let tFilterStart = 0, tFilterEnd = 0;
    let tOpenAIStart = 0, tOpenAIEnd = 0;

    try {
        const apiKey = process.env.OPENAI_API_KEY;

        // 1. Context lezen
        tReqJsonStart = Date.now();
        const body = await req.json();
        tReqJsonEnd = Date.now();
        const { messages, context } = body;

        // 2. Land bepalen
        const selectedCountry = context?.country || "Guatemala";
        const csvUrl = COUNTRY_MAP[selectedCountry];

        if (!csvUrl) {
            return new Response(JSON.stringify({ 
                message: `Configuratie fout: Land '${selectedCountry}' is niet gekoppeld in de backend.`, 
                recommendations: [] 
            }), { status: 400, headers: safeHeaders });
        }

        // 3. Data ophalen (met simpele cache check)
        tSheetStart = Date.now();
        const now = Date.now();
        const cacheFresh = cachedHostelData && (now - cacheUpdatedAt) < CACHE_TTL_MS;

        let hostelData = [];

        // In productie zou je de cache slimmer gebruiken, maar nu fetchen we om zeker te zijn.
        const sheetRes = await fetch(csvUrl, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" }
        });
        
        const csvRaw = await sheetRes.text();
        tSheetEnd = Date.now();

        tParseStart = Date.now();
        hostelData = parseCSV(csvRaw);
        tParseEnd = Date.now();

        // Update de cache
        cachedCsvRaw = csvRaw;
        cachedHostelData = hostelData;
        cacheUpdatedAt = now;

        // --- BEVEILIGING ---
        const lastMsg = messages?.[messages.length - 1];
        if (lastMsg && lastMsg.content && lastMsg.content.length > 600) {
            return new Response(JSON.stringify({ 
                message: "Bericht te lang. Houd het kort a.u.b. (max 600 tekens).", 
                recommendations: [] 
            }), { status: 400, headers: safeHeaders });
        }

        // --- STAP 4: FILTER OP STAD (CORRECTE VERSIE) ---
        tFilterStart = Date.now();
        const userCity = (context?.destination || "").toLowerCase().trim();

        const finalData = hostelData.filter(h => {
            // Check op verschillende mogelijke kolomnamen uit je CSV
            const cityInSheet = (h.city || h.hostel_city || h.destination || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });

        // GEBRUIK ALLEEN DE GEFILTERDE DATA
        let pool = finalData; 

        // Als er geen hostels in die stad zijn, stop hier.
        if (pool.length === 0) {
            return new Response(JSON.stringify({ 
                message: `Ik kon geen hostels vinden in de stad "${context?.destination}". Controleer de spelling of kies een andere stad.`, 
                recommendations: [],
                suggestions: ["Kies andere stad 📍"]
            }), { status: 200, headers: safeHeaders });
        }
        
        // Verrijk de gefilterde data
        pool = pool.map(h => enrichHostelData(h, context));
        
        tFilterEnd = Date.now();

        // ------------------------------------------------------------------
        // AI AANROEP MET GEFILTERDE DATA
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
// STRICT RULES
// ==============================
1. STRICT INTEL GATHERING: You MUST ask 1-2 deepening questions if needed before recommending.
2. FILTERED POOL: The user is looking in specific city. ONLY use the hostels provided in the 'DATABASE'.
3. SCORING: Use '_computed_scores' for your decision.

TONE: Straight-Talking Traveler.

DATABASE: ${JSON.stringify(pool)}
USER CONTEXT: ${JSON.stringify(context)}
WEIGHTS: Nomad=${nomadWeight}, Solo=${soloWeight}

OUTPUT JSON:
{
  "recommendations": [
    {
      "name": "hostel_name",
      "location": "city",
      "matchPercentage": 0-100,
      "price": "pricing",
      "vibe": "vibe_dna",
      "hostel_img": "url",
      "alert": "red_flags or 'None'",
      "reason": "Explain WHY based on features.",
      "audit_log": { ... }
    }
  ],
  "message": "Advice or question.",
  "suggestions": ["Opt 1", "Opt 2"]
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
        
        return new Response(content, {
            status: 200, headers: safeHeaders 
        });

    } catch (error) {
        console.log(JSON.stringify({
            error: error.message
        }));
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: safeHeaders });
    }
}
