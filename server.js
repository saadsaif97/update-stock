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

/**
 * Helper function to decrease the custom.store_stock metafield quantity.
 * @param {string} variantGid - The Shopify Global ID of the variant.
 * @param {number} decreaseAmount - The amount to decrease the stock by.
 */
async function decreaseVariantStock(variantGid, decreaseAmount) {
  const METADATA_NAMESPACE = "custom";
  const METADATA_KEY = "store_stock";

  // --- STEP 1: READ the current metafield value (Admin API) ---
  const readQuery = `
        query getMetafield($id: ID!) {
            productVariant(id: $id) {
                id
                metafield(namespace: "${METADATA_NAMESPACE}", key: "${METADATA_KEY}") {
                    id
                    value
                }
            }
        }
    `;

  // Helper to handle API requests with retry logic (omitted for brevity)
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
      console.error("Admin API Error:", e.response?.data?.errors || e.message);
      throw new Error("Failed to communicate with Shopify Admin API.");
    }
  };


  const readResponse = await executeAdminQuery(readQuery, { id: variantGid });

  console.log({ readResponse: readResponse.data.data?.productVariant });

  const variantData = readResponse.data.data?.productVariant;
  const currentMetafield = variantData?.metafield;

  if (!variantData) {
    throw new Error("Product variant not found using GID.");
  }
  if (!currentMetafield) {
    // If metafield doesn't exist, we can't decrease it. Assuming the stock must be initialized.
    throw new Error(
      `Metafield '${METADATA_NAMESPACE}.${METADATA_KEY}' not found on this variant. Cannot proceed with decrease.`
    );
  }

  const currentValue = parseInt(currentMetafield.value, 10);
  if (isNaN(currentValue)) {
    throw new Error("Metafield value is not a valid integer.");
  }

  const newStock = currentValue - decreaseAmount;

  if (newStock < 0) {
    throw new Error(
      `Insufficient stock (Current: ${currentValue}) to decrease by ${decreaseAmount}.`
    );
  }

  // --- STEP 2: WRITE the new metafield value (Admin API) ---
  // Note: We use metafieldsSet which creates or updates a metafield based on
  // ownerId, namespace, and key. It does NOT accept the metafield's GID ('id') in the input.
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

  console.log({ newStock, currentMetafield, variantData });

  const writeResponse = await executeAdminQuery(writeMutation, {
    metafields: [
      {
        ownerId: variantData.id,
        namespace: METADATA_NAMESPACE,
        key: METADATA_KEY,
        // The previous error was caused by including 'id: currentMetafield.id' here.
        // The MetafieldsSetInput type does not accept the metafield's ID.
        value: newStock.toString(), // Value must be a string for API
        type: "number_integer",
      },
    ],
  });

  const mutationResult = writeResponse.data.data?.metafieldsSet;
  console.log({ writeResponseErrors: writeResponse.data.errors });
  if (mutationResult?.userErrors.length > 0) {
    throw new Error(
      "Shopify Metafield Update Error: " +
        JSON.stringify(mutationResult.userErrors)
    );
  }

  return { oldStock: currentValue, newStock, decreasedBy: decreaseAmount };
}

// ----------------------------------------------------------------------
// NEW COMBINED ENDPOINT
// ----------------------------------------------------------------------

app.post("/decrease-variant-stock", async (req, res) => {
  try {
    const { handle, selectedOptions, decreaseBy } = req.body;
    console.log({body: req.body, handle, selectedOptions, decreaseBy})
    const decreaseAmount = parseInt(decreaseBy, 10) || 1; // Default to 1 if not provided

    // 1. Basic input validation
    if (!handle || !selectedOptions || !Array.isArray(selectedOptions)) {
      return res.status(400).json({
        error:
          "Missing or invalid 'handle' or 'selectedOptions' array in request body.",
      });
    }
    if (decreaseAmount <= 0) {
      return res
        .status(400)
        .json({ error: "Decrease amount must be greater than 0." });
    }

    // --- STEP A: FIND VARIANT GID (Storefront API) ---
    // Note: The Storefront API is used here only to resolve the variant GID
    // from the handle and options, which is generally acceptable for public
    // read operations, but the final write (decrease stock) uses the Admin API.
    const storefrontQuery = `
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

    const variants =
      storefrontResponse.data.data?.product?.variants?.edges || [];

    const matchingVariant = variants.find(({ node }) => {
      // Ensure all requested options match the variant's selected options
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
      return res
        .status(404)
        .json({ error: "No matching variant found for the given options." });
    }

    const variantGid = matchingVariant.node.id;

    // --- STEP B: DECREASE STOCK (Admin API) ---
    const stockUpdate = await decreaseVariantStock(variantGid, decreaseAmount);

    res.json({
      message: "Variant stock successfully found and decreased.",
      variantGid: variantGid,
      productHandle: handle,
      options: selectedOptions,
      ...stockUpdate,
    });
  } catch (error) {
    const errorMessage = error.message || "An unknown error occurred.";
    // Handle specific errors for clearer feedback
    if (errorMessage.includes("Insufficient stock")) {
      return res.status(409).json({ error: errorMessage });
    }
    if (errorMessage.includes("not found")) {
      return res.status(404).json({ error: errorMessage });
    }

    console.error(
      "Server Error:",
      error.response?.data?.errors || errorMessage
    );
    res.status(500).json({
      error: "Server error during stock operation.",
      details: errorMessage,
    });
  }
});

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
