const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get current subscription
router.get('/current', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ plan: 'none', status: 'inactive' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create checkout session
router.post('/checkout', authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;

    // Plan prices
    const plans = {
      basic: { price: 900, cameras: 2, storage: 7, name: 'Básico' },
      pro: { price: 2900, cameras: 8, storage: 30, name: 'Profesional' },
      enterprise: { price: 9900, cameras: 999, storage: 90, name: 'Empresa' }
    };

    const plan = plans[planId];
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    // Get or create Stripe customer
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    let user = userResult.rows[0];

    if (!user.stripe_customer_id) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id }
      });

      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customer.id, user.id]);
      user.stripe_customer_id = customer.id;
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: user.stripe_customer_id,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Cámaras IA - ${plan.name}`,
            description: `${plan.cámaras} cámaras, ${plan.storage} días de grabación`
          },
          unit_amount: plan.price,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { userId: user.id, planId }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel subscription
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2',
      [req.user.id, 'active']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription' });
    }

    const subscription = result.rows[0];

    // Cancel on Stripe
    await stripe.subscriptions.update(subscription.stripe_subscription_id, {
      cancel_at_period_end: true
    });

    // Update local status
    await pool.query(
      'UPDATE subscriptions SET status = $1 WHERE id = $2',
      ['cancelling', subscription.id]
    );

    res.json({ message: 'Subscription will be cancelled at period end' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
