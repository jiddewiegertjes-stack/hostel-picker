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
    if (!csvText || csvText.length < 10) return [];
    
    const cleanText = csvText.trim().replace(/^\uFEFF/, "");
    
    const rows: string[][] = [];
    let currCell = ""; let currRow: string[] = []; let inQuotes = false;
    for (let i = 0; i < cleanText.length; i++) {
        const char = cleanText[i]; const nextChar = cleanText[i + 1];
        if (char === '"' && inQuotes && nextChar === '"') { currCell += '"'; i++; }
        else if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { currRow.push(currCell.trim()); currCell = ""; }
        else if (char === '\n' && !inQuotes) { currRow.push(currCell.trim()); rows.push(currRow); currRow = []; currCell = ""; }
        else { currCell += char; }
    }
    if (currRow.length > 0 || currCell) { currRow.push(currCell.trim()); rows.push(currRow); }

    const headers = rows[0].map(h => h.toLowerCase().trim().replace(/[^a-z0-9_]/g, ""));
    
    return rows.slice(1).map(row => {
        const obj: any = {};
        headers.forEach((header, i) => {
            let val = row[i] || "";
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
            if (val.includes('{') && val.includes('}')) {
                try { const sanitized = val.replace(/""/g, '"'); obj[header] = JSON.parse(sanitized); }
                catch (e) { obj[header] = val; }
            } else { obj[header] = val; }
        });
        return obj;
    }).filter(h => h.hostel_name && h.hostel_name.length > 1);
}

export async function POST(req: Request) {
    const t0 = Date.now();
    let tSheetStart = 0, tSheetEnd = 0;
    let tParseStart = 0, tParseEnd = 0;
    let tReqJsonStart = 0, tReqJsonEnd = 0;
    let tFilterStart = 0, tFilterEnd = 0;
    let tOpenAIStart = 0, tOpenAIEnd = 0;

    try {
        const apiKey = process.env.OPENAI_API_KEY;

        tSheetStart = Date.now();
        const cacheBuster = SHEET_CSV_URL.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
        const sheetRes = await fetch(SHEET_CSV_URL + cacheBuster);
        
        const csvRaw = await sheetRes.text();
        tSheetEnd = Date.now();

        tParseStart = Date.now();
        const hostelData = parseCSV(csvRaw);
        tParseEnd = Date.now();

        tReqJsonStart = Date.now();
        const body = await req.json();
        tReqJsonEnd = Date.now();

        const { messages, context } = body;

        tFilterStart = Date.now();
        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        const pool = finalData.length > 0 ? finalData : hostelData.slice(0, 25);
        tFilterEnd = Date.now();

        const poolJsonChars = JSON.stringify(pool).length;

        tOpenAIStart = Date.now();
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker.

TASK
- Return EXACTLY 3 recommendations from DATABASE that best fit USER CONTEXT.
- Output MUST be valid JSON matching the exact schema below. Write JSON only.

SCORING (weighted)
Price*1.0, Sentiment*1.0 (overal_sentiment.score), Nomad*0.9, Vibe*0.8, Solo*0.7, Noise*0.3, Rooms*0.3, Age*0.2.
Pricing: treat context.maxPrice (€${context.maxPrice}) as an estimated ideal; use bell-curve proximity (±10% => ~100, farther => gradual penalty, higher OR lower).

RULES
- Do NOT ask for info already in USER CONTEXT.
- Return empty recommendations [] ONLY if user message is a simple greeting/vague.
- RED FLAGS: do NOT reduce matchPercentage; list them only in alert.
- Proofs must be exact snippets from the CSV fields, but keep them SHORT (no dumps).
  - Each *_proof field: max 350 chars, truncate with "…".
  - Each *_logic field: max 220 chars.
  - trade_off_analysis: max 260 chars.
  - message: max 260 chars.
- score_breakdown MUST include ALL 8 categories with labels in ONE LINE.

DATA
DATABASE: ${JSON.stringify(pool)}
USER CONTEXT: ${JSON.stringify(context)}

AUDIT REQUIREMENTS (use CSV columns)
- Price: user.maxPrice vs pricing
- Sentiment: overal_sentiment.score
- Noise: user.noiseLevel vs noise_level
- Vibe: user.vibe vs vibe_dna
- Social: chat vs social_mechanism & pulse_summary & facilities
- Proof fields MUST contain exact snippets from:
  facilities, digital_nomad_score, solo_verdict, pulse_summary, overal_sentiment
- hostel_img must be EXACT URL from hostel_img

OUTPUT JSON STRUCTURE (exact)
{
  "recommendations": [
    {
      "name": "hostel_name",
      "location": "city",
      "matchPercentage": 0-100,
      "price": "pricing",
      "vibe": "vibe_dna",
      "hostel_img": "EXACT URL FROM hostel_img",
      "alert": "red_flags or 'None'",
      "audit_log": {
        "score_breakdown": "Price: (X% * 1.0) + Sentiment: (Y% * 1.0) + Nomad: (Z% * 0.9) + Vibe: (A% * 0.8) + Solo: (B% * 0.7) + Noise: (C% * 0.3) + Rooms: (D% * 0.3) + Age: (E% * 0.2) = Total Match%",
        "price_logic": "...",
        "sentiment_logic": "...",
        "noise_logic": "...",
        "vibe_logic": "...",
        "trade_off_analysis": "...",
        "pulse_summary_proof": "...",
        "sentiment_proof": "...",
        "facility_proof": "...",
        "nomad_proof": "...",
        "solo_proof": "...",
        "demographic_logic": "..."
      }
    }
  ],
  "message": "..."
}`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });
        tOpenAIEnd = Date.now();

        const aiData = await response.json();
        const content = aiData.choices[0].message.content;

        console.log(JSON.stringify({
            ms_total: Date.now() - t0,
            ms_sheet_fetch_and_text: tSheetEnd - tSheetStart,
            ms_csv_parse: tParseEnd - tParseStart,
            ms_req_json: tReqJsonEnd - tReqJsonStart,
            ms_filter_and_pool: tFilterEnd - tFilterStart,
            ms_openai_fetch_and_json: tOpenAIEnd - tOpenAIStart,
            pool_count: pool.length,
            pool_json_chars: poolJsonChars
        }));
        
        return new Response(content, {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        console.log(JSON.stringify({
            ms_total: Date.now() - t0,
            ms_sheet_fetch_and_text: tSheetEnd && tSheetStart ? (tSheetEnd - tSheetStart) : null,
            ms_csv_parse: tParseEnd && tParseStart ? (tParseEnd - tParseStart) : null,
            ms_req_json: tReqJsonEnd && tReqJsonStart ? (tReqJsonEnd - tReqJsonStart) : null,
            ms_filter_and_pool: tFilterEnd && tFilterStart ? (tFilterEnd - tFilterStart) : null,
            ms_openai_fetch_and_json: tOpenAIEnd && tOpenAIStart ? (tOpenAIEnd - tOpenAIStart) : null
        }));
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
