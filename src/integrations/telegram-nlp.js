// Plain-text intent parsing for Telegram (no slash commands).
// Supports multiline descriptions after "for the following work:".

function stripHourClause(text) {
  return text
    .replace(/\s+with\s+a\s+total\s+of\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b.*$/i, '')
    .replace(/\s+totalling\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b.*$/i, '')
    .replace(/\s*,?\s*total\s+of\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b.*$/i, '')
    .replace(/\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\b\s*$/i, '')
    .trim();
}

function parseHours(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
  return m ? parseFloat(m[1]) : null;
}

function parseMinutes(text) {
  const m = text.match(/(\d+)\s*(?:minutes?|mins?|m)\b/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseAmount(text) {
  const m = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/) || text.match(/(?:^|\s)(\d+(?:\.\d{2})?)\s*(?:dollars?|aud)\b/i);
  return m ? parseFloat(m[1]) : null;
}

function cleanWorkDescription(text) {
  return text
    .replace(/^the\s+following\s+work:?\s*/i, '')
    .replace(/^work:?\s*/i, '')
    .trim();
}

export function parsePlainText(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.startsWith('/')) return null;

  // charge|invoice|bill CLIENT N hours for [the following work:] DESCRIPTION (multiline OK)
  let m = raw.match(
    /^(?:charge|invoice|bill)\s+(.+?)\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s+for\s*(?:the\s+following\s+work:?\s*)?([\s\S]+)$/i
  );
  if (m) {
    const description = cleanWorkDescription(m[3]);
    if (description) {
      return {
        type: 'time',
        clientPart: m[1].trim(),
        description,
        minutes: Math.round(parseFloat(m[2]) * 60)
      };
    }
  }

  // Log 2 hours on/for Client — description
  m = raw.match(/^log\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s+(?:on|for)\s+([\s\S]+)$/i);
  if (m) {
    const tail = m[2].trim();
    const split = tail.match(/^(.+?)\s*[—–-]\s*([\s\S]+)$/s) || tail.match(/^(\S+(?:\s+\S+)?)\s+([\s\S]+)$/s);
    if (split) {
      return { type: 'time', clientPart: split[1].trim(), description: split[2].trim(), minutes: Math.round(parseFloat(m[1]) * 60) };
    }
    return { type: 'time', clientPart: tail, description: 'Support', minutes: Math.round(parseFloat(m[1]) * 60) };
  }

  m = raw.match(/^log\s+(\d+)\s*(?:minutes?|mins?|m)\s+(?:on|for)\s+([\s\S]+)$/i);
  if (m) {
    const tail = m[2].trim();
    const split = tail.match(/^(.+?)\s*[—–-]\s*([\s\S]+)$/s) || tail.match(/^(\S+(?:\s+\S+)?)\s+([\s\S]+)$/s);
    if (split) {
      return { type: 'time', clientPart: split[1].trim(), description: split[2].trim(), minutes: parseInt(m[1], 10) };
    }
    return { type: 'time', clientPart: tail, description: 'Support', minutes: parseInt(m[1], 10) };
  }

  // charge|invoice CLIENT $amount for [the following work:] DESCRIPTION (multiline OK)
  m = raw.match(
    /^(?:charge|invoice)\s+(.+?)\s+\$\s*(\d+(?:\.\d{1,2})?)\s+for\s*(?:the\s+following\s+work:?\s*)?([\s\S]+)$/i
  ) || raw.match(
    /^(?:charge|invoice)\s+(.+?)\s+(\d+(?:\.\d{2})?)\s+(?:dollars?|aud)\s+for\s*(?:the\s+following\s+work:?\s*)?([\s\S]+)$/i
  );
  if (m) {
    return { type: 'charge', clientPart: m[1].trim(), amount: parseFloat(m[2]), description: cleanWorkDescription(m[3]) };
  }

  // invoice/bill Client for description ... N hours (multiline OK)
  m = raw.match(/^(?:invoice|bill)\s+(.+?)\s+for\s+([\s\S]+)$/i);
  if (m) {
    const clientPart = m[1].trim();
    let description = m[2].trim();
    const hours = parseHours(description);
    const minutes = parseMinutes(description) ?? (hours ? Math.round(hours * 60) : null);
    if (minutes && minutes > 0) {
      description = stripHourClause(description);
      return { type: 'time', clientPart, description: description || 'Support', minutes };
    }
    const amount = parseAmount(raw);
    if (amount && amount > 0) {
      const descOnly = description.replace(/\$\s*\d+(?:\.\d{1,2})?/, '').trim() || description;
      return { type: 'charge', clientPart, amount, description: descOnly };
    }
  }

  // invoice Client $amount (description optional)
  m = raw.match(/^(?:invoice|bill)\s+(.+?)\s+\$\s*(\d+(?:\.\d{1,2})?)(?:\s+for\s+([\s\S]+))?$/i);
  if (m) {
    return { type: 'charge', clientPart: m[1].trim(), amount: parseFloat(m[2]), description: (m[3] || 'Services').trim() };
  }

  return null;
}
