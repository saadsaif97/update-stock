const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

// Get credentials from environment variables
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_ACCESS_TOKEN } = process.env;

// Check for missing credentials
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_ACCESS_TOKEN) {
  console.error("Error: SHOPIFY_STORE_DOMAIN or SHOPIFY_STOREFRONT_ACCESS_TOKEN is missing in .env file.");
  process.exit(1);
}

// Endpoint: Fetch product by handle and return variant ID based on selected options
app.post("/get-variant-id", async (req, res) => {
  try {
    const { handle, selectedOptions } = req.body;

    // 1. Basic input validation
    if (!handle || !selectedOptions || !Array.isArray(selectedOptions)) {
      return res.status(400).json({ error: "Missing or invalid 'handle' or 'selectedOptions' array in request body." });
    }

    // 2. GraphQL query to fetch product variants
    // Note: We use the Storefront API version 'unstable' for the latest features,
    // but you can replace it with a specific date (e.g., '2024-10') if preferred.
    const query = `
      query getProduct($handle: String!) {
        product(handle: $handle) {
          variants(first: 100) {
            edges {
              node {
                id
                title
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    `;

    // 3. Call the Shopify Storefront API
    const response = await axios.post(
      `https://${SHOPIFY_STORE_DOMAIN}/api/2024-10/graphql.json`, // Using a specific version
      { query, variables: { handle } },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_ACCESS_TOKEN,
        },
      }
    );

    const variants = response.data.data?.product?.variants?.edges || [];

    // 4. Find the matching variant
    const matchingVariant = variants.find(({ node }) => {
      // The variant matches if ALL of the requested selectedOptions are present
      // in the variant's selectedOptions.
      return selectedOptions.every(
        (requestedOption) =>
          node.selectedOptions.some(
            (variantOption) =>
              variantOption.name.toLowerCase() === requestedOption.name.toLowerCase() &&
              variantOption.value.toLowerCase() === requestedOption.value.toLowerCase()
          )
      );
    });

    if (!matchingVariant) {
      return res.status(404).json({ error: "No matching variant found for the given options." });
    }

    // 5. Return the globally unique Variant ID
    res.json({ variantId: matchingVariant.node.id });
  } catch (error) {
    console.error("Shopify API Error:", error.response?.data?.errors || error.message);
    res.status(500).json({ error: "Server error during Shopify lookup." });
  }
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
