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
    
    // Verwijder onzichtbare tekens (BOM) aan het begin van het bestand
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

    // HEADERS FIX: Nu met 0-9 ondersteuning en robuustere opschoning
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

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;

        // CACHE BUSTER: Voegt een timestamp toe om verse data van Google te dwingen
        const cacheBuster = SHEET_CSV_URL.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
        const sheetRes = await fetch(SHEET_CSV_URL + cacheBuster);
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        const body = await req.json();
        const { messages, context } = body;

        // FILTER FIX: Maakt stadsnaam vergelijking ongevoelig voor spaties en hoofdletters
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        const pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker. Calculate match percentages based on strict pillars.

                        Tone of voice: You are the 'Straight-Talking Traveler'—giving honest, practical hostel advice based on hard data. Your tone is helpful, direct, and non-corporate.

                        MATCHING PILLARS (100% Total Score):
                        1. Overall Sentiment (25%): Direct use of 'overal_sentiment.score'. Higher score = higher weight.
                        2. Semantic & Social (25%): Compare chat intent to 'social_mechanism', 'pulse_summary', and 'overal_sentiment.semantics'.
                        3. Demographic Fit (20%): 
                            - Check 'country_info' for context.nationalityPref. 
                            - Check 'gender' ratios and match 'overal_age' to the user age (${context.age}).
                        4. Size & Noise (15%): Match context.size to 'rooms_info' and context.noiseLevel to 'noise_level'.
                        5. Logic Constraints (15%): Budget and Mode (Nomad/Solo) match.

                        NEW PROTOCOL: INSUFFICIENT INPUT
                        If the user's latest message is very brief, vague (e.g., "Hi", "help me", "show me a place"), or lacks enough detail to provide a high-quality audit despite the Profile data:
                        1. Return an empty "recommendations" array: [].
                        2. In the "message" field, ask 2 to 3 punchy, expert questions to uncover their specific needs (e.g., social style, work requirements, or specific amenities).
                        3. Do NOT provide recommendations until you feel you can give a truly personalized audit.

                        STRICT RULES:
                        - RED FLAGS: Do NOT decrease the matchPercentage for red flags. Instead, list them strictly in the 'alert' field.
                        - DATABASE PROOF: You must provide RAW DATA from the spreadsheet for facilities, nomad, solo, pulse, and sentiment proofs.
                        - TRADE-OFF ANALYSIS: In the audit_log, contrast the Digital Nomad quality with the Solo Traveler social vibe.

                        DATABASE: ${JSON.stringify(pool)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        AUDIT REQUIREMENTS:
                        For each hostel, compare the user's input (Profile + Chat) directly to the CSV columns:
                        - Price: user.maxPrice vs csv.pricing
                        - Noise: user.noiseLevel (1-100) vs csv.noise_level
                        - Vibe: user.vibe vs csv.vibe_dna
                        - Social: chat request vs csv.social_mechanism & pulse_summary & facilities
                        - Proofs: Extract EXACT text from csv.facilities, csv.digital_nomad_score, csv.solo_verdict, csv.pulse_summary, and csv.overal_sentiment.

                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name",
                              "location": "city",
                              "matchPercentage": 0-100,
                              "price": "pricing",
                              "vibe": "vibe_dna",
                              "alert": "red_flags or 'None'",
                              "audit_log": {
                                "price_logic": "User wants €${context.maxPrice}, hostel is €pricing. [Match status]",
                                "noise_logic": "User wants noise level ${context.noiseLevel}, CSV noise_level is csv.noise_level. [Match status]",
                                "vibe_logic": "User wants vibe ${context.vibe}, CSV vibe_dna contains vibe_dna. [Match status]",
                                "trade_off_analysis": "Expert contrast: compare the work suitability vs social atmosphere based on CSV data.",
                                "pulse_summary_proof": "RAW DATA FROM csv.pulse_summary",
                                "sentiment_proof": "RAW DATA FROM csv.overal_sentiment JSON",
                                "facility_proof": "RAW DATA FROM csv.facilities COLUMN",
                                "nomad_proof": "RAW REASONING FROM csv.digital_nomad_score JSON",
                                "solo_proof": "RAW EXPLANATION FROM csv.solo_verdict JSON",
                                "demographic_logic": "Checking nationalityPref vs country_info AND user age ${context.age} vs csv.overal_age."
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
        return new Response(aiData.choices[0].message.content, {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
