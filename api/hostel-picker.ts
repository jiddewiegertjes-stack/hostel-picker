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
    const rows: string[][] = [];
    let currCell = ""; let currRow: string[] = []; let inQuotes = false;
    const text = csvText.trim();
    for (let i = 0; i < text.length; i++) {
        const char = text[i]; const nextChar = text[i + 1];
        if (char === '"' && inQuotes && nextChar === '"') { currCell += '"'; i++; }
        else if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { currRow.push(currCell.trim()); currCell = ""; }
        else if (char === '\n' && !inQuotes) { currRow.push(currCell.trim()); rows.push(currRow); currRow = []; currCell = ""; }
        else { currCell += char; }
    }
    if (currRow.length > 0 || currCell) { currRow.push(currCell.trim()); rows.push(currRow); }
    const headers = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-h_]/g, "").trim());
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
    }).filter(h => h.hostel_name);
}

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        const sheetRes = await fetch(SHEET_CSV_URL);
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        const body = await req.json();
        const { messages, context } = body;

        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
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

                        MATCHING PILLARS (100% Total Score):
                        1. Overall Sentiment (25%): Direct use of 'overal_sentiment.score'. Higher score = higher weight.
                        2. Semantic & Social (25%): Compare chat intent to 'social_mechanism', 'pulse_summary', and 'overal_sentiment.semantics'.
                        3. Demographic Fit (20%): 
                           - Check 'country_info' for context.nationalityPref. 
                           - Check 'gender' ratios to match user comfort (e.g. higher female ratio for solo female travelers).
                        4. Size & Noise (15%): Match context.size to 'rooms_info' and context.noiseLevel to 'noise_level'.
                        5. Logic Constraints (15%): Budget and Mode (Nomad/Solo) match.

                        STRICT RULES:
                        - RED FLAGS: Do NOT decrease the matchPercentage for red flags. Instead, list them strictly in the 'alert' field.
                        - GENDER RATIO: Use the 'gender' object to refine the match if the chat implies safety or social preferences.
                        - ROOMS INFO: Use this to confirm the physical scale of the hostel matches user preference.

                        DATABASE: ${JSON.stringify(pool)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        OUTPUT JSON:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name",
                              "location": "city",
                              "reason": "Explain match using social_mechanism, pulse_summary, and demographic info (nationality/gender).",
                              "matchPercentage": 0-100,
                              "price": "pricing",
                              "vibe": "vibe_dna",
                              "alert": "Summary of 'red_flags' if they are not 'None', otherwise 'None'"
                            }
                          ],
                          "message": "Strategic advice based on the profile."
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
