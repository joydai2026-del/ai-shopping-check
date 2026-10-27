# Research and sources

What AI shopping tools read today (checked 2026-10-20):

| Topic | What we learned | Source |
|---|---|---|
| OpenAI product feed | ChatGPT shopping takes a merchant product feed. Required fields include `item_id`, `title`, `description`, `url`, `brand`, `image_url`, `price` (like `79.99 USD`), `availability` (`in_stock`, `out_of_stock`, `pre_order`, `backorder`, `unknown`); `gtin` is optional but must have a valid check digit. Onboarding is through an application, limited to approved partners. | [Products feed spec](https://developers.openai.com/commerce/specs/file-upload/products), [Commerce docs index](https://developers.openai.com/commerce/specs) |
| Agentic Commerce Protocol | The open protocol for buying inside ChatGPT: ChatGPT acts for the shopper and the merchant keeps handling the order. | [OpenAI commerce docs (full text)](https://developers.openai.com/commerce/llms-full.txt), [agenticcommerce.dev](https://agenticcommerce.dev) |
| OpenAI bots | OAI-SearchBot decides whether a site shows up in ChatGPT search; GPTBot is for training. ChatGPT-User fetches a page when a person asks ChatGPT to; OpenAI says robots.txt rules may not apply to these user-started visits, so this tool shows a ChatGPT-User block as a note and does not score it. | [Overview of OpenAI crawlers](https://developers.openai.com/api/docs/bots) |
| Perplexity bots | PerplexityBot powers Perplexity search results (not training). Perplexity-User is user-triggered and generally ignores robots.txt. | [Perplexity crawlers](https://docs.perplexity.ai/guides/bots) |
| Anthropic bots | ClaudeBot (training), Claude-SearchBot (search quality), Claude-User (user requests). All honor robots.txt. | [Anthropic support article](https://support.claude.com/en/articles/8896518) |
| Google-Extended | A robots.txt token for Gemini training and Gemini grounding. Does not affect Google Search. Google's page does not say whether it affects AI Mode, so this tool treats Googlebot as the bot for AI Mode and Google-Extended as a training-style choice. | [Google common crawlers](https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers) |
| llms.txt | A proposal (Jeremy Howard, 2024) for a Markdown file at the site root that gives AI tools a short overview and links. Optional and still early. | [llmstxt.org](https://llmstxt.org/) |

What this tool does **not** check (yet): whether the store has actually applied to OpenAI's merchant program, Google Merchant Center status, or prices shown only by JavaScript.

