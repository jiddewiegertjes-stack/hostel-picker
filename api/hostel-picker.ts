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
        
        const pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker. Select EXACTLY 3 recommendations.
                        
                        SPEED PROTOCOL: 
                        1. Select hostels based on DATABASE.
                        2. Return ONLY JSON. 
                        3. DO NOT repeat CSV data fields like images, location, or full vibe descriptions in the JSON structure. 
                        4. The frontend will populate these fields using the 'name'.
                        
                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "exact_hostel_name_from_csv",
                              "matchPercentage": 0-100,
                              "reason": "One very short direct sentence.",
                              "score_breakdown": "P:X% + S:Y% + N:Z% + V:A% + So:B% + No:C% + R:D% + A:E% = Total%"
                            }
                          ],
                          "message": "Direct strategic advice (max 15 words)."
                        }

                        DATABASE: ${JSON.stringify(pool)}
                        USER CONTEXT: ${JSON.stringify(context)}`
                    },
                    ...messages
                ],
                temperature: 0,
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        const content = JSON.parse(aiData.choices[0].message.content);
        
        // We sturen de AI resultaten én de raw database rijen terug voor de frontend hydration
        return new Response(JSON.stringify({
            recommendations: content.recommendations || [],
            message: content.message || "",
            rawDatabase: pool 
        }), {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ 
            message: "System Error: " + error.message, 
            recommendations: [], 
            rawDatabase: [] 
        }), { status: 200, headers: corsHeaders });
    }
}
