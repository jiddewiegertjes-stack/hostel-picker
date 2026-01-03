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
    const rows: string[][] = [];
    let currCell = "";
    let currRow: string[] = [];
    let inQuotes = false;

    // Normalize and iterate
    const text = csvText.trim();
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currCell += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            currRow.push(currCell.trim());
            currCell = "";
        } else if (char === '\n' && !inQuotes) {
            currRow.push(currCell.trim());
            rows.push(currRow);
            currRow = [];
            currCell = "";
        } else {
            currCell += char;
        }
    }
    if (currRow.length > 0 || currCell) {
        currRow.push(currCell.trim());
        rows.push(currRow);
    }

    if (rows.length === 0) return [];
    
    // Header cleaning (e.g. 'pulse_summary:' -> 'pulse_summary')
    const headers = rows[0].map(h => h.replace(/[:"']/g, "").trim());

    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            // Remove wrapping quotes
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            
            // Clean up double-double quotes in potential JSON strings
            if (val.includes('{') && val.includes('}')) {
                try {
                    const sanitized = val.replace(/""/g, '"');
                    obj[header] = JSON.parse(sanitized);
                } catch (e) {
                    obj[header] = val;
                }
            } else {
                obj[header] = val;
            }
        });
        return obj;
    });
}

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("API Key missing");

        const sheetRes = await fetch(SHEET_CSV_URL);
        if (!sheetRes.ok) throw new Error("Could not fetch CSV data");
        const csvRaw = await sheetRes.text();
        
        const hostelData = parseCSV(csvRaw);
        if (hostelData.length === 0) throw new Error("Database is empty or failed to parse");

        const body = await req.json();
        const { messages, context } = body;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are a Senior Hostel Matchmaker. 
                        STRICT RULES:
                        1. ONLY recommend hostels from the provided DATABASE.
                        2. Database content: ${JSON.stringify(hostelData)}
                        3. Use user profile context: ${JSON.stringify(context)}.
                        4. Focus on 'overal_sentiment.semantics' and 'vibe_dna'.
                        
                        OUTPUT FORMAT:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name",
                              "location": "city",
                              "reason": "Detailed reasoning based on spreadsheet data",
                              "matchPercentage": 0-100,
                              "price": "pricing",
                              "vibe": "vibe_dna",
                              "alert": "red_flags or 'None'"
                            }
                          ],
                          "message": "Direct response to user"
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const data = await response.json();
        return new Response(data.choices[0].message.content, {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "Error: " + error.message }), { 
            status: 500, 
            headers: corsHeaders 
        });
    }
}
