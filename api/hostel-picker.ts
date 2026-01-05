export const runtime = "edge";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

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

// --- Shortlist helpers (added) ---
function clamp(n: number, min = 0, max = 100) {
    return Math.max(min, Math.min(max, n));
}

function toNumber(val: any, fallback = 0) {
    if (typeof val === "number" && Number.isFinite(val)) return val;
    const n = parseFloat(String(val ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : fallback;
}

function priceProximityScore(actualPrice: number, targetPrice: number) {
    if (!actualPrice || !targetPrice) return 50;
    const pctDiff = Math.abs(actualPrice - targetPrice) / targetPrice;
    const sigma = 0.25; // bell-ish width
    const score = 100 * Math.exp(-(pctDiff * pctDiff) / (2 * sigma * sigma));
    return clamp(score);
}

function vibeMatchScore(hostelVibe: string, userVibe: string) {
    const hv = (hostelVibe || "").toLowerCase();
    const uv = (userVibe || "").toLowerCase();
    if (!hv || !uv) return 50;
    if (hv.includes(uv) || uv.includes(hv)) return 95;

    const buckets: Record<string, string[]> = {
        party: ["party", "very social"],
        quiet: ["quiet", "chill", "relaxed"],
        nomad: ["nomad", "digital"],
        solo: ["solo"],
        social: ["social"],
    };
    const inBucket = (s: string, keys: string[]) => keys.some(k => s.includes(k));
    for (const key of Object.keys(buckets)) {
        if (inBucket(hv, buckets[key]) && inBucket(uv, buckets[key])) return 85;
    }
    return 55;
}

function noiseMatchScore(hostelNoise: number, userNoise: number) {
    const diff = Math.abs(hostelNoise - userNoise);
    return clamp(100 - diff);
}

function shortlistScore(h: any, context: any) {
    const price = toNumber(h.pricing, 0);
    const target = toNumber(context?.maxPrice, 0);

    const sentimentScore = toNumber(h.overal_sentiment?.score ?? h.overal_sentiment_score, 50);

    const nomadRaw = h.digital_nomad_score?.score ?? h.digital_nomad_score;
    const nomadScore = toNumber(nomadRaw, 50);

    const soloRaw = h.solo_verdict?.rank ?? h.solo_rank;
    const soloScore = clamp(toNumber(soloRaw, 5) * 10);

    const noise = toNumber(h.noise_level, 50);

    const priceS = priceProximityScore(price, target);
    const vibeS = vibeMatchScore(h.vibe_dna, context?.vibe);
    const noiseS = noiseMatchScore(noise, toNumber(context?.noiseLevel, 50));

    const roomsS = 50;
    const ageS = 50;

    const total =
        priceS * 1.0 +
        sentimentScore * 1.0 +
        nomadScore * 0.9 +
        vibeS * 0.8 +
        soloScore * 0.7 +
        noiseS * 0.3 +
        roomsS * 0.3 +
        ageS * 0.2;

    return total;
}
// --- End shortlist helpers ---

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;

        const cacheBuster = SHEET_CSV_URL.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
        const sheetRes = await fetch(SHEET_CSV_URL + cacheBuster);
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        const body = await req.json();
        const { messages, context } = body;

        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        const poolBase = finalData.length > 0 ? finalData : hostelData.slice(0, 25);

        // --- Shortlist (added) ---
        const pool = [...poolBase]
            .map(h => ({ h, s: shortlistScore(h, context) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, 10)
            .map(x => x.h);
        // --- End shortlist ---

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker. Calculate match percentages using a weighted scoring algorithm.

Return EXACTLY 3 recommendations from the provided database that best fit the user context."

                        SCORING INDICES (Weights):
                        Assign points using these specific multipliers:
                        - Pricing: 1.0 (Target Proximity)
                        - Overall Sentiment: 1.0 (Critical - based on csv.overal_sentiment.score)
                        - Digital Nomad suitability: 0.9 (Very High)
                        - Vibe Tags: 0.8 (High)
                        - Solo Traveler suitability: 0.7 (High)
                        - Noise Level: 0.3 (Low)
                        - Rooms Info (Size/Type): 0.3 (Low)
                        - Overall Age Match: 0.2 (Very Low)

                        Tone of voice: You are the 'Straight-Talking Traveler'—giving honest, practical hostel advice based on hard data. Your tone is helpful, direct, and non-corporate.

                        SPECIAL PRICING LOGIC (Estimated Price):
                        Treat context.maxPrice (€${context.maxPrice}) as an ESTIMATED IDEAL PRICE, not a hard maximum limit. 
                        Do not filter hostels out for being over this price.
                        - Pricing Score (Weight 1.0): Use bell-curve proximity logic. 
                        - 100% Score: Actual price is within +/- 10% of €${context.maxPrice}.
                        - Proximity: A hostel costing €42 is a BETTER match for a €40 estimate than a hostel costing €15 (potential quality mismatch) or €65 (too expensive).
                        - Penalty: Deduct points gradually as the price moves further away (higher OR lower) from the estimate.

                        NEW PROTOCOL: INSUFFICIENT INPUT & SMART AUDIT
                        1. PROFILE DATA IS FINAL: Data in 'USER CONTEXT' (Price, Noise, Vibe, Destination, Age) is already provided by the user.
                        2. DO NOT ASK for info already in USER CONTEXT.
                        3. TRIGGER CRITERIA: Only return an empty [] recommendations array if the chat message is a simple greeting or vague statement.
                        4. SMART START: If the user says "show me the best spots" or similar, IMMEDIATELY perform the audit based on Profile Data.
                        5. QUESTIONS: Focus only on "The Soul of the Trip" (specific social needs or work setup) not found in buttons.

                        STRICT RULES:
                        - RED FLAGS: Do NOT decrease the matchPercentage for red flags. Instead, list them strictly in the 'alert' field.
                        - DATABASE PROOF: You must provide RAW DATA from the spreadsheet for facilities, nomad, solo, pulse, and sentiment proofs.
                        - TRADE-OFF ANALYSIS: In the audit_log, contrast the Digital Nomad quality with the Solo Traveler social vibe.
                        - MATHEMATICAL AUDIT: In 'score_breakdown', you MUST show the step-by-step calculation: You MUST include ALL categories (Price, Sentiment, Nomad, Vibe, Solo, Noise, Rooms, Age) with their labels.
                        Format example: "Price: (95% * 1.0) + Sentiment: (90% * 1.0) + Nomad: (70% * 0.9) + Vibe: (80% * 0.8) + Solo: (60% * 0.7) + Noise: (50% * 0.3) + Rooms: (40% * 0.3) + Age: (30% * 0.2) = Total Match%"

                        DATABASE: ${JSON.stringify(pool)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        AUDIT REQUIREMENTS:
                        For each hostel, compare the user's input (Profile + Chat) directly to the CSV columns:
                        - Price: user.maxPrice vs csv.pricing (Proximity check)
                        - Sentiment: analysis of csv.overal_sentiment.score (Weight 1.0)
                        - Noise: user.noiseLevel (1-100) vs csv.noise_level
                        - Vibe: user.vibe vs csv.vibe_dna
                        - Social: chat request vs csv.social_mechanism & pulse_summary & facilities
                        - Proofs: Extract EXACT text from csv.facilities, csv.digital_nomad_score, csv.solo_verdict, csv.pulse_summary, and csv.overal_sentiment.
                        - Images: Extract the EXACT URL from csv.hostel_img and place it in the hostel_img field.

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
                              "audit_log": {
                                "score_breakdown": "MUST include all 8 categories with labels: Price: (X% * 1.0) + Sentiment: (Y% * 1.0) + Nomad: (Z% * 0.9) + Vibe: (A% * 0.8) + Solo: (B% * 0.7) + Noise: (C% * 0.3) + Rooms: (D% * 0.3) + Age: (E% * 0.2) = Total Match%",
                                "price_logic": "Weight 1.0 Target proximity analysis: User estimated €${context.maxPrice}, hostel is €pricing.",
                                "sentiment_logic": "Weight 1.0: Analysis of overall sentiment score from csv.overal_sentiment.",
                                "noise_logic": "Weight 0.3: user ${context.noiseLevel} vs csv.noise_level.",
                                "vibe_logic": "Weight 0.8: Match status of user vibe ${context.vibe} vs csv.vibe_dna.",
                                "trade_off_analysis": "Expert contrast: Nomad (0.9) vs Solo (0.7).",
                                "pulse_summary_proof": "RAW DATA FROM csv.pulse_summary",
                                "sentiment_proof": "RAW DATA FROM csv.overal_sentiment JSON",
                                "facility_proof": "RAW DATA FROM csv.facilities COLUMN",
                                "nomad_proof": "Weight 0.9: data from csv.digital_nomad_score",
                                "solo_proof": "Weight 0.7: data from csv.solo_verdict",
                                "demographic_logic": "Weight 0.2: Compare user age (${context.age}) with typical age group from csv.overal_age."
                              }
                            }
                          ],
                          "message": "Strategic advice or clarifying questions."
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        const content = aiData.choices[0].message.content;
        
        return new Response(content, {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
