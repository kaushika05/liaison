export type SmsSecretCategory =
  | "PASSWORD"
  | "ONE_TIME_CODE"
  | "PIN"
  | "SECURITY_ANSWER"
  | "PAYMENT_CARD"
  | "CVV"
  | "SOCIAL_SECURITY_NUMBER"
  | "API_KEY"
  | "RECOVERY_CODE"
  | "ACCOUNT_NUMBER"
  | "ORDER_NUMBER"
  | "DATE_OF_BIRTH"
  | "ADDRESS";
export interface SmsSecretDetection {
  redactedText: string;
  categories: SmsSecretCategory[];
  blocked: boolean;
}

const rules: Array<{ category: SmsSecretCategory; pattern: RegExp }> = [
  { category: "PASSWORD", pattern: /\b(?:password|passcode)\s*(?:is|:|=)?\s*\S+/gi },
  {
    category: "ONE_TIME_CODE",
    pattern:
      /\b(?:one[- ]?time(?:\s+(?:password|code))?|otp|verification\s+code|auth(?:entication)?\s+code)(?=\s*(?:is|:|=)\s*|\s+\d)\s*(?:is|:|=)?\s*[A-Z0-9-]{4,12}\b/gi,
  },
  { category: "PIN", pattern: /\b(?:pin|personal identification number)\s*(?:is|:|=)?\s*\d{3,12}\b/gi },
  {
    category: "SECURITY_ANSWER",
    pattern: /\b(?:security\s+answer|answer\s+to\s+(?:my|the)\s+security\s+question)\s*(?:is|:|=)?\s*[^\n,;.]{2,80}/gi,
  },
  { category: "CVV", pattern: /\b(?:cvv|cvc|security\s+code)\s*(?:is|:|=)?\s*\d{3,4}\b/gi },
  {
    category: "SOCIAL_SECURITY_NUMBER",
    pattern: /\b(?:ssn|social security(?:\s+number)?)\s*(?:is|:|=)?\s*\d{3}[- ]?\d{2}[- ]?\d{4}\b/gi,
  },
  {
    category: "PAYMENT_CARD",
    pattern: /\b(?:card|credit card|debit card|payment card)(?:\s+number)?\s*(?:is|:|=)?\s*(?:\d[ -]?){13,19}\b/gi,
  },
  {
    category: "API_KEY",
    pattern:
      /\b(?:api[_ -]?key|secret[_ -]?key|access[_ -]?token)\s*(?:is|:|=)?\s*(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{20,})\b/gi,
  },
  {
    category: "API_KEY",
    pattern:
      /\b(?:sk-(?:proj|live|test)-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gi,
  },
  { category: "RECOVERY_CODE", pattern: /\b(?:recovery|backup)\s+code\s*(?:is|:|=)?\s*[A-Za-z0-9-]{6,32}\b/gi },
  {
    category: "ACCOUNT_NUMBER",
    pattern: /\b(?:account|member|customer)\s*(?:number|no\.?|id)\s*(?:is|:|=)?\s*[A-Za-z0-9-]{5,32}\b/gi,
  },
  {
    category: "ORDER_NUMBER",
    pattern: /\b(?:order|booking|reservation)\s*(?:number|no\.?|id)\s*(?:is|:|=)?\s*[A-Za-z0-9-]{5,32}\b/gi,
  },
  {
    category: "DATE_OF_BIRTH",
    pattern: /\b(?:date of birth|dob|birth date)\s*(?:is|:|=)?\s*(?:\d{1,2}[/-]){2}\d{2,4}\b/gi,
  },
  {
    category: "ADDRESS",
    pattern: /\b(?:my|the)\s+(?:billing|home|mailing|street)\s+address\s*(?:is|:|=)?\s*\d{1,6}\s+[^\n,;]{3,80}/gi,
  },
];

/** Redacts prohibited credentials before persistence, logging, or model use. */
export function redactInboundSmsSecrets(input: string): SmsSecretDetection {
  let redactedText = input.slice(0, 4_000);
  const found = new Set<SmsSecretCategory>();
  for (const rule of rules) {
    redactedText = redactedText.replace(rule.pattern, () => {
      found.add(rule.category);
      return `[REDACTED_PROHIBITED_${rule.category}]`;
    });
  }
  return { redactedText, categories: [...found], blocked: found.size > 0 };
}

export const prohibitedSmsNotice =
  "That message appeared to contain credentials or personal account data, so Liaison did not store or use the value. Do not text passwords, codes, API keys, card or Social Security data, PINs, security answers, account or order identifiers, dates of birth, or addresses. Use the secure web app for supported personal-data steps.";
