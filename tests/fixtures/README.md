# Test fixtures (synthetic)

Every file in this folder was written by hand as a test input. None of them are
copies of a real store. Store names, products, prices and barcodes are made up
(barcodes use textbook example numbers). `{{ORIGIN}}` is replaced by the address
of the local fake store server during tests.

| Folder | What it pretends to be |
|---|---|
| `shopify-good/` | A Shopify store that does almost everything right |
| `shopify-bad/` | A Shopify store that blocks AI bots and has no product info on its pages |
| `woo-good/` | A WooCommerce store with Yoast-style product info |

`routes.json` in each folder maps a URL path to a file. Paths not listed return 404.
