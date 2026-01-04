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

        const cacheBuster = SHEET_CSV_URL.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
        const sheetRes = await fetch(SHEET_CSV_URL + cacheBuster);
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);

        const userCity = (context?.destination || "").toLowerCase().trim();
        const userMaxPrice = Number(context?.maxPrice) || 40;

        let filtered = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
        if (filtered.length === 0) filtered = hostelData.slice(0, 10);

        filtered.sort((a, b) => {
            const priceA = parseFloat(String(a.pricing).replace(/[^0-9.]/g, '')) || 0;
            const priceB = parseFloat(String(b.pricing).replace(/[^0-9.]/g, '')) || 0;
            return Math.abs(priceA - userMaxPrice) - Math.abs(priceB - userMaxPrice);
        });
        const top3 = filtered.slice(0, 3);

        // Veilig parsen van AI antwoorden om 'undefined' errors te voorkomen
        const safeParseJSON = (data: any) => {
            try {
                if (!data?.choices?.[0]?.message?.content) return null;
                const content = data.choices[0].message.content;
                return JSON.parse(content.replace(/```json/g, "").replace(/```/g, "").trim());
            } catch (e) {
                return null;
            }
        };

        const auditHostel = async (hostel: any) => {
            const res = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        { 
                            role: "system", 
                            content: `You are an Expert Auditor. Audit THIS SPECIFIC HOSTEL. Return ONLY valid JSON.
                            Weights: Price: 1.0, Sentiment: 1.0, Nomad: 0.9, Vibe: 0.8, Solo: 0.7, Noise: 0.3, Rooms: 0.3, Age: 0.2.
                            DATABASE ENTRY: ${JSON.stringify(hostel)}
                            USER CONTEXT: ${JSON.stringify(context)}`
                        }
                    ],
                    response_format: { type: "json_object" }
                }),
            });
            const data = await res.json();
            return safeParseJSON(data);
        };

        // Parallelle uitvoering met filter om mislukte audits te verwijderen
        const results = await Promise.all(top3.map(h => auditHostel(h)));
        const recommendations = results.filter(r => r !== null);

        if (recommendations.length === 0) {
            throw new Error("No valid audits could be generated.");
        }

        const finalMessageRes = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: "You are the 'Straight-Talking Traveler'. Compare these audits and return a JSON with a 'message' field." 
                    },
                    { role: "user", content: `Audits: ${JSON.stringify(recommendations)}. Context: ${JSON.stringify(context)}` }
                ],
                response_format: { type: "json_object" }
            }),
        });
        
        const finalData = await finalMessageRes.json();
        const finalParsed = safeParseJSON(finalData);
        const finalMessage = finalParsed?.message || "Here are the best matches based on your profile.";

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
