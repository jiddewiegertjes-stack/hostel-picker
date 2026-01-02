export const runtime = "edge";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "No API Key" }), { status: 500, headers: corsHeaders });

    const body = await req.json();
    const { messages } = body;

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
            content: `You are a Hostel Selection Specialist. 
            Your goal is to find the perfect hostel based on the user's vibe (Party, Social, Quiet, Digital Nomad, Luxury).

            ADAPTIVE LOGIC:
            1. Focus on: Location (City), Vibe, Budget, and Must-have facilities (Pool, Kitchen, etc.).
            2. After 3-5 questions, you MUST provide 3 specific hostel recommendations.
            3. If the user is vague, suggest a popular destination like 'Lisbon' or 'Bali' to narrow it down.

            JSON STRUCTURE:
            {
              "recommendations": [
                {
                  "name": "Hostel Name",
                  "location": "City, Country",
                  "reason": "Why it fits the user vibe",
                  "matchPercentage": 95,
                  "priceRange": "€€",
                  "vibe": "Party / Social / etc"
                }
              ] or null,
              "extractedContext": {"city": "...", "vibe": "...", "budget": "...", "facilities": "..."},
              "message": "Next question or advice"
            }`
          },
          ...messages
        ],
        response_format: { type: "json_object" }
      }),
    });

    const data = await response.json();
    const content = data.choices[0].message.content || '{"message": "I lost my map! Can you repeat that?"}';

    // BELANGRIJK: We sturen 'content' direct door zonder extra JSON.stringify
    return new Response(content, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ message: "My booking system is down! Let's try again.", extractedContext: {} }), { 
      status: 200, 
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    });
  }
}
