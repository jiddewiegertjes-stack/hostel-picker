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
  const lines = csvText.split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return headers.reduce((obj: any, header, i) => {
      obj[header] = values[i]?.trim();
      return obj;
    }, {});
  });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "No API Key" }), { status: 500, headers: corsHeaders });

    const sheetRes = await fetch(SHEET_CSV_URL);
    const csvText = await sheetRes.text();
    const hostelData = parseCSV(csvText);

    const body = await req.json();
    const { messages, context } = body;

    const systemPrompt = `
      ROLE:
      You are the "Senior Hostel Auditor & Semantic Matchmaker". Your goal is to find the 3 best hostels from the provided database by mapping user desires to specific data columns.

      USER TRAVEL PROFILE (HARD CONSTRAINTS):
      ${JSON.stringify(context)}

      DATABASE (SOURCE OF TRUTH):
      ${JSON.stringify(hostelData.slice(0, 25))} 

      MATCHING ENGINE LOGIC (INTERNAL REASONING):
      1. TRANSLATION LAYER: Map natural language to database tags.
         - If user wants "fun/meeting people" -> Map to vibe_dna: [Social-High, Party-Extreme].
         - If user wants "work/focus" -> Map to vibe_dna: [Digital-Nomad-Hub, Quiet-Nights].
         - If user wants "local feel" -> Map to vibe_dna: [Community-Focused].

      2. SEMANTIC MAPPING (THE "SEMANTICS" PRIORITY):
         - Critically analyze the 'overal_sentiment' semantics field for every hostel.
         - Match the user's "soft wishes" from the chat against the emotional soul described in 'semantics'.
         - If chat says "I want a quiet morning" and semantics says "noisy restaurant vibe", this is a DISMATCH, even if the price is perfect.

      3. WEIGHTED RANKING FLOW:
         - Priority 1 (40%): User Profile (Destination, MaxPrice, Solo/Nomad mode, Noise Importance).
         - Priority 2 (40%): Semantic Match (Chat intent vs. 'overal_sentiment' semantics & 'social_mechanism').
         - Priority 3 (20%): Safety & Vibe (vibe_dna & red_flags). 

      4. NATIONALITY AUDIT:
         - If context.nationalityPref is set, scan the 'country_info' column. Rank hostels HIGHER if that nationality is in the Top 3.

      OUTPUT JSON FORMAT:
      {
        "recommendations": [
          {
            "name": "Exact hostel_name",
            "location": "Exact city",
            "reason": "Start with 'Based on your profile and request...'. Explicitly mention why the 'semantics' or 'social_mechanism' of this hostel is a match for their specific chat message.",
            "matchPercentage": 0-100,
            "price": "Exact pricing",
            "vibe": "Exact vibe_dna",
            "alert": "If red_flags is not 'None', summarize the warning here. Otherwise 'None'."
          }
        ],
        "message": "A professional response in English explaining your top pick and asking if they want to know more."
      }

      STRICT RULE: Only recommend hostels from the DATABASE. If 'red_flags' mention theft or bedbugs, mention this as an 'alert' in the JSON.
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
