// The AI bots we check robots.txt for. Data, not logic: add or remove bots here.
// Sources are listed in README.md ("Research and sources").

// Bots that FIND and SHOW your products to shoppers. Blocking these hides you.
export const SHOPPING_BOTS = [
  { token: 'OAI-SearchBot', who: 'ChatGPT search and shopping' },
  { token: 'PerplexityBot', who: 'Perplexity search and shopping' },
  { token: 'Claude-SearchBot', who: 'Claude search' },
  { token: 'Claude-User', who: 'Claude when a shopper asks it to look at a page' },
  { token: 'Googlebot', who: 'Google Search, AI Overviews and AI Mode' },
];

// Visits a person starts by asking an assistant to open a page. OpenAI says
// robots.txt rules may not apply to ChatGPT-User, so a block here is shown as
// a note and does not change the score.
// Source: https://developers.openai.com/api/docs/bots
export const ADVISORY_BOTS = [
  { token: 'ChatGPT-User', who: 'ChatGPT when a shopper asks it to open a page' },
];

// Bots that collect pages to TRAIN AI models. Blocking them is a fair choice
// and does not remove you from AI search, so this is only a gentle warning.
export const TRAINING_BOTS = [
  { token: 'GPTBot', who: 'OpenAI model training' },
  { token: 'ClaudeBot', who: 'Anthropic model training' },
  { token: 'Google-Extended', who: 'Gemini training and Gemini answers' },
];
