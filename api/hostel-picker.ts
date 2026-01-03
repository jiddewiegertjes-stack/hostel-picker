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

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        const nextChar = csvText[i + 1];
        if (char === '"' && inQuotes && nextChar === '"') {
            currCell += '"'; i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            currRow.push(currCell.trim()); currCell = "";
        } else if (char === '\n' && !inQuotes) {
            currRow.push(currCell.trim()); rows.push(currRow);
            currRow = []; currCell = "";
        } else {
            currCell += char;
        }
    }
    if (currRow.length > 0 || currCell) {
        currRow.push(currCell.trim()); rows.push(currRow);
    }
    
    if (rows.length < 2) return [];
    
    // Header cleaning
    const headers = rows[0].map(h => h.toLowerCase().replace(/[:"']/g, "").trim());
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            
            // Specifieke fix voor de JSON kolommen in jouw sheet
            if (val.includes('{') && val.includes('}')) {
                try {
                    // Google Sheets export fix: vervang "" door "
                    const sanitized = val.replace(/""/g, '"');
                    obj[header] = JSON.parse(sanitized);
                } catch (e) { 
                    obj[header] = val; // Fallback naar string als JSON echt stuk is
                }
            } else {
                obj[header] = val;
            }
        });
        return obj;
    }).filter(item => item.hostel_name); // Alleen rijen met een naam doorlaten
}

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("API_KEY_MISSING");

        const sheetRes = await fetch(SHEET_CSV_URL);
        if (!sheetRes.ok) throw new Error("SHEET_FETCH_FAILED");
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        const body = await req.json();
        const { messages, context } = body;

        // Filter op stad (Antigua, Flores etc)
        const userCity = (context.destination || "").toLowerCase().trim();
        const matches = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);

        // Geef de AI de matches, of de hele lijst als er geen directe stads-match is
        const finalPool = matches.length > 0 ? matches : hostelData.slice(0, 15);

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
                        
                        DATABASE: ${JSON.stringify(finalPool)}
                        
                        MATCHING RULES:
                        1. Recommend exactly 3 hostels in JSON format.
                        2. If the user city "${context.destination}" has no matches, explain this and suggest alternatives from the database.
                        3. Use the 'overal_sentiment.semantics' and 'vibe_dna' to justify the match.
                        4. Keep results strictly from the provided DATABASE.`
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
        console.error("DEBUG:", error.message);
        return new Response(JSON.stringify({ 
            message: "Assistant: I encountered an error reading the database. Please try again.",
            recommendations: [] 
        }), { status: 200, headers: corsHeaders });
    }
}
