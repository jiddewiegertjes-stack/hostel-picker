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

    // HEADERS FIX: Zorg dat we exact de kleine letters en underscores pakken
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
        
        const pool = finalData.length > 0 ? finalData : hostelData.slice(0, 15);

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker. Calculate match percentages using these weights:
                        - Pricing: 1.0 (exponential penalty if over budget)
                        - Digital Nomad: 0.9
                        - Vibe Tags: 0.8
                        - Solo Traveler: 0.7
                        - Noise/Rooms/Gender/Age: 0.2 to 0.3 each.

                        STRICT OUTPUT FORMAT:
                        If the user just says "Hi" or is vague, ask 2 clarifying questions and return recommendations: [].
                        Otherwise, perform the audit.

                        In 'score_breakdown', provide a brief string showing the main contributors to the score, e.g., "Price(1.0) + Nomad(0.9) - Noise penalty".

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
                              "alert": "red_flags or 'None'",
                              "audit_log": {
                                "score_breakdown": "Calculation summary here",
                                "price_logic": "Analysis vs €${context.maxPrice}",
                                "noise_logic": "Noise assessment",
                                "vibe_logic": "Vibe match status",
                                "trade_off_analysis": "Nomad vs Solo balance",
                                "pulse_summary_proof": "csv.pulse_summary",
                                "sentiment_proof": "csv.overal_sentiment",
                                "facility_proof": "csv.facilities",
                                "nomad_proof": "csv.digital_nomad_score",
                                "solo_proof": "csv.solo_verdict",
                                "demographic_logic": "Age/Gender mix"
                              }
                            }
                          ],
                          "message": "Direct traveler advice."
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiRes = await response.json();
        return new Response(JSON.stringify(JSON.parse(aiRes.choices[0].message.content)), {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: [] }), { status: 200, headers: corsHeaders });
    }
}
