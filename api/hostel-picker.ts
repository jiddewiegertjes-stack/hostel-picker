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

    // Normalize text
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
            
            // Probeer JSON velden (overal_sentiment, etc) te cleansen
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
        if (!apiKey) throw new Error("API Key (OPENAI_API_KEY) missing in Vercel Environment Variables");
        if (!SHEET_CSV_URL) throw new Error("Spreadsheet URL (SHEET_CSV_URL) missing in Vercel Environment Variables");

        // 1. Fetch CSV
        const sheetRes = await fetch(SHEET_CSV_URL);
        if (!sheetRes.ok) throw new Error(`Google Sheets fetch failed with status: ${sheetRes.status}`);
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        if (hostelData.length === 0) throw new Error("Spreadsheet parsed but returned 0 hostels. Check your headers and data.");

        const body = await req.json();
        const { messages, context } = body;

        // 2. Filter data for the specific city
        const userCity = (context?.destination || "").toLowerCase().trim();
        const cityMatches = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
        
        // Gebruik matches, of de hele lijst als er geen match is
        const finalData = cityMatches.length > 0 ? cityMatches : hostelData.slice(0, 15);

        // 3. OpenAI Call
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
                        STRICT: Only use hostels from this list: ${JSON.stringify(finalData)}.
                        If the user city "${context?.destination}" is not in the list, explain it in the 'message' field and offer alternatives.
                        User Profile context: ${JSON.stringify(context)}.
                        
                        OUTPUT JSON:
                        {
                          "recommendations": [{"name": "..", "location": "..", "reason": "..", "matchPercentage": 0-100, "price": "..", "vibe": "..", "alert": ".."}],
                          "message": "Conversational response"
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
        // ZET ERROR OM IN CHATBERICHT IPV 500 CRASH
        console.error("Backend Error:", error.message);
        return new Response(JSON.stringify({ 
            message: `⚠️ Matchmaker Error: ${error.message}. Please check your Vercel settings and Spreadsheet link.`,
            recommendations: null 
        }), { 
            status: 200, // We sturen 200 zodat de frontend niet crasht maar de tekst toont
            headers: corsHeaders 
        });
    }
}
