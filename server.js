import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(express.json());

const { SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_ACCESS_TOKEN } = process.env;

// Fetch product by handle and return variant ID based on selected options
app.post("/get-variant-id", async (req, res) => {
  try {
    const { handle, selectedOptions } = req.body;
    if (!handle || !selectedOptions) {
      return res.status(400).json({ error: "Missing handle or selectedOptions" });
    }

    // GraphQL query to fetch product variants
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

    const response = await axios.post(
      `https://${SHOPIFY_STORE_DOMAIN}/api/2024-10/graphql.json`,
      { query, variables: { handle } },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_ACCESS_TOKEN,
        },
      }
    );

    const variants = response.data.data?.product?.variants?.edges || [];

    // Find matching variant
    const matchingVariant = variants.find(({ node }) => {
      return selectedOptions.every(
        (option) =>
          node.selectedOptions.some(
            (v) => v.name.toLowerCase() === option.name.toLowerCase() && v.value === option.value
          )
      );
    });

    if (!matchingVariant) {
      return res.status(404).json({ error: "No matching variant found" });
    }

    res.json({ variantId: matchingVariant.node.id });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
