export const runtime = "edge";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

// --- STAP 1: DEFINITIES VOOR NORMALISATIE (MAPPINGS) ---

const FEATURE_MAPPING: Record<string, string[]> = {
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

export async function OPTIONS() {
    return new Response(null, { status: 204, headers: corsHeaders });
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

function enrichHostelData(hostel: any, userContext: any) {
    let nomadScore = 50; 
    try {
        if (hostel.digital_nomad_score) {
            const val = hostel.digital_nomad_score;
            const json = typeof val === 'string' ? JSON.parse(val) : val;
            nomadScore = (json.rank || 5) * 10;
        }
    } catch (e) { nomadScore = 50; }

    let soloScore = 50;
    try {
        if (hostel.solo_verdict) {
            const val = hostel.solo_verdict;
            const json = typeof val === 'string' ? JSON.parse(val) : val;
            soloScore = (json.rank || 5) * 10;
        }
    } catch (e) { soloScore = 50; }

    let priceScore = 0;
    const price = parseFloat(hostel.pricing);
    const target = parseFloat(userContext?.maxPrice) || 30;
    if (!isNaN(price)) {
        const diff = Math.abs(price - target);
        priceScore = Math.max(0, 100 - (diff * 2.5)); 
    } else { priceScore = 50; }

    let noiseLevelBackend = 50; 
    const noiseTxt = String(hostel.noise_level || "").toLowerCase();
    if (noiseTxt.includes("loud") || noiseTxt.includes("party") || noiseTxt.includes("music")) noiseLevelBackend = 90;
    else if (noiseTxt.includes("medium") || noiseTxt.includes("social")) noiseLevelBackend = 50;
    else if (noiseTxt.includes("quiet") || noiseTxt.includes("peace") || noiseTxt.includes("nature")) noiseLevelBackend = 15;

    const userNoisePref = userContext?.noiseLevel !== undefined ? parseInt(userContext.noiseLevel) : 50;
    const noiseMatchScore = Math.max(0, 100 - Math.abs(userNoisePref - noiseLevelBackend));

    let vibeMatch = 50;
    const userVibeInput = String(userContext?.vibe || "").toLowerCase();
    const hostelVibeDna = String(hostel.vibe_dna || "").toLowerCase();
    let vibeHits = 0; let vibeChecks = 0;
    Object.keys(VIBE_MAPPING).forEach(vibeKey => {
        if (userVibeInput.includes(vibeKey)) {
            vibeChecks++;
            const keywords = VIBE_MAPPING[vibeKey];
            if (keywords.some(k => hostelVibeDna.includes(k))) { vibeHits++; }
        }
    });
    if (vibeChecks > 0) {
        vibeMatch = Math.round((vibeHits / vibeChecks) * 100);
        if (hostelVibeDna.includes(userVibeInput)) vibeMatch = 100;
    }

    let facilitiesMatch = 50;
    let featuresFound = 0; let featuresLookedFor = 0;
    const combinedReqs = ((userContext?.vibe || "") + " " + (userContext?.requirements || "")).toLowerCase();
    const hostelFacilities = String(hostel.facilities || "").toLowerCase();
    Object.keys(FEATURE_MAPPING).forEach(userKey => {
        if (combinedReqs.includes(userKey)) {
            featuresLookedFor++;
            const backendKeywords = FEATURE_MAPPING[userKey];
            if (backendKeywords.some(keyword => hostelFacilities.includes(keyword))) { featuresFound++; }
        }
    });
    if (featuresLookedFor > 0) { facilitiesMatch = Math.round((featuresFound / featuresLookedFor) * 100); }

    let ageMatch = 50;
    const userAge = parseInt(userContext?.age) || 25;
    const hostelAvgAge = parseInt(hostel.overal_age) || 25;
    const ageDiff = Math.abs(userAge - hostelAvgAge);
    ageMatch = Math.max(0, 100 - (ageDiff * 5));

    let sizeMatch = 50;
    const userSize = String(userContext?.size || "").toLowerCase();
    const hostelSizeInfo = String(hostel.rooms_info || "").toLowerCase();
    if (hostelSizeInfo.includes(userSize)) { sizeMatch = 100; }
    else if ((userSize === "small" && hostelSizeInfo.includes("medium")) || (userSize === "large" && hostelSizeInfo.includes("medium"))) { sizeMatch = 70; }
    else { sizeMatch = 30; }

    let nationalityMatch = 0;
    const userNat = String(userContext?.nationalityPref || "").trim();
    if (userNat.length > 0) {
        try {
            let countryData = hostel.country_info;
            if (typeof countryData === 'string') { try { countryData = JSON.parse(countryData); } catch(e) {} }
            const matchKey = Object.keys(countryData || {}).find(k => k.toLowerCase().includes(userNat.toLowerCase()) || userNat.toLowerCase().includes(k.toLowerCase()));
            if (matchKey) { nationalityMatch = 100; } else { nationalityMatch = 20; }
        } catch (e) { nationalityMatch = 50; }
    } else { nationalityMatch = 100; }

    return {
        ...hostel,
        _computed_scores: {
            nomad: nomadScore, solo: soloScore, noise_match: noiseMatchScore, price_match: Math.round(priceScore),
            vibe_match: vibeMatch, facilities_match: facilitiesMatch, age_match: ageMatch, size_match: sizeMatch, nationality_match: nationalityMatch
        }
    };
}

export async function POST(req: Request) {
    const t0 = Date.now();
    let tSheetStart = 0, tSheetEnd = 0; let tParseStart = 0, tParseEnd = 0; let tReqJsonStart = 0, tReqJsonEnd = 0;
    let tFilterStart = 0, tFilterEnd = 0; let tOpenAIStart = 0, tOpenAIEnd = 0;

    try {
        const apiKey = process.env.OPENAI_API_KEY;
        tSheetStart = Date.now();
        const now = Date.now();
        const cacheFresh = cachedHostelData && (now - cacheUpdatedAt) < CACHE_TTL_MS;
        let hostelData: any[] = [];

        if (cacheFresh) {
            hostelData = cachedHostelData as any[];
            tSheetEnd = Date.now(); tParseStart = Date.now(); tParseEnd = Date.now();
        } else {
            const sheetRes = await fetch(SHEET_CSV_URL, { cache: "force-cache", headers: { "Cache-Control": "max-age=300" } });
            const csvRaw = await sheetRes.text();
            tSheetEnd = Date.now(); tParseStart = Date.now(); hostelData = parseCSV(csvRaw); tParseEnd = Date.now();
            cachedCsvRaw = csvRaw; cachedHostelData = hostelData; cacheUpdatedAt = now;
        }

        tReqJsonStart = Date.now(); const body = await req.json(); tReqJsonEnd = Date.now();
        const { messages, context } = body;

        tFilterStart = Date.now();
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        let pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);
        pool = pool.map(h => enrichHostelData(h, context));
        tFilterEnd = Date.now();

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

Return EXACTLY 2 recommendations.

SCORING ALGORITHM (Weighted):
ALL key metrics have been PRE-CALCULATED in '_computed_scores'.
1. FACILITIES MATCH (Weight 0.8): '_computed_scores.facilities_match'
2. PRICE MATCH (Weight 0.8): '_computed_scores.price_match'
3. VIBE MATCH (Weight 1.2): '_computed_scores.vibe_match'
4. NOISE MATCH (Weight 0.5): '_computed_scores.noise_match'
5. SENTIMENT (Weight 1.2): EXTRACT 'score' from 'csv.overal_sentiment' JSON.
6. DIGITAL NOMAD SCORE (Weight ${nomadWeight}): '_computed_scores.nomad'
7. SOLO TRAVELER SCORE (Weight ${soloWeight}): '_computed_scores.solo'
8. AGE MATCH (Weight 0.5): '_computed_scores.age_match'
9. SIZE PREFERENCE (Weight 0.5): '_computed_scores.size_match'
10. NATIONALITY (Weight 0.5): '_computed_scores.nationality_match'

TONE OF VOICE:
Straight-Talking Traveler. Helpful, direct, non-corporate.

INTERACTION STRATEGY (CRITICAL - BE VERY INQUISITIVE):
1. ANALYZE the "messages" history.
2. **PHASE 1: CLARIFICATION (Default Phase)**
   - **RULE OF THUMB: If you only have a Location and a general Vibe, you MUST ASK A QUESTION.**
   - Do NOT give recommendations unless the user has confirmed at least ONE specific amenity (e.g. "Work", "Pool", "Kitchen") OR a specific sub-vibe (e.g. "Party hard" vs "Social but quiet").
   - If in doubt, ASK.
   - When asking, return 'recommendations': [] and populate 'suggested_actions' with 2-4 short options (max 3 words).
     - Example: ["💻 Coworking needed", "🏊 Pool is key", "🌮 Kitchen access"]

3. **PHASE 2: RECOMMENDATION (Only when detailed)**
   - Only proceed here if the user's intent is crystal clear and matches specific hostels.
   - RETURN 'recommendations': [Top 2 Hostels].
   - RETURN 'message': Friendly summary.
   - RETURN 'suggested_actions': [] (Empty Array).

AUDIT REQUIREMENTS:
In 'audit_log', SHOW THE MATH using the pre-computed values.

DATABASE: ${JSON.stringify(pool)}
USER CONTEXT: ${JSON.stringify(context)}

OUTPUT JSON STRUCTURE:
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
      "reason": "Interpretation.",
      "audit_log": {
        "score_breakdown": "math",
        "facilities_logic": "text",
        "vibe_logic": "text",
        "sentiment_logic": "text",
        "pulse_summary_proof": "data",
        "sentiment_proof": "data",
        "nomad_proof": "data",
        "solo_proof": "data"
      }
    }
  ],
  "message": "Question or advice.",
  "suggested_actions": ["Option 1", "Option 2", "Option 3"]
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
            ms_openai_fetch_and_json: tOpenAIEnd - tOpenAIStart,
            pool_count: pool.length
        }));
        
        return new Response(content, { status: 200, headers: corsHeaders });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
