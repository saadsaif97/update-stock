const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

// Get credentials from environment variables
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_STOREFRONT_ACCESS_TOKEN,
  SHOPIFY_ADMIN_ACCESS_TOKEN,
  SHOPIFY_API_VERSION,
} = process.env;

// --- CREDENTIAL VALIDATION ---
if (!SHOPIFY_STORE_DOMAIN) {
  console.error("Error: SHOPIFY_STORE_DOMAIN is missing in .env file.");
  process.exit(1);
}
if (!SHOPIFY_STOREFRONT_ACCESS_TOKEN) {
  console.error(
    "Error: SHOPIFY_STOREFRONT_ACCESS_TOKEN is missing in .env file."
  );
  process.exit(1);
}
if (!SHOPIFY_ADMIN_ACCESS_TOKEN) {
  console.error("Error: SHOPIFY_ADMIN_ACCESS_TOKEN is missing in .env file.");
  process.exit(1);
}

// Admin GraphQL endpoint URL
const ADMIN_GRAPHQL_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${
  SHOPIFY_API_VERSION || "2024-10"
}/graphql.json`;

// Global Helper to handle Admin API requests
const executeAdminQuery = async (query, variables) => {
  try {
    return await axios.post(
      ADMIN_GRAPHQL_URL,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
        },
      }
    );
  } catch (e) {
    // === TEMPORARY DEBUGGING CODE ===
    const errorDetails = e.response
      ? `Status: ${e.response.status}, Errors: ${JSON.stringify(e)}`
      : e.message;
    console.error("Admin API Fatal Error Details:", errorDetails);
    // === END DEBUGGING CODE ===

    console.error("Admin API Error:", e.response?.data?.errors || e.message);
    // This is the error message returned to the Shopify Flow
    throw new Error("Failed to communicate with Shopify Admin API.");
  }
};

// ----------------------------------------------------------------------
// CORE HELPER FUNCTIONS
// ----------------------------------------------------------------------

/**
 * Helper function to fetch the 'available' inventory level for a variant.
 * @param {string} variantGid - The Shopify Global ID of the variant.
 * @returns {Promise<number>} - The available stock quantity (aggregated across locations).
 */
async function getVariantInventoryLevel(variantGid) {
  const readInventoryQuery = `
    query getVariantInventory($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          inventoryLevels(first: 100) {
            nodes {
              quantities(names: ["available"]) {
                quantity
                name
              }
            }
          }
        }
      }
    }
  `;

  const readResponse = await executeAdminQuery(readInventoryQuery, {
    id: variantGid,
  });

  const variantData = readResponse.data.data?.productVariant;

  if (!variantData) {
    throw new Error(`Product variant GID ${variantGid} not found.`);
  }

  const inventoryLevels =
    variantData.inventoryItem?.inventoryLevels?.nodes || [];

  if (inventoryLevels.length === 0) {
    console.warn(`No inventory levels found for variant ${variantGid}.`);
    return 0;
  }

  // Sum all 'available' quantities across all inventory locations.
  let totalAvailableStock = 0;
  for (const level of inventoryLevels) {
    const availableQuantityNode = level.quantities.find(
      (q) => q.name === "available"
    );
    if (availableQuantityNode) {
      totalAvailableStock += availableQuantityNode.quantity;
    }
  }

  return totalAvailableStock;
}

/**
 * Helper function to find a variant GID on a given product handle based on options.
 * @param {string} handle - The product handle (e.g., 'main-product' or 'main-product-store').
 * @param {Array<{name: string, value: string}>} selectedOptions - Options to match the variant.
 * @returns {Promise<string>} - The matching variant's Global ID (GID).
 */
async function getVariantGidByOptions(handle, selectedOptions) {
  const storefrontQuery = `
    query getProduct($handle: String!) {
      product(handle: $handle) {
        variants(first: 100) {
          edges {
            node {
              id
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

  const storefrontResponse = await axios.post(
    `https://${SHOPIFY_STORE_DOMAIN}/api/2024-10/graphql.json`,
    { query: storefrontQuery, variables: { handle } },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_ACCESS_TOKEN,
      },
    }
  );

  const variants = storefrontResponse.data.data?.product?.variants?.edges || [];

  const matchingVariant = variants.find(({ node }) => {
    // Check if ALL requested options match the variant's selected options
    return selectedOptions.every((requestedOption) =>
      node.selectedOptions.some(
        (variantOption) =>
          variantOption.name.toLowerCase() ===
            requestedOption.name.toLowerCase() &&
          variantOption.value.toLowerCase() ===
            requestedOption.value.toLowerCase()
      )
    );
  });

  if (!matchingVariant) {
    throw new Error(`No matching variant found for product handle '${handle}' with the given options.`);
  }

  return matchingVariant.node.id;
}


/**
 * Sets the custom.store_stock metafield on a variant to a new quantity.
 * @param {string} metafieldOwnerGid - The GID of the variant whose metafield should be updated.
 * @param {number} newQuantity - The new stock quantity to set.
 */
async function setVariantCustomStock(metafieldOwnerGid, newQuantity) {
  const METADATA_NAMESPACE = "custom";
  const METADATA_KEY = "store_stock";

  const writeMutation = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          value
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const writeResponse = await executeAdminQuery(writeMutation, {
    metafields: [
      {
        ownerId: metafieldOwnerGid,
        namespace: METADATA_NAMESPACE,
        key: METADATA_KEY,
        value: newQuantity.toString(), // Value must be a string for API
        type: "number_integer",
      },
    ],
  });

  const mutationResult = writeResponse.data.data?.metafieldsSet;
  if (mutationResult?.userErrors.length > 0) {
    throw new Error(
      "Shopify Metafield Update Error: " +
        JSON.stringify(mutationResult.userErrors)
    );
  }

  return { newStock: newQuantity };
}


// ----------------------------------------------------------------------
// NEW SYNCHRONIZATION ENDPOINT
// ----------------------------------------------------------------------

app.post("/sync-variant-stock", async (req, res) => {
  try {
    const { handle, selectedOptions } = req.body;

    // 1. Basic input validation
    if (!handle || !selectedOptions || !Array.isArray(selectedOptions)) {
      return res.status(400).json({
        error: "Missing or invalid 'handle' or 'selectedOptions' array in request body.",
      });
    }

    const storeHandle = `${handle}-store`;

    // --- STEP 1: FIND GID OF THE TARGET VARIANT (Metafield Owner) ---
    // This is the variant whose custom stock we will update.
    const metafieldOwnerGid = await getVariantGidByOptions(handle, selectedOptions);
    console.log(`Metafield Owner GID (${handle}): ${metafieldOwnerGid}`);

    // --- STEP 2: FIND GID OF THE SOURCE VARIANT (Inventory Source) ---
    // This is the variant whose actual inventory we will read.
    const inventorySourceGid = await getVariantGidByOptions(storeHandle, selectedOptions);
    console.log(`Inventory Source GID (${storeHandle}): ${inventorySourceGid}`);

    // --- STEP 3: FETCH AVAILABLE INVENTORY FROM SOURCE ---
    const availableStock = await getVariantInventoryLevel(inventorySourceGid);
    console.log(`Available Stock from source: ${availableStock}`);

    // --- STEP 4: UPDATE CUSTOM METAFIELD ON TARGET ---
    const updateResult = await setVariantCustomStock(metafieldOwnerGid, availableStock);

    res.json({
      message: "Variant custom stock successfully synchronized from Shopify inventory to custom metafield.",
      productHandle: handle,
      inventorySourceHandle: storeHandle,
      options: selectedOptions,
      metafieldOwnerGid: metafieldOwnerGid,
      ...updateResult,
    });
  } catch (error) {
    const errorMessage = error.message || "An unknown error occurred.";

    // Handle specific errors for clearer feedback
    if (errorMessage.includes("not found")) {
      return res.status(404).json({ error: errorMessage });
    }

    console.error(
      "Server Error in /sync-variant-stock:",
      error.response?.data?.errors || errorMessage
    );
    res.status(500).json({
      error: "Server error during stock synchronization.",
      details: errorMessage,
    });
  }
});


// ----------------------------------------------------------------------
// REMAINING ROUTES
// ----------------------------------------------------------------------

// The original decrease endpoint is removed for simplicity,
// but you can integrate this new sync logic into it if needed.

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Hi!!!!!!"
  })
})

// Start the server
const PORT = 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
