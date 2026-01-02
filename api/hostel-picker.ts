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
            content: `You are a specialist Backpacking Advisor. 
            
            ADAPTIVE LOGIC:
            1. If a user's answer is vague (e.g., "big budget", "a long time"), map it to the closest logical value (e.g., "big" -> "high", "long time" -> "30+ days").
            2. If you absolutely cannot determine a field, set it to "unknown" in 'extractedContext'.
            3. NEVER stay silent. If you are confused, ask for clarification in the 'message' field.
            4. After 5 questions, even with "unknown" fields, you MUST provide 3 country recommendations.
            
            JSON STRUCTURE:
            {
              "recommendations": [{"country": "...", "reason": "...", "matchPercentage": 95, "bestMonths": ["..."], "estimatedDailyBudget": "..."}] or null,
              "extractedContext": {"continent": "...", "duration": "...", "budget": "...", "activities": "...", "period": "..."},
              "message": "Next question or advice"
            }`
          },
          ...messages
        ],
        response_format: { type: "json_object" }
      }),
    });

    const data = await response.json();
    // Veiligheid: als OpenAI een lege string of foute JSON stuurt
    const content = data.choices[0].message.content || '{"message": "I didn\'t quite get that. Could you rephrase?"}';

    return new Response(JSON.stringify(content), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    // Voorkom eeuwige 'thinking' door altijd een JSON error te sturen
// Haal JSON.stringify weg bij 'content'
return new Response(content, {
  status: 200,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
    });
  }
}
