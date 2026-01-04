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
        console.time("⏱️ TOTAL_DURATION");
        console.log("🚀 Start Request");
        const apiKey = process.env.OPENAI_API_KEY;

        console.time("⏱️ FETCH_SHEET");
        const sheetRes = await fetch(SHEET_CSV_URL, { next: { revalidate: 300 } }); 
        if (!sheetRes.ok) throw new Error("Failed to fetch CSV");
        const csvRaw = await sheetRes.text();
        console.timeEnd("⏱️ FETCH_SHEET");

        console.time("⏱️ PARSE_CSV");
        const hostelData = parseCSV(csvRaw);
        console.timeEnd("⏱️ PARSE_CSV");
        
        const body = await req.json();
        const { messages, context } = body;

        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        const fullPool = finalData.length > 0 ? finalData : hostelData.slice(0, 15);
        const limitedPool = fullPool.slice(0, 15);
        const aiPayload = limitedPool.map(({ hostel_img, ...rest }) => rest);

        console.log("🤖 Sending to OpenAI...");
        console.time("⏱️ OPENAI_LATENCY");

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

                        STRICT OUTPUT CONSTRAINTS FOR SPEED:
                        For the fields below, be extremely concise. Use fragments, not full sentences.
                        - facility_proof: List only key keywords from csv.facilities (max 8 words).
                        - price_logic: Brief budget proximity status (max 10 words).
                        - noise_logic: Compare user focus vs csv.noise_level briefly (max 10 words).
                        - demographic_logic: Compare age alignement (max 8 words).
                        - trade_off_analysis: One sentence contrast Nomad vs Solo (max 15 words).
                        - sentiment_logic: Brief summary of csv.overal_sentiment.score (max 10 words).

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

                        Tone of voice: Straight-Talking Traveler.

                        DATABASE: ${JSON.stringify(aiPayload)}
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
                              "alert": "red_flags or 'None'",
                              "reason": "Short summary",
                              "audit_log": {
                                "score_breakdown": "Price: (X% * 1.0) + ... = Total Match%",
                                "price_logic": "[Concise: Max 10 words]",
                                "sentiment_logic": "[Concise: Max 10 words]",
                                "noise_logic": "[Concise: Max 10 words]",
                                "vibe_logic": "Match status vibe vs csv.vibe_dna.",
                                "trade_off_analysis": "[Concise: Max 15 words contrast]",
                                "pulse_summary_proof": "RAW DATA FROM csv.pulse_summary",
                                "sentiment_proof": "RAW DATA FROM csv.overal_sentiment JSON",
                                "facility_proof": "[Keywords only: Max 8 words]",
                                "nomad_proof": "Weight 0.9: data from csv.digital_nomad_score",
                                "solo_proof": "Weight 0.7: data from csv.solo_verdict",
                                "demographic_logic": "[Concise: Max 8 words]"
                              }
                            }
                          ],
                          "message": "Strategic advice."
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        console.timeEnd("⏱️ OPENAI_LATENCY");
        
        if (!aiData.choices || !aiData.choices[0]) throw new Error("OpenAI error");

        const rawContent = aiData.choices[0].message.content;
        const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
        let parsedContent = JSON.parse(cleanJson);
        
        if (parsedContent.recommendations && Array.isArray(parsedContent.recommendations)) {
            parsedContent.recommendations = parsedContent.recommendations.map((rec: any) => {
                const recName = (rec.name || "").toLowerCase();
                const original = limitedPool.find(h => (h.hostel_name || "").toLowerCase().includes(recName) || recName.includes((h.hostel_name || "").toLowerCase()));
                return { ...rec, hostel_img: original?.hostel_img || "" };
            });
        }

        console.log("✅ Success! Returning data.");
        console.timeEnd("⏱️ TOTAL_DURATION");

        return new Response(JSON.stringify(parsedContent), { status: 200, headers: corsHeaders });

    } catch (error: any) {
        console.error("❌ BACKEND ERROR:", error);
        console.timeEnd("⏱️ TOTAL_DURATION");
        return new Response(JSON.stringify({ message: "Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
