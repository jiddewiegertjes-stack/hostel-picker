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
 * Robust CSV Parser that handles quotes and commas inside fields
 */
function parseCSV(csvText: string) {
  const lines = csvText.split(/\r?\n/);
  if (lines.length === 0) return [];
  
  // Clean headers (remove colons and trim)
  const headers = lines[0].split(",").map(h => h.trim().replace(":", ""));
  const result = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = [];
    let current = "";
    let inQuotes = false;

    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const obj: any = {};
    headers.forEach((header, index) => {
      let val = values[index] || "";
      // Strip leading/trailing quotes from the value
      if (val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      obj[header] = val;
    });
    result.push(obj);
  }
  return result;
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "No API Key" }), { status: 500, headers: corsHeaders });

    const sheetRes = await fetch(SHEET_CSV_URL);
    const csvText = await sheetRes.text();
    
    // De nieuwe robuuste parser
    const hostelData = parseCSV(csvText);

    const body = await req.json();
    const { messages, context } = body;

    const systemPrompt = `
      ROLE:
      You are a "Closed-World Hostel Matchmaker". You ONLY have access to the hostels listed in the DATABASE provided below. 

      STRICT LIMITATION:
      - NEVER recommend a hostel that is not in the DATABASE.
      - If a user asks for a city or hostel not in the DATABASE, politely say you don't have data for that yet.
      - Ignore all your internal knowledge about hostels in Guatemala. Only use the provided rows.

      USER TRAVEL PROFILE:
      ${JSON.stringify(context)}

      DATABASE:
      ${JSON.stringify(hostelData)} 

      MATCHING LOGIC:
      1. Use the 'context' as hard filters. 
      2. Match chat requests against 'overal_sentiment' (semantics) and 'pulse_summary'.
      3. For the 'reason' field: explain the match using specific details from the database.

      OUTPUT JSON FORMAT:
      {
        "recommendations": [
          {
            "name": "Exact hostel_name from database",
            "location": "Exact city from database",
            "reason": "Why it matches",
            "matchPercentage": 0-100,
            "price": "pricing field",
            "vibe": "vibe_dna field",
            "alert": "red_flags field (summarized or 'None')"
          }
        ],
        "message": "Your conversational response in English."
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
        messages: [
          { role: "system", content: systemPrompt },
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
