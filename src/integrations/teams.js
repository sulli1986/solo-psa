// Microsoft Teams notifications via an Incoming Webhook (Power Automate "Workflows").
// Outbound-only — fits the app's no-inbound-endpoint design. Used for the daily
// digest and follow-up nudges; interactive chat stays on the web widget / Telegram.
//
// Setup (in Teams): channel → ⋯ → Workflows → "Post to a channel when a webhook
// request is received" → copy the HTTP POST URL into TEAMS_WEBHOOK_URL.

export function teamsConfigured() {
  return Boolean(process.env.TEAMS_WEBHOOK_URL);
}

// Send plain text (with optional title) as an Adaptive Card — the format the
// Workflows webhook expects. Legacy O365 connector URLs also accept this payload.
export async function sendTeamsMessage(text, title = null) {
  const body = [];
  if (title) {
    body.push({ type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true });
  }
  body.push({ type: 'TextBlock', text: String(text), wrap: true });
  const res = await fetch(process.env.TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body
        }
      }]
    })
  });
  if (!res.ok) throw new Error(`Teams webhook failed (${res.status}): ${await res.text()}`);
}
