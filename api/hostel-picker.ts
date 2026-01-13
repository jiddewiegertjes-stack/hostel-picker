export const runtime = "nodejs"; 
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

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

/** ---- Simple in-memory cache ---- */
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

export async function POST(req: Request) {
    const t0 = Date.now();
    let tSheetStart = 0, tSheetEnd = 0;
    let tParseStart = 0, tParseEnd = 0;
    let tReqJsonStart = 0, tReqJsonEnd = 0;
    let tFilterStart = 0, tFilterEnd = 0;
    let tOpenAIStart = 0;

    try {
        const apiKey = process.env.OPENAI_API_KEY;

        tSheetStart = Date.now();

        const now = Date.now();
        const cacheFresh = cachedHostelData && (now - cacheUpdatedAt) < CACHE_TTL_MS;

        let hostelData: any[] = [];

        if (cacheFresh) {
            hostelData = cachedHostelData as any[];
            tSheetEnd = Date.now();
            tParseStart = Date.now();
            tParseEnd = Date.now();
        } else {
            const sheetRes = await fetch(SHEET_CSV_URL, {
                cache: "force-cache",
                headers: { "Cache-Control": "max-age=300" }
            });
            
            const csvRaw = await sheetRes.text();
            tSheetEnd = Date.now();

            tParseStart = Date.now();
            hostelData = parseCSV(csvRaw);
            tParseEnd = Date.now();

            cachedCsvRaw = csvRaw;
            cachedHostelData = hostelData;
            cacheUpdatedAt = now;
        }

        tReqJsonStart = Date.now();
        const body = await req.json();
        tReqJsonEnd = Date.now();

        const { messages, context } = body;

        // --- BEVEILIGING TEGEN MISBRUIK ---
        // Check of de laatste input niet belachelijk lang is (max 600 tekens).
        const lastMsg = messages?.[messages.length - 1];
        if (lastMsg && lastMsg.content && lastMsg.content.length > 600) {
            return new Response(JSON.stringify({ 
                message: "Bericht te lang. Houd het kort a.u.b. (max 600 tekens).", 
                recommendations: [] 
            }), { status: 400, headers: corsHeaders });
        }
        // ----------------------------------

        tFilterStart = Date.now();
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        let pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);
        
        // Verrijk de pool met harde berekeningen & Normalisaties
        pool = pool.map(h => enrichHostelData(h, context));
        
        tFilterEnd = Date.now();

        // ------------------------------------------------------------------
        // DYNAMIC WEIGHTING LOGIC (NOMAD & SOLO)
        // ------------------------------------------------------------------
        const nomadWeight = context?.nomadMode ? "1.5" : "0.5";
        const soloWeight = context?.soloMode ? "1.5" : "0.5";

        tOpenAIStart = Date.now();

        // STREAMING REQUEST NAAR OPENAI
        const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json", 
                Authorization: `Bearer ${apiKey}` 
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                stream: true, // <--- BELANGRIJK: STREAMING AAN
                messages: [
                { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker.

Return EXACTLY 2 recommendations.

LOGIC FLOW (CRITICAL): 
1. **ANALYZE**: Look at the User Context and History. 
2. **DECIDE**: 
   - **Scenario A (Missing Info):** If the user request is vague (e.g. just "Antigua" or "Digital Nomad") and you need to know more (e.g. "Party vs Chill?" or "Coworking vs Room Wifi?"): 
     -> ACTION: Ask a clarifying question in 'message'. 
     -> ACTION: Generate 2-4 short, punchy 'suggestions' (bubbles) for the user to click (e.g. ["Party 🍺", "Chill 🍃", "Work 💻"]).
     -> ACTION: Set 'recommendations' to []. 
   - **Scenario B (Clear Info):** If you have enough info to make a good match: 
     -> ACTION: Provide the advice in 'message'. 
     -> ACTION: Return the top 2 'recommendations'. 
     -> ACTION: Set 'suggestions' to [].

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

INTERACTION STRATEGY (Smart Questions):
1. ANALYZE the "messages" history.
2. IF the user has NOT yet specified key preferences (like Party vs Chill, Surf vs Work, or specific amenities), AND the top 2 hostels are significantly different in character:
   - Your "message" output MUST be a single, sharp, clarifying question to help narrow it down (e.g., "Do you prioritize a pool party or a quiet workspace?", "Are you looking to surf or hike?").
   - **CRITICAL:** If you ask a question, RETURN AN EMPTY ARRAY '[]' for recommendations. Do NOT show recommendations yet.
3. IF the user has already been specific:
   - Set "message" to null. Do NOT provide conversational filler.
   - Return the 2 recommendations.

AUDIT REQUIREMENTS:
In 'audit_log', SHOW THE MATH using the pre-computed values.
Example: "Facilities: (Pre-calc 100% * 1.5) + Vibe: (Pre-calc 80% * 1.2) ... = Total%"

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
      "hostel_img": "EXACT URL FROM csv.hostel_img",
      "alert": "red_flags or 'None'",
      "reason": "MANDATORY: Act as a travel consultant. Don't just list matches; INTERPRET them. If ages match closely, say they'll fit in perfectly. If the price is lower than budget, call it a 'steal'. If they are solo, explain EXACTLY which feature (e.g., family dinners) solves their fear of being alone.",
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

        // STREAM HANDLER:
        // We sluizen de stream van OpenAI direct door naar de frontend.
        // Hierdoor ziet Vercel activiteit en sluit hij de verbinding niet.
        const stream = new ReadableStream({
            async start(controller) {
                const reader = openAIResponse.body?.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                if (!reader) {
                    controller.close();
                    return;
                }

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunkText = decoder.decode(value, { stream: true });
                        const lines = chunkText.split('\n').filter(l => l.trim() !== '');

                        for (const line of lines) {
                            if (line.includes('[DONE]')) continue;
                            if (line.startsWith('data: ')) {
                                try {
                                    const json = JSON.parse(line.replace('data: ', ''));
                                    const content = json.choices[0]?.delta?.content || "";
                                    if (content) {
                                        // We sturen alleen het tekstdeel door
                                        controller.enqueue(encoder.encode(content));
                                    }
                                } catch (e) { /* negeer incomplete chunks */ }
                            }
                        }
                    }
                } catch (err) {
                    console.error("Stream error", err);
                } finally {
                    controller.close();
                }
            }
        });

        return new Response(stream, { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
