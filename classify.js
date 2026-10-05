const MODEL = 'gpt-6-luna';

const SYSTEM = `You triage WhatsApp messages for someone at yeshiva with no smartphone.
Return JSON: {"summary": string, "is_urgent": boolean, "requires_callback": boolean}.
summary: one short sentence, in English, naming what the sender wants.
is_urgent: true only for emergencies or truly time-sensitive matters (family emergency, illness, accident, someone waiting right now). Routine chatter is not urgent.
requires_callback: true if the sender expects a reply or call back.
Messages may be Hebrew, English or Yiddish.`;

export async function classify(senderName, text) {
  const fallback = { summary: text.slice(0, 120), is_urgent: false, requires_callback: false };
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `From ${senderName}: ${text}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { ...fallback, ...JSON.parse(data.choices[0].message.content) };
  } catch (err) {
    console.error('classify failed, using fallback:', err.message);
    return fallback;
  }
}
