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
            
            USER TRAVEL PROFILE (Mandatory Constraints):
            ${JSON.stringify(context)}

            DATABASE:
            ${JSON.stringify(hostelData.slice(0, 20))} 

            LOGIC:
            1. The User Profile is already set. DO NOT ask for City, Budget, or Vibe again.
            2. Use the Chat to refine specific details (e.g., "near the beach", "good kitchen").
            3. Match based on the Profile AND Chat. 
            4. If Nationality preference is set, check 'country_info' in database to see if that nationality visits often.
            5. Provide 3 recommendations in JSON format.
            6. Mention 'red_flags' if they exist.

            JSON STRUCTURE:
            {
              "recommendations": [{"name": "..", "location": "..", "reason": "..", "matchPercentage": 0-100, "price": "..", "vibe": "..", "alert": ".."}],
              "message": "Response to the user"
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
