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

/**
 * Clean and Robust CSV to JSON Parser
 */
function parseCSV(csvText: string) {
    const rows: string[][] = [];
    let currentCell = "";
    let currentRow: string[] = [];
    let inQuotes = false;

    // Normalize line endings
    const text = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currentCell += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
            currentRow.push(currentCell.trim());
            currentCell = "";
        } else if (char === "\n" && !inQuotes) {
            currentRow.push(currentCell.trim());
            rows.push(currentRow);
            currentRow = [];
            currentCell = "";
        } else {
            currentCell += char;
        }
    }
    if (currentRow.length > 0 || currentCell) {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
    }

    if (rows.length < 2) return [];

    const headers = rows[0].map(h => h.replace(/[:"']/g, "").trim());
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            // Clean up surrounding quotes
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            
            // Auto-parse JSON strings (vibe_dna, overal_sentiment etc)
            if (val.includes("{") && val.includes("}")) {
                try {
                    // Replace double-double quotes which sometimes happen in CSV exports
                    const sanitizedJson = val.replace(/""/g, '"');
                    obj[header] = JSON.parse(sanitizedJson);
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
        if (!apiKey) throw new Error("Missing OpenAI API Key");

        const sheetRes = await fetch(SHEET_CSV_URL);
        if (!sheetRes.ok) throw new Error("Failed to fetch Google Sheet");
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        const body = await req.json();
        const { messages, context } = body;

        const systemPrompt = `
      ROLE: Senior Hostel Matchmaker.
      DATABASE (ONLY USE THIS): ${JSON.stringify(hostelData)}
      
      RULES:
      1. ONLY recommend hostels from the database. 
      2. If no match is found for a specific city, inform the user.
      3. Use 'context' as primary filters: ${JSON.stringify(context)}.
      4. Match chat requests to 'overal_sentiment.semantics'.
      
      OUTPUT FORMAT:
      {
        "recommendations": [
          {
            "name": "hostel_name",
            "location": "city",
            "reason": "Detailed match reason",
            "matchPercentage": 0-100,
            "price": "pricing",
            "vibe": "vibe_dna",
            "alert": "red_flags or 'None'"
          }
        ],
        "message": "Direct response to user"
      }
    `;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, ...messages],
                response_format: { type: "json_object" }
            }),
        });

        const data = await response.json();
        const content = data.choices[0].message.content;

        return new Response(content, {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("Backend Error:", error.message);
        return new Response(JSON.stringify({ 
            message: "System Error: " + error.message,
            recommendations: null 
        }), { 
            status: 500, 
            headers: corsHeaders 
        });
    }
}
