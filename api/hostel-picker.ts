export const runtime = "edge";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

// URL uit Vercel Environment Variables
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";

export async function OPTIONS() {
    return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * Super Robust CSV Parser for Google Sheets
 */
function parseCSV(csvText: string) {
    if (!csvText || csvText.length < 10) return [];
    
    const rows: string[][] = [];
    let currCell = "";
    let currRow: string[] = [];
    let inQuotes = false;

    const text = csvText.trim();

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currCell += '"'; i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            currRow.push(currCell.trim()); currCell = "";
        } else if (char === '\n' && !inQuotes) {
            currRow.push(currCell.trim());
            rows.push(currRow);
            currRow = []; currCell = "";
        } else {
            currCell += char;
        }
    }
    if (currRow.length > 0 || currCell) {
        currRow.push(currCell.trim());
        rows.push(currRow);
    }

    if (rows.length < 2) return [];

    // Header cleaning: remove spaces, dots, colons and make lowercase
    const headers = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-h_]/g, "").trim());
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            
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
    }).filter(h => h.hostel_name);
}

export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("API Key (OPENAI_API_KEY) missing");
        if (!SHEET_CSV_URL) throw new Error("Spreadsheet URL (SHEET_CSV_URL) missing");

        // 1. Fetch CSV
        const sheetRes = await fetch(SHEET_CSV_URL);
        if (!sheetRes.ok) throw new Error(`Google Sheets fetch failed: ${sheetRes.status}`);
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        if (hostelData.length === 0) throw new Error("No hostels found in database.");

        const body = await req.json();
        const { messages, context } = body;

        // 2. Filter data (Pre-filter on city for token efficiency)
        const userCity = (context?.destination || "").toLowerCase().trim();
        const cityMatches = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
        
        // Gebruik stad-matches, of top 15 als fallback
        const finalData = cityMatches.length > 0 ? cityMatches : hostelData.slice(0, 15);

        // 3. OpenAI Call with Strict Output Rules
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

                        USER CONTEXT: ${JSON.stringify(context)}
                        DATABASE: ${JSON.stringify(finalData)}
                        
                        STRICT RULES:
                        1. ALWAYS provide exactly 3 recommendations in the 'recommendations' array, even in the first message.
                        2. If the user's max price (€${context?.maxPrice}) is too low, suggest the best affordable alternatives from the list anyway and explain why.
                        3. Map user intent to the 'overal_sentiment.semantics' and 'vibe_dna' columns.
                        4. If the city "${context?.destination}" is not in the database, suggest hostels from other nearby cities.

                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "Exact name from database",
                              "location": "City",
                              "reason": "Why this matches their profile/chat",
                              "matchPercentage": 0-100,
                              "price": "pricing field",
                              "vibe": "vibe_dna field",
                              "alert": "red_flags or 'None'"
                            }
                          ],
                          "message": "Friendly conversational response in English"
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        if (aiData.error) throw new Error(`OpenAI Error: ${aiData.error.message}`);

        return new Response(aiData.choices[0].message.content, {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("Backend Error:", error.message);
        return new Response(JSON.stringify({ 
            message: `⚠️ Matchmaker Error: ${error.message}`,
            recommendations: null 
        }), { 
            status: 200,
            headers: corsHeaders 
        });
    }
}
