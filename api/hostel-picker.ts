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
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        const body = await req.json();
        const { messages, context } = body;

        // Fetch & Select top candidates first (Speed optimization)
        const cacheBuster = SHEET_CSV_URL.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
        const sheetRes = await fetch(SHEET_CSV_URL + cacheBuster);
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        const userCity = (context?.destination || "").toLowerCase().trim();
        const userMaxPrice = Number(context?.maxPrice) || 40;

        let filtered = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
        if (filtered.length === 0) filtered = hostelData.slice(0, 10);

        // Pre-sort to get the best 3 to audit in parallel
        filtered.sort((a, b) => {
            const priceA = parseFloat(String(a.pricing).replace(/[^0-9.]/g, '')) || 0;
            const priceB = parseFloat(String(b.pricing).replace(/[^0-9.]/g, '')) || 0;
            return Math.abs(priceA - userMaxPrice) - Math.abs(priceB - userMaxPrice);
        });
        const top3 = filtered.slice(0, 3);

        // Create the parallel Audit functions
        const auditHostel = async (hostel: any) => {
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: `You are an Expert Auditor. Audit THIS SPECIFIC HOSTEL for the user.
                            
                            SCORING (Weights): Price: 1.0, Sentiment: 1.0, Nomad: 0.9, Vibe: 0.8, Solo: 0.7, Noise: 0.3, Rooms: 0.3, Age: 0.2.
                            
                            Return a JSON object:
                            {
                                "name": "hostel_name",
                                "location": "city",
                                "matchPercentage": 0-100,
                                "price": "pricing",
                                "vibe": "vibe_dna",
                                "hostel_img": "EXACT URL",
                                "alert": "red_flags or 'None'",
                                "audit_log": {
                                    "score_breakdown": "Price: (X% * 1.0) + ... = Total Match%",
                                    "price_logic": "...",
                                    "sentiment_logic": "...",
                                    "noise_logic": "...",
                                    "vibe_logic": "...",
                                    "trade_off_analysis": "Focus on the balance of this specific hostel's features.",
                                    "pulse_summary_proof": "csv.pulse_summary",
                                    "sentiment_proof": "csv.overal_sentiment",
                                    "facility_proof": "csv.facilities",
                                    "nomad_proof": "csv.digital_nomad_score",
                                    "solo_proof": "csv.solo_verdict",
                                    "demographic_logic": "Age match logic"
                                }
                            }
                            
                            DATABASE ENTRY: ${JSON.stringify(hostel)}
                            USER CONTEXT: ${JSON.stringify(context)}`
                        }
                    ],
                    response_format: { type: "json_object" }
                }),
            });
            const data = await res.json();
            return JSON.parse(data.choices[0].message.content);
        };

        // Execution: Audit 3 hostels in parallel (Point 1, 2, 3)
        const recommendations = await Promise.all(top3.map(h => auditHostel(h)));

        // Execution: Prompt 4 - Final Comparison Message (The 'Glue')
        const finalMessageRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: "You are the 'Straight-Talking Traveler'. Look at these 3 audited hostels and write a short, direct comparison/advice message for the user. Do not ask questions already answered in context." 
                    },
                    { role: "user", content: `Audits: ${JSON.stringify(recommendations)}. Context: ${JSON.stringify(context)}` }
                ],
                response_format: { type: "json_object" }
            }),
        });
        const finalMessageData = await finalMessageRes.json();
        const finalMessage = JSON.parse(finalMessageData.choices[0].message.content).message || "Here are the best matches based on your profile.";

        return new Response(JSON.stringify({
            recommendations: recommendations,
            message: finalMessage
        }), {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
