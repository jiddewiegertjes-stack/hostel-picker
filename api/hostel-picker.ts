export const runtime = "edge";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

// URL naar jouw specifieke Google Sheet (geëxporteerd als CSV)
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1FLxKMkFBcsmN1gOSmhJdehWuYSHTnfvqDoltgybZGLI/export?format=csv&gid=265151411";

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// Hulpmfunctie om CSV tekst simpel om te zetten naar een object
function parseCSV(csvText: string) {
  const lines = csvText.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return headers.reduce((obj: any, header, i) => {
      obj[header.trim()] = values[i]?.trim();
      return obj;
    }, {});
  });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "No API Key" }), { status: 500, headers: corsHeaders });

    // 1. Haal de LIVE data op uit Google Sheets
    const sheetRes = await fetch(SHEET_CSV_URL);
    const csvText = await sheetRes.text();
    const hostelData = parseCSV(csvText);

    const body = await req.json();
    const { messages } = body;

    // 2. Roep OpenAI aan met de data uit de spreadsheet
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
            Use the following LIVE DATABASE from Guatemala to help the user.

            DATABASE:
            ${JSON.stringify(hostelData.slice(0, 15))} 

            LOGIC:
            1. Chat to find City, Vibe, and Budget.
            2. Match using 'vibe_dna', 'overal_sentiment' score, and 'pricing'.
            3. Provide 3 recommendations once ready.
            4. ALWAYS mention 'red_flags' if they are not 'None'.

            JSON STRUCTURE:
            {
              "recommendations": [
                {
                  "name": "hostel_name",
                  "location": "city",
                  "reason": "Why it fits based on 'overal_sentiment' semantics",
                  "matchPercentage": 0-100,
                  "price": "pricing",
                  "vibe": "vibe_dna",
                  "alert": "red_flags"
                }
              ] or null,
              "extractedContext": {"city": "...", "vibe": "...", "budget": "..."},
              "message": "Next question or advice"
            }`
          },
          ...messages
        ],
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
    return new Response(JSON.stringify({ message: "Systeemfout: " + error.message }), { 
      status: 500, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}
