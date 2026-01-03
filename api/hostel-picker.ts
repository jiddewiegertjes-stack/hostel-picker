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
 * Robust CSV Parser: Handles quotes, commas, and malformed lines.
 */
function parseCSV(csvText: string) {
    const rows: string[][] = [];
    let currCell = "";
    let currRow: string[] = [];
    let inQuotes = false;

    // Remove any trailing whitespace or newlines at the end of the file
    const cleanText = csvText.trim();

    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i];
        const nextChar = cleanText[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currCell += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            currRow.push(currCell.trim());
            currCell = "";
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (currCell !== "" || currRow.length > 0) {
                currRow.push(currCell.trim());
                rows.push(currRow);
                currRow = [];
                currCell = "";
            }
            if (char === '\r' && nextChar === '\n') i++;
        } else {
            currCell += char;
        }
    }
    if (currCell !== "" || currRow.length > 0) {
        currRow.push(currCell.trim());
        rows.push(currRow);
    }

    if (rows.length < 2) return [];

    const headers = rows[0].map(h => h.replace(":", "").trim().toLowerCase());
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            // Remove surrounding quotes if present
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            obj[header] = val;
        });
        return obj;
    });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    if (!SHEET_CSV_URL) throw new Error("Missing SHEET_CSV_URL environment variable");

    // 1. Fetch CSV
    const sheetRes = await fetch(SHEET_CSV_URL);
    if (!sheetRes.ok) throw new Error("Failed to fetch spreadsheet. Is it public?");
    
    const csvRaw = await sheetRes.text();
    const hostelData = parseCSV(csvRaw);

    if (hostelData.length === 0) {
        throw new Error("No data found in spreadsheet or parsing failed.");
    }

    // 2. Parse User Input
    const body = await req.json();
    const { messages, context } = body;

    // 3. Request OpenAI
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
            content: `You are a Senior Hostel Matchmaker for Guatemala.
            
            RULES:
            1. ONLY recommend hostels from the provided DATABASE.
            2. If no hostels match the destination, say: "I couldn't find any hostels in that specific location in my database yet."
            3. Use 'overal_sentiment' semantics to match chat requests.
            4. Respond in English.

            USER PROFILE: ${JSON.stringify(context)}
            DATABASE: ${JSON.stringify(hostelData.slice(0, 30))}

            OUTPUT FORMAT:
            {
              "recommendations": [
                {
                  "name": "hostel_name",
                  "location": "city",
                  "reason": "Specific reason why it matches the user's chat message and profile",
                  "matchPercentage": 0-100,
                  "price": "pricing",
                  "vibe": "vibe_dna",
                  "alert": "red_flags or 'None'"
                }
              ],
              "message": "Conversational message to user"
            }`
          },
          ...messages
        ],
        response_format: { type: "json_object" }
      }),
    });

    const data = await response.json();
    
    if (data.error) throw new Error(data.error.message);

    return new Response(data.choices[0].message.content, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Backend Error:", error.message);
    return new Response(JSON.stringify({ 
        message: "Matchmaker is having a siesta! Error: " + error.message,
        recommendations: null 
    }), { 
      status: 200, // Status 200 so the frontend can display the error message nicely
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}
