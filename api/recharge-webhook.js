const PRODUCT_DISCOUNTS = {
  '7045256052785': 17,
  '7053728710705': 0,
  '6702024392753': 13,
  '7053449297969': 0,
  '7097853771825': 0,
}

function getDiscountPercent(productId) {
  const id = String(productId)
  if (id in PRODUCT_DISCOUNTS) return PRODUCT_DISCOUNTS[id]
  return 10
}

async function getShopifyVariantData(variantId) {
  const query = `{
    productVariant(id: "gid://shopify/ProductVariant/${variantId}") {
      price
    }
  }`

  try {
    const res = await fetch(
      `https://healthynesting.myshopify.com/admin/api/2025-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_KEY,
        },
        body: JSON.stringify({ query }),
      }
    )
    const data = await res.json()
    const variant = data?.data?.productVariant
    console.log(`🛍 Shopify variant price=${variant?.price}`)
    return variant
  } catch (err) {
    console.error(`❌ Error fetching variant ${variantId}:`, err)
    return null
  }
}

async function updateSubscription(subscriptionId, originalPrice, discountValue, existingProps) {
  const currentPriceProp = existingProps.find(p => p.name === '_subscription_original_price')?.value
  const currentDiscountProp = existingProps.find(p => p.name === '_subscription_discount')?.value

  console.log(`✅ Existing Props: ${JSON.stringify(existingProps)}`)

  if (currentPriceProp === `$${originalPrice}` && currentDiscountProp === `$${discountValue}`) {
    return console.log('⏭ Already updated, skipping')
  }

  const otherProps = existingProps.filter(
    p => !['_subscription_original_price', '_subscription_discount'].includes(p.name)
  )

  const updatedProperties = [
    ...otherProps,
    { name: '_subscription_original_price', value: `$${originalPrice}` },
    { name: '_subscription_discount', value: `$${discountValue}` }
  ]

  const putResponse = await fetch(
    `https://api.rechargeapps.com/subscriptions/${subscriptionId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Recharge-Access-Token': process.env.RECHARGE_API_KEY,
        'X-Recharge-Version': '2021-11'
      },
      body: JSON.stringify({ properties: updatedProperties })
    }
  )

  const putData = await putResponse.json()
  console.log(`✅ Recharge status: ${putResponse.status}`)
  console.log(`✅ Updated subscription: ${JSON.stringify(putData)}`)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const topic = req.headers['x-recharge-topic']
  console.log(`📩 Webhook topic: ${topic}`)

  const data = req.body?.charge || req.body?.order || req.body
  const lineItems = data?.line_items || []

  if (lineItems.length === 0) {
    console.log('⏭ No line items, skipping')
    return res.status(200).json({ skipped: true })
  }

  for (const item of lineItems) {
    const itemType = (item.type || item.purchase_item_type || '').toLowerCase();
    if (itemType === 'onetime') continue

    const subscriptionId = item.subscription_id || item.purchase_item_id;
    const productId = item.shopify_product_id || item.external_product_id?.ecommerce;
    const variantId = item.shopify_variant_id || item.external_variant_id?.ecommerce;

    if (!subscriptionId || !variantId) continue;

    const currentPrice = parseFloat(item.unit_price || item.price)
    console.log(`📦 Charge item: subscription ${subscriptionId}, variant ${variantId}`)

    const shopifyVariant = await getShopifyVariantData(variantId)

    let originalPrice = 0
    let discountValue = 0

    if (shopifyVariant?.price) {
      originalPrice = Number(shopifyVariant.price)
      discountValue = Number((originalPrice - currentPrice).toFixed(2))
    } else {
      const discountPercent = getDiscountPercent(productId)
      originalPrice = Number((currentPrice / (1 - discountPercent / 100)).toFixed(2))
      discountValue = Number((originalPrice - currentPrice).toFixed(2))
    }

    if (discountValue <= 0) {
      console.log('⏭ 0% discount, skipping')
      continue
    }

    await updateSubscription(
      subscriptionId,
      originalPrice.toFixed(2),
      discountValue.toFixed(2),
      item.properties || []
    )
  }

  return res.status(200).json({ ok: true })
}
