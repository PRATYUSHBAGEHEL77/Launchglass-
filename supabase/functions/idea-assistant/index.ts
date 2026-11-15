import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const prompts: Record<string, string> = {
  idea_analysis: 'Assess the product idea. Return: concise summary, target users, problem solved, differentiators, assumptions to validate, risks, and practical next steps. Clearly label uncertainty; do not invent market statistics.',
  business_plan: 'Create an early-stage business plan with: problem, proposed solution, customer segments, value proposition, business model hypotheses, go-to-market experiments, operations, key risks, and 30-day validation plan. Label estimates and assumptions.',
  campaign_copy: 'Rewrite the supplied product information into a clear, compelling reward-based crowdfunding campaign story. Include problem, solution, features, intended reward, use of funds, realistic timeline assumptions, and risks. Do not promise guaranteed delivery or invent certifications.',
  marketing_plan: 'Create a practical 30-day launch marketing plan with audience hypotheses, positioning, channels, content ideas, weekly actions, low-cost experiments, and measurable metrics. Do not fabricate audience data.',
  pricing_plan: 'Create a pricing worksheet framework. Separate known inputs from assumptions, list cost categories, suggest ways to validate willingness to pay, and show formulas rather than inventing supplier quotes or exact costs.',
  launch_checklist: 'Create a staged product launch checklist covering validation, prototype, safety/compliance research, sourcing, campaign preparation, support, fulfilment planning, and post-launch feedback. Flag items requiring qualified professional review.',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
    if (!supabaseUrl || !supabaseAnonKey || !geminiKey) throw new Error('Server configuration is incomplete. Set Supabase and GEMINI_API_KEY secrets.');

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return new Response(JSON.stringify({ error: 'Sign-in required.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const supabase = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return new Response(JSON.stringify({ error: 'Invalid or expired session.' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await req.json();
    const action = String(body.action || '');
    const title = String(body.title || 'Untitled product idea').slice(0, 180);
    const description = String(body.description || '').slice(0, 12000);
    if (!prompts[action]) return new Response(JSON.stringify({ error: 'Unsupported AI action.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (description.trim().length < 20) return new Response(JSON.stringify({ error: 'Please provide at least 20 characters describing the idea.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'You are Launchglass AI Co-Founder, an early-stage product planning assistant. Be practical, honest, concise, and explicit about uncertainty. Do not present legal, financial, engineering, safety, or market claims as verified facts. ' + prompts[action] }] },
        contents: [{ role: 'user', parts: [{ text: `Product idea: ${title}\n\nDescription:\n${description}` }] }],
        generationConfig: { temperature: 0.55, maxOutputTokens: 1800 },
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      const message = result?.error?.message || `Gemini request failed (${response.status}).`;
      return new Response(JSON.stringify({ error: message }), { status: response.status === 429 ? 429 : 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const text = (result?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('\n').trim();
    if (!text) throw new Error('Gemini returned no text. Try again.');
    return new Response(JSON.stringify({ text, action, user_id: user.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
