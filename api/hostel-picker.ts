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
    const lines = csvText.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    // Regex handles commas inside quotes correctly
    const regex = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
    const rawHeaders = lines[0].split(regex).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    
    // Clean up headers like 'pulse_summary:' to 'pulse_summary'
    const headers = rawHeaders.map(h => h.replace(":", ""));

    return lines.slice(1).map(line => {
        const values = line.split(regex);
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = values[i] ? values[i].trim().replace(/^"|"$/g, '') : "";
            obj[header] = val;
        });
        return obj;
    }).filter(h => h.hostel_name); // Only keep rows with a name
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ message: "Error: API Key missing" }), { status: 200, headers: corsHeaders });
    if (!SHEET_CSV_URL) return new Response(JSON.stringify({ message: "Error: Sheet URL missing" }), { status: 200, headers: corsHeaders });

    // 1. FETCH DATA
    const sheetRes = await fetch(SHEET_CSV_URL, { 
        headers: { 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store' 
    });
    
    if (!sheetRes.ok) throw new Error("Could not reach Google Sheets. Check if 'Publish to Web' is active.");
    
    const csvRaw = await sheetRes.text();
    const hostelData = parseCSV(csvRaw);

    if (hostelData.length === 0) throw new Error("Database is empty. Check your CSV export.");

    const body = await req.json();
    const { messages, context } = body;

    // 2. OPENAI CALL
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
            content: `You are a Senior Hostel Auditor. 
            
            STRICT RULES:
            - ONLY recommend hostels from the provided database.
            - User Profile: ${JSON.stringify(context)}
            - Use 'overal_sentiment' for semantic matching.
            
            DATABASE:
            ${JSON.stringify(hostelData)}

            OUTPUT FORMAT (JSON ONLY):
            {
              "recommendations": [
                {
                  "name": "hostel_name",
                  "location": "city",
                  "reason": "Detailed match reason",
                  "matchPercentage": 95,
                  "price": "pricing",
                  "vibe": "vibe_dna",
                  "alert": "red_flags content or None"
                }
              ],
              "message": "Direct message to user"
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
    console.error("LOG:", error.message);
    return new Response(JSON.stringify({ 
        message: "Matchmaker encountered an error: " + error.message,
        recommendations: null 
    }), { 
      status: 200, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}
