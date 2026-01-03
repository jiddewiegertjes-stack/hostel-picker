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
 * Advanced CSV Parser: Handles quotes, newlines within cells, and nested commas.
 */
function parseCSV(csvText: string) {
    const rows = [];
    let currCell = "";
    let currRow = [];
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        const nextChar = csvText[i + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currCell += '"';
            i++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            currRow.push(currCell.trim());
            currCell = "";
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
            if (currCell || currRow.length > 0) {
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
    if (currCell || currRow.length > 0) {
        currRow.push(currCell.trim());
        rows.push(currRow);
    }

    const headers = rows[0].map(h => h.replace(":", "").trim());
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            // Probeer JSON strings (zoals overal_sentiment) direct te parsen voor de AI
            if (val.startsWith('{') && val.endsWith('}')) {
                try { val = JSON.parse(val); } catch (e) { /* blijf bij string als parse faalt */ }
            }
            obj[header] = val;
        });
        return obj;
    });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "No API Key" }), { status: 500, headers: corsHeaders });

    const sheetRes = await fetch(SHEET_CSV_URL);
    const csvRaw = await sheetRes.text();
    const hostelData = parseCSV(csvRaw);

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
            1. ONLY recommend hostels from the provided DATABASE below. 
            2. If a hostel is NOT in the database, it does not exist for you.
            3. Use the 'context' (User Profile) as hard filters.
            4. Analyze the 'overal_sentiment.semantics' field to match the user's chat wishes.
            
            DATABASE:
            ${JSON.stringify(hostelData)}

            OUTPUT JSON:
            {
              "recommendations": [
                {
                  "name": "Exact hostel_name",
                  "location": "Exact city",
                  "reason": "Explain match using semantics/pulse_summary",
                  "matchPercentage": 0-100,
                  "price": "pricing",
                  "vibe": "vibe_dna",
                  "alert": "red_flags or 'None'"
                }
              ],
              "message": "Friendly response in English"
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
      status: 500, headers: corsHeaders 
    });
  }
}
