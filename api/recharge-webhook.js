const SHOPIFY_GRAPHQL_URL = 'https://healthynesting.myshopify.com/admin/api/2025-01/graphql.json'

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
    const res = await fetch(SHOPIFY_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_KEY,
      },
      body: JSON.stringify({ query }),
    })
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

async function processSubscription(subscription) {
  const variantId = subscription.external_variant_id?.ecommerce || subscription.shopify_variant_id
  const productId = subscription.external_product_id?.ecommerce || subscription.shopify_product_id
  const subscriptionId = subscription.id
  const currentPrice = parseFloat(subscription.price)

  if (!subscriptionId || !variantId) {
    console.log(`⚠️ Missing IDs: Sub=${subscriptionId}, Var=${variantId}`)
    return
  }

  console.log(`📦 Subscription: ${subscriptionId}, variant ${variantId}`)

  const shopifyVariant = await getShopifyVariantData(variantId)

  let originalPrice = 0
  let discountValue = 0

  if (shopifyVariant?.price) {
    originalPrice = Number(shopifyVariant.price)
    discountValue = Number((originalPrice - currentPrice).toFixed(2))
  } else {
    console.log(`⚠️ Shopify fallback for product ${productId}`)
    const discountPercent = getDiscountPercent(productId)
    originalPrice = Number((currentPrice / (1 - discountPercent / 100)).toFixed(2))
    discountValue = Number((originalPrice - currentPrice).toFixed(2))
  }

  if (discountValue <= 0) {
    console.log('⏭ 0% discount, skipping')
    return
  }

  await updateSubscription(
    subscriptionId,
    originalPrice.toFixed(2),
    discountValue.toFixed(2),
    subscription.properties || []
  )
}

async function processLineItems(lineItems) {
  for (const item of lineItems) {
    const itemType = (item.type || item.purchase_item_type || '').toLowerCase()
    if (itemType === 'onetime') {
      console.log(`⏭ Skipping onetime item`)
      continue
    }

    const subscriptionId = item.subscription_id || item.purchase_item_id
    const productId = item.shopify_product_id || item.external_product_id?.ecommerce
    const variantId = item.shopify_variant_id || item.external_variant_id?.ecommerce

    if (!subscriptionId || !variantId) continue

    const currentPrice = parseFloat(item.unit_price || item.price)
    console.log(`📦 Charge item: subscription ${subscriptionId}, variant ${variantId}`)

    const shopifyVariant = await getShopifyVariantData(variantId)

    let originalPrice = 0
    let discountValue = 0

    if (shopifyVariant?.price) {
      originalPrice = Number(shopifyVariant.price)
      discountValue = Number((originalPrice - currentPrice).toFixed(2))
    } else {
      console.log(`⚠️ Shopify fallback for product ${productId}`)
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
}

// ===================== NEW: order/created → Shopify order metafield =====================

const ORDER_MF_NAMESPACE = 'custom'
const ORDER_MF_KEY = 'subscription_data'
const ORDER_TAG = 'sub-pricing-metafield'

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(SHOPIFY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL ${res.status}: ${JSON.stringify(json.errors || json)}`)
  }
  return json.data
}

function hasSubscriptionProps(item) {
  const props = item.properties || []
  return props.some(p => p.name === '_subscription_original_price' && p.value)
}

async function writeOrderMetafield(shopifyOrderId, items) {
  const orderGid = `gid://shopify/Order/${shopifyOrderId}`

  // metafieldsSet перезаписує значення, тож ретраї вебхука безпечні
  const data = await shopifyGraphQL(
    `mutation ($metafields: [MetafieldsSetInput!]!, $id: ID!, $tags: [String!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    {
      id: orderGid,
      tags: [ORDER_TAG],
      metafields: [
        {
          ownerId: orderGid,
          namespace: ORDER_MF_NAMESPACE,
          key: ORDER_MF_KEY,
          type: 'json',
          value: JSON.stringify({ items }),
        },
      ],
    }
  )

  const errors = [...data.metafieldsSet.userErrors, ...data.tagsAdd.userErrors]
  if (errors.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`)
}

async function processOrder(order) {
  const shopifyOrderId = order.external_order_id?.ecommerce || order.shopify_order_id
  if (!shopifyOrderId) {
    console.log(`⚠️ Recharge order ${order.id}: no Shopify order id`)
    return
  }

  console.log(`🧾 Order: Recharge ${order.id}, Shopify ${shopifyOrderId}`)

  const items = []

  for (const item of order.line_items || []) {
    const itemType = (item.purchase_item_type || item.type || '').toLowerCase()
    if (itemType === 'onetime') continue

    // properties є → тема спрацювала або це рекурентне замовлення, metafield не потрібен
    if (hasSubscriptionProps(item)) continue

    const subscriptionId = item.purchase_item_id || item.subscription_id
    const variantId = item.external_variant_id?.ecommerce || item.shopify_variant_id
    const productId = item.external_product_id?.ecommerce || item.shopify_product_id
    if (!subscriptionId || !variantId) continue

    const currentPrice = parseFloat(item.unit_price || item.price)
    const shopifyVariant = await getShopifyVariantData(variantId)

    let originalPrice = 0
    if (shopifyVariant?.price) {
      originalPrice = Number(shopifyVariant.price)
    } else {
      console.log(`⚠️ Shopify fallback for product ${productId}`)
      const discountPercent = getDiscountPercent(productId)
      originalPrice = Number((currentPrice / (1 - discountPercent / 100)).toFixed(2))
    }

    const discountValue = Number((originalPrice - currentPrice).toFixed(2))
    if (discountValue <= 0) continue

    items.push({
      product_title: item.title || null,
      variant_title: item.variant_title || null,
      _subscription_original_price: `$${originalPrice.toFixed(2)}`,
      _subscription_discount: `$${discountValue.toFixed(2)}`,
    })
  }

  if (!items.length) {
    console.log('⏭ Order has props or no discounted subscription items, skipping')
    return
  }

  await writeOrderMetafield(shopifyOrderId, items)
  console.log(`✅ Metafield written to Shopify order ${shopifyOrderId}: ${JSON.stringify(items)}`)
}

// ========================================================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const topic = req.headers['x-recharge-topic']
  console.log(`📩 Webhook topic: ${topic}`)

  // subscription/created or subscription/updated
  if (req.body?.subscription) {
    await processSubscription(req.body.subscription)
    return res.status(200).json({ ok: true })
  }

  // charge/upcoming
  if (req.body?.charge) {
    await processLineItems(req.body.charge.line_items || [])
    return res.status(200).json({ ok: true })
  }

  // NEW: order/created
  if (req.body?.order) {
    try {
      await processOrder(req.body.order)
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('❌ Order metafield failed:', err)
      // 500 → Recharge повторить вебхук
      return res.status(500).json({ error: 'order_processing_failed' })
    }
  }

  console.log('⏭ No relevant data, skipping')
  return res.status(200).json({ skipped: true })
}
