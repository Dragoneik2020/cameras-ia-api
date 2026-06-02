const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../config/database');

// Stripe webhook
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

async function handleCheckoutComplete(session) {
  const { userId, planId } = session.metadata;

  const planLimits = {
    basic: { cameras: 2, storage: 7 },
    pro: { cameras: 8, storage: 30 },
    enterprise: { cameras: 999, storage: 90 }
  };

  const limits = planLimits[planId] || planLimits.basic;

  await pool.query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_price_id, status, plan, cameras_limit, storage_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       stripe_subscription_id = $2,
       stripe_price_id = $3,
       status = $4,
       plan = $5,
       cameras_limit = $6,
       storage_days = $7`,
    [userId, session.subscription, session.subscription_items.data[0].price.id, 'active', planId, limits.cameras, limits.storage]
  );
}

async function handleSubscriptionUpdated(subscription) {
  const statusMap = {
    active: 'active',
    past_due: 'past_due',
    canceled: 'cancelled',
    unpaid: 'unpaid'
  };

  await pool.query(
    'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
    [statusMap[subscription.status] || 'active', subscription.id]
  );
}

async function handleSubscriptionDeleted(subscription) {
  await pool.query(
    'UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2',
    ['cancelled', subscription.id]
  );
}

async function handlePaymentFailed(invoice) {
  const result = await pool.query(
    'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
    [invoice.subscription]
  );

  if (result.rows.length > 0) {
    // Could send email notification here
    console.log('Payment failed for user:', result.rows[0].user_id);
  }
}

module.exports = router;
