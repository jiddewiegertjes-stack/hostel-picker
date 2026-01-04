export async function POST(req: Request) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;

        // OPTIMALISATIE 1: Caching
        // We verwijderen de cacheBuster (?t=...) en gebruiken Next.js revalidation
        // Dit zorgt ervoor dat hij niet voor elk request naar Google Sheets hoeft.
        const sheetRes = await fetch(SHEET_CSV_URL, {
            next: { revalidate: 3600 } // Cache data voor 1 uur (3600s)
        });
        
        const csvRaw = await sheetRes.text();
        const hostelData = parseCSV(csvRaw);
        const body = await req.json();
        const { messages, context } = body;

        const userCity = (context?.destination || "").toLowerCase().trim();
        const finalData = hostelData.filter(h => {
            const cityInSheet = (h.city || "").toLowerCase().trim();
            return cityInSheet === userCity;
        });
        
        // OPTIMALISATIE 2: Beperk de pool tot 15 (25 is te zwaar voor snelle response)
        const fullPool = finalData.length > 0 ? finalData : hostelData.slice(0, 15);
        const limitedPool = fullPool.slice(0, 15);

        // OPTIMALISATIE 3: "Lean" Payload voor AI
        // De AI heeft de image URL niet nodig om te oordelen. Dit scheelt enorm veel input tokens.
        const aiPayload = limitedPool.map(({ hostel_img, ...rest }) => rest);

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        // Let op: Instructie over images is aangepast, de code doet dit nu.
                        content: `You are the Expert Hostel Matchmaker. Calculate match percentages using a weighted scoring algorithm.

Return EXACTLY 3 recommendations from the provided database that best fit the user context."

                        SCORING INDICES (Weights):
                        Assign points using these specific multipliers:
                        - Pricing: 1.0 (Target Proximity)
                        - Overall Sentiment: 1.0 (Critical - based on csv.overal_sentiment.score)
                        - Digital Nomad suitability: 0.9 (Very High)
                        - Vibe Tags: 0.8 (High)
                        - Solo Traveler suitability: 0.7 (High)
                        - Noise Level: 0.3 (Low)
                        - Rooms Info (Size/Type): 0.3 (Low)
                        - Overall Age Match: 0.2 (Very Low)

                        Tone of voice: You are the 'Straight-Talking Traveler'—giving honest, practical hostel advice based on hard data. Your tone is helpful, direct, and non-corporate.

                        SPECIAL PRICING LOGIC (Estimated Price):
                        Treat context.maxPrice (€${context.maxPrice}) as an ESTIMATED IDEAL PRICE, not a hard maximum limit. 
                        Do not filter hostels out for being over this price.
                        - Pricing Score (Weight 1.0): Use bell-curve proximity logic. 
                        - 100% Score: Actual price is within +/- 10% of €${context.maxPrice}.
                        - Proximity: A hostel costing €42 is a BETTER match for a €40 estimate than a hostel costing €15 (potential quality mismatch) or €65 (too expensive).
                        - Penalty: Deduct points gradually as the price moves further away (higher OR lower) from the estimate.

                        NEW PROTOCOL: INSUFFICIENT INPUT & SMART AUDIT
                        1. PROFILE DATA IS FINAL: Data in 'USER CONTEXT' is already provided.
                        2. DO NOT ASK for info already in USER CONTEXT.
                        3. TRIGGER CRITERIA: Only return an empty [] recommendations array if the chat message is a simple greeting.
                        4. SMART START: If the user says "show me the best spots", IMMEDIATELY perform the audit.

                        STRICT RULES:
                        - RED FLAGS: List them strictly in the 'alert' field.
                        - DATABASE PROOF: You must provide RAW DATA from the spreadsheet for facilities, nomad, solo, pulse, and sentiment proofs.
                        - TRADE-OFF ANALYSIS: In the audit_log, contrast the Digital Nomad quality with the Solo Traveler social vibe.
                        - MATHEMATICAL AUDIT: In 'score_breakdown', you MUST show the step-by-step calculation including ALL categories.

                        DATABASE: ${JSON.stringify(aiPayload)}
                        USER CONTEXT: ${JSON.stringify(context)}

                        OUTPUT JSON STRUCTURE:
                        {
                          "recommendations": [
                            {
                              "name": "hostel_name (MUST MATCH DATABASE NAME EXACTLY)",
                              "location": "city",
                              "matchPercentage": 0-100,
                              "price": "pricing",
                              "vibe": "vibe_dna",
                              "alert": "red_flags or 'None'",
                              "reason": "Why is this a match?",
                              "audit_log": {
                                "score_breakdown": "Price: (X% * 1.0) + ... = Total Match%",
                                "price_logic": "...",
                                "sentiment_logic": "...",
                                "noise_logic": "...",
                                "vibe_logic": "...",
                                "trade_off_analysis": "...",
                                "pulse_summary_proof": "RAW DATA FROM csv.pulse_summary",
                                "sentiment_proof": "RAW DATA FROM csv.overal_sentiment JSON",
                                "facility_proof": "RAW DATA FROM csv.facilities COLUMN",
                                "nomad_proof": "Weight 0.9: data from csv.digital_nomad_score",
                                "solo_proof": "Weight 0.7: data from csv.solo_verdict",
                                "demographic_logic": "..."
                              }
                            }
                          ],
                          "message": "Strategic advice or clarifying questions."
                        }`
                    },
                    ...messages
                ],
                response_format: { type: "json_object" }
            }),
        });

        const aiData = await response.json();
        const parsedContent = JSON.parse(aiData.choices[0].message.content);
        
        // OPTIMALISATIE 4: Re-hydration / Merging
        // We plakken de images (die we niet naar de AI stuurden) weer terug aan de output.
        if (parsedContent.recommendations) {
            parsedContent.recommendations = parsedContent.recommendations.map((rec: any) => {
                // Zoek het originele hostel object (met image url) in de fullPool
                const original = limitedPool.find(h => h.hostel_name === rec.name);
                return {
                    ...rec,
                    // Voeg image toe als we hem vinden, anders fallback
                    hostel_img: original?.hostel_img || "" 
                };
            });
        }

        return new Response(JSON.stringify(parsedContent), {
            status: 200, headers: corsHeaders 
        });

    } catch (error: any) {
        return new Response(JSON.stringify({ message: "System Error: " + error.message, recommendations: null }), { status: 200, headers: corsHeaders });
    }
}
