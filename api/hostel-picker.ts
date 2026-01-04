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

// Jouw originele CSV parser (ongewijzigd)
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

export async function POST(req: Request) {
    try {
        console.log("🚀 Start Request");
        const apiKey = process.env.OPENAI_API_KEY;

        // STAP 1: Haal data op (Cache voor 5 min om crashes te voorkomen, niet te agressief)
        const sheetRes = await fetch(SHEET_CSV_URL, { next: { revalidate: 300 } }); 
        if (!sheetRes.ok) throw new Error("Failed to fetch CSV");
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        console.log(`📊 CSV Loaded: ${hostelData.length} rows`);

        const body = await req.json();
        const { messages, context } = body;

        // Filter op stad
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        // STAP 2: Maak de pool kleiner en "Lean"
        const fullPool = finalData.length > 0 ? finalData : hostelData.slice(0, 15);
        const limitedPool = fullPool.slice(0, 15);

        // Verwijder plaatjes en zware velden voor de AI payload
        const aiPayload = limitedPool.map(({ hostel_img, ...rest }) => rest);

        console.log("🤖 Sending to OpenAI...");

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
                        1. PROFILE DATA IS FINAL: Data in 'USER CONTEXT' is already provided.
                        2. DO NOT ASK for info already in USER CONTEXT.
                        3. TRIGGER CRITERIA: Only return an empty [] recommendations array if the chat message is a simple greeting.
                        4. SMART START: If the user says "show me the best spots", IMMEDIATELY perform the audit.

                        STRICT RULES:
                        - RED FLAGS: List them strictly in the 'alert' field.
                        - DATABASE PROOF: You must provide RAW DATA from the spreadsheet for facilities, nomad, solo, pulse, and sentiment proofs.
                        - TRADE-OFF ANALYSIS: In the audit_log, contrast the Digital Nomad quality with the Solo Traveler social vibe.
                        - MATHEMATICAL AUDIT: In 'score_breakdown', you MUST show the step-by-step calculation including ALL categories.

                        DATABASE: ${JSON.stringify(aiPayload)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name (MUST MATCH DATABASE NAME EXACTLY)",
                              "location": "city",
                              "matchPercentage": 0-100,
                              "price": "pricing",
                              "vibe": "vibe_dna",
                              "alert": "red_flags or 'None'",
                              "reason": "Why is this a match?",
                              "audit_log": {
                                "score_breakdown": "Price: (X% * 1.0) + ... = Total Match%",
                                "price_logic": "...",
                                "sentiment_logic": "...",
                                "noise_logic": "...",
                                "vibe_logic": "...",
                                "trade_off_analysis": "...",
                                "pulse_summary_proof": "RAW DATA FROM csv.pulse_summary",
                                "sentiment_proof": "RAW DATA FROM csv.overal_sentiment JSON",
                                "facility_proof": "RAW DATA FROM csv.facilities COLUMN",
                                "nomad_proof": "Weight 0.9: data from csv.digital_nomad_score",
                                "solo_proof": "Weight 0.7: data from csv.solo_verdict",
                                "demographic_logic": "..."
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
        
        // ERROR CHECK: Check of OpenAI wel iets teruggaf
        if (!aiData.choices || !aiData.choices[0]) {
            throw new Error("OpenAI returned empty response");
        }

        const rawContent = aiData.choices[0].message.content;
        
        // STAP 3: CLEANING (Dit is cruciaal, hier ging het waarschijnlijk mis)
        // Verwijder markdown ```json ... ``` wrappers die OpenAI vaak toevoegt
        const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
        
        let parsedContent;
        try {
            parsedContent = JSON.parse(cleanJson);
        } catch (e) {
            console.error("JSON Parse Error. Raw content:", rawContent);
            throw new Error("AI returned invalid JSON");
        }
        
        // STAP 4: Re-hydration / Merging (Plaatjes terugzetten)
        if (parsedContent.recommendations && Array.isArray(parsedContent.recommendations)) {
            parsedContent.recommendations = parsedContent.recommendations.map((rec: any) => {
                // Zoek het originele hostel object (case insensitive)
                const recName = (rec.name || "").toLowerCase();
                const original = limitedPool.find(h => (h.hostel_name || "").toLowerCase().includes(recName) || recName.includes((h.hostel_name || "").toLowerCase()));
                
                return {
                    ...rec,
                    hostel_img: original?.hostel_img || "" // Zet de image URL terug
                };
            });
        }

        console.log("✅ Success! Returning data.");

        return new Response(JSON.stringify(parsedContent), {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        console.error("❌ BACKEND ERROR:", error);
        return new Response(JSON.stringify({ 
            message: "System Error: " + error.message + ". Check Vercel Logs.", 
            recommendations: null 
        }), { status: 200, headers: corsHeaders });
    }
}
