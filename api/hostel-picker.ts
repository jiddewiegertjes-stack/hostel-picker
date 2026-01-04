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
        console.time("⏱️ TOTAL_DURATION");
        const apiKey = process.env.OPENAI_API_KEY;

        const sheetRes = await fetch(SHEET_CSV_URL, { next: { revalidate: 300 } }); 
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        
        const body = await req.json();
        const { messages, context } = body;

        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => (h.city || "").toLowerCase().trim() === userCity);
        const limitedPool = (finalData.length > 0 ? finalData : hostelData).slice(0, 15);

        // We sturen een 'lean' payload naar de AI (zonder de zware tekst-kolommen)
        const aiPayload = limitedPool.map(({ hostel_img, facilities, pulse_summary, overal_sentiment, digital_nomad_score, solo_verdict, ...rest }) => rest);

        console.time("⏱️ OPENAI_LATENCY");
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are the Expert Hostel Matchmaker. 
                        Task: Select the 3 best hostels and calculate match percentages.
                        
                        CRITICAL: Return ONLY the required fields. Do NOT generate the audit_log proofs or descriptions. 
                        I will populate those from the database myself.
                        
                        Weights: Price(1.0), Sentiment(1.0), Nomad(0.9), Vibe(0.8), Solo(0.7).
                        
                        DATABASE: ${JSON.stringify(aiPayload)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name",
                              "matchPercentage": 0-100,
                              "reason": "1 short sentence why it fits",
                              "score_breakdown": "Price: X% + Vibe: Y%...",
                              "price_logic": "Brief logic",
                              "noise_logic": "Brief logic",
                              "vibe_logic": "Brief logic",
                              "demographic_logic": "Brief logic",
                              "trade_off_analysis": "Brief contrast"
                            }
                          ],
                          "message": "Strategic advice."
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        console.timeEnd("⏱️ OPENAI_LATENCY");

        const rawContent = aiData.choices[0].message.content;
        let parsedContent = JSON.parse(rawContent.replace(/```json/g, "").replace(/```/g, "").trim());
        
        // --- HYDRATION STAP ---
        // We plakken de rauwe CSV data hier pas vast aan de 3 geselecteerde hostels
        if (parsedContent.recommendations) {
            parsedContent.recommendations = parsedContent.recommendations.map((rec: any) => {
                const original = limitedPool.find(h => h.hostel_name.toLowerCase() === rec.name.toLowerCase());
                if (!original) return rec;

                return {
                    ...rec,
                    location: original.city,
                    price: original.pricing,
                    vibe: original.vibe_dna,
                    hostel_img: original.hostel_img || "",
                    alert: original.red_flags || "None",
                    audit_log: {
                        score_breakdown: rec.score_breakdown,
                        price_logic: rec.price_logic,
                        noise_logic: rec.noise_logic,
                        vibe_logic: rec.vibe_logic,
                        demographic_logic: rec.demographic_logic,
                        trade_off_analysis: rec.trade_off_analysis,
                        // Deze velden komen DIRECT uit de CSV, de AI hoeft ze niet te typen!
                        pulse_summary_proof: original.pulse_summary,
                        sentiment_proof: JSON.stringify(original.overal_sentiment),
                        facility_proof: original.facilities,
                        nomad_proof: original.digital_nomad_score,
                        solo_proof: original.solo_verdict
                    }
                };
            });
        }

        console.timeEnd("⏱️ TOTAL_DURATION");
        return new Response(JSON.stringify(parsedContent), { status: 200, headers: corsHeaders });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "Error: " + error.message }), { status: 200, headers: corsHeaders });
    }
}
