// Automated first-pass moderation. Pure functions, no I/O, so they are easy to unit test.
// This is a screen, not a judge: it routes content to the right queue. Humans make the HIGH-risk calls.

const termList = (name) => (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (terms) => (terms.length ? new RegExp('\\b(?:' + terms.map(esc).join('|') + ')\\b', 'i') : null);

const RULES = [
  // Personal information (Nigerian mobile formats, then international "+" numbers)
  ['PHONE_NUMBER', /(?<!\d)(?:\+?234|0)[\s.-]?[789][01]\d[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/],
  ['PHONE_NUMBER', /(?<![\w+])\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/],
  ['EMAIL_ADDRESS', /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i],
  ['EMAIL_ADDRESS', /\b[\w.-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[\w-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}\b/i],
  ['HOME_ADDRESS', /\b(?:no\.?|number|plot|block)\s*\d+[a-z]?,?\s+[\w\s.'-]{2,40}?\s+(?:street|st\.?|road|rd\.?|close|crescent|avenue|ave\.?|estate|way|lane|drive|layout)\b/i],
  ['LINK', /(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|t\.me|bit\.ly)\/\S+/i],
  // Threats, doxxing, serious allegations
  ['THREAT', /\b(?:i(?:'ll| will)|we(?:'ll| will)|going to|gonna)\s+(?:kill|hurt|beat|stab|shoot|burn|destroy|find)\b|\bkill (?:him|her|you|them)\b|\bwatch your back\b/i],
  ['DOXXING', /\b(?:lives (?:at|in|on)|(?:his|her) (?:house|home|address|car plate)|plate number|where (?:he|she) lives)\b/i],
  ['SERIOUS_ALLEGATION', /\b(?:rap(?:e|ed|ist)|sexual(?:ly)? (?:assault|harass|abus)\w*|molest\w*|assault(?:ed)?|kidnap\w*|murder\w*)\b/i],
  ['CRIMINAL_ALLEGATION', /\b(?:thie(?:f|ves)|stole|stealing|embezzl\w*|fraud\w*|bribe\w*|corrupt\w*|launder\w*|scam\w*|blackmail\w*)\b/i],
  // Named individuals: honorific + Name, or "my manager Name"
  ['NAMED_INDIVIDUAL', /\b(?:Mr|Mrs|Ms|Miss|Dr|Engr|Barr|Prof|Pastor|Chief|Alhaji|Alhaja)\.?\s+[A-Z][a-z]{2,}/],
  ['NAMED_INDIVIDUAL', /\b(?:[Mm]y|[Oo]ur|[Tt]he)\s+(?:line\s+)?(?:manager|boss|supervisor|MD|CEO|director|HR(?:\s+manager)?)\s+(?!is\b|was\b|has\b|had\b|did\b|would\b|never\b)[A-Z][a-z]{2,}/],
  // Language and spam
  ['PROFANITY', /\b(?:fuck\w*|shit\w*|bitch\w*|bastard|asshole)\b/i],
  ['SPAM', /\b(?:buy followers|whatsapp me|dm me|click (?:here|the link)|forex|crypto signals?|loan offer|investment opportunity|earn \$?\d+)\b/i],
  ['SPAM', /(.)\1{7,}/],
];

export function scanText(text) {
  const flags = new Set();
  const t = String(text || '');
  for (const [flag, re] of RULES) if (re.test(t)) flags.add(flag);

  const hate = termRe(termList('HATE_TERMS'));      // populate from a vetted list; none ship in source
  if (hate && hate.test(t)) flags.add('HATE_SPEECH');
  const prof = termRe(termList('EXTRA_PROFANITY')); // Pidgin and local terms
  if (prof && prof.test(t)) flags.add('PROFANITY');

  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) flags.add('SPAM'); // shouting
  return { flags: [...flags] };
}

const PII = ['PHONE_NUMBER', 'EMAIL_ADDRESS', 'HOME_ADDRESS'];
const ESCALATE = ['THREAT', 'HATE_SPEECH', 'DOXXING', 'SERIOUS_ALLEGATION'];
const MEDIUM = ['PROFANITY', 'CRIMINAL_ALLEGATION', 'NAMED_INDIVIDUAL', 'LINK', 'SPAM', 'DUPLICATE_CONTENT', 'COORDINATED_ACTIVITY', 'SALARY_OUTLIER'];

const ISSUE = {
  PHONE_NUMBER: 'Remove phone numbers.',
  EMAIL_ADDRESS: 'Remove email addresses.',
  HOME_ADDRESS: 'Remove street addresses.',
};
const MSG = {
  LIVE: 'Thanks. Your contribution is live.',
  PENDING: 'Thanks. A moderator will review this before it is published.',
  EDIT: 'We could not publish this yet. Please edit it and resubmit.',
  ESCALATED: 'Thanks. This needs a closer look from our team before it is published.',
};

/**
 * Policy:
 *  - ESCALATED (HIGH): threats, hate speech, doxxing, serious allegations, or a criminal allegation about a named person.
 *  - NEEDS_EDIT (HIGH): personal information only. The author can fix it without waiting for a human.
 *  - PENDING (MEDIUM): anything else suspicious, queued for a moderator.
 *  - LOW: PENDING by default; APPROVED automatically only if AUTO_APPROVE_LOW is on and the account is >= 24h old.
 */
export function decide(flags, { accountAgeHours = 9999, autoApproveLow = false } = {}) {
  const has = (list) => list.some((f) => flags.includes(f));
  const namedCriminal = flags.includes('CRIMINAL_ALLEGATION') && flags.includes('NAMED_INDIVIDUAL');
  const issues = PII.filter((f) => flags.includes(f)).map((f) => ISSUE[f]);
  const base = { flags, issues };
  if (has(ESCALATE) || namedCriminal) return { ...base, status: 'ESCALATED', risk: 'HIGH', auto: false, message: MSG.ESCALATED };
  if (has(PII)) return { ...base, status: 'NEEDS_EDIT', risk: 'HIGH', auto: false, message: MSG.EDIT };
  if (has(MEDIUM)) return { ...base, status: 'PENDING', risk: 'MEDIUM', auto: false, message: MSG.PENDING };
  const auto = autoApproveLow && accountAgeHours >= 24;
  return { ...base, status: auto ? 'APPROVED' : 'PENDING', risk: 'LOW', auto, message: auto ? MSG.LIVE : MSG.PENDING };
}
