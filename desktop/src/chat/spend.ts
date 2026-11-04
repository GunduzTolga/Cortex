import type { ChatSpend } from '@shared/chat';

/**
 * A chat's cost as the list shows it (2 November notes: "sohbet kısmında session maliyetini görme"): dollars at the
 * API's list price where the tool told them, else its tokens. `title` is the longer word under the pointer; on a
 * subscription it says the dollars are the API's price of the work, not what was paid. Pure, for the tests.
 */
export function spendWords(
  spend: ChatSpend | undefined,
  language: string,
  t: (key: 'chat.spend.tokens' | 'chat.spend.title' | 'chat.spend.title.subscription' | 'chat.spend.title.tokens', values: Record<string, string>) => string,
): { short: string; title: string } | null {
  if (!spend || (spend.usd === null && spend.tokens <= 0)) return null;
  const tokens = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(spend.tokens);
  const allTokens = new Intl.NumberFormat(language).format(spend.tokens);
  if (spend.usd === null) return { short: t('chat.spend.tokens', { tokens }), title: t('chat.spend.title.tokens', { tokens: allTokens }) };
  const money = (digits: number) => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
  const short = spend.usd > 0 && spend.usd < 0.01 ? `<${money(2).format(0.01)}` : money(2).format(spend.usd);
  const exact = money(4).format(spend.usd);
  // "About" on a subscription's price; not before "under a cent", which says it already.
  return { short: spend.subscription && !short.startsWith('<') ? `≈${short}` : short, title: t(spend.subscription ? 'chat.spend.title.subscription' : 'chat.spend.title', { usd: exact, tokens: allTokens }) };
}
