require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const pool = require('./config/database');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const subscriptionRoutes = require('./routes/subscriptions');
const instanceRoutes = require('./routes/instances');
const webhookRoutes = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3001;

async function waitForDB() {
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('Database connected!');
      return true;
    } catch (err) {
      console.log(`DB attempt ${i}/30 - waiting 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Could not connect to database after 90s');
}

async function runMigrations() {
  const statements = [
    `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`,
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      stripe_customer_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id VARCHAR(255) UNIQUE,
      stripe_price_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'active',
      plan VARCHAR(50) NOT NULL DEFAULT 'basic',
      cameras_limit INTEGER DEFAULT 2,
      storage_days INTEGER DEFAULT 7,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS instances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      container_id VARCHAR(255),
      status VARCHAR(50) DEFAULT 'creating',
      port INTEGER,
      domain VARCHAR(255),
      config JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS cameras (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instance_id UUID REFERENCES instances(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      rtsp_url VARCHAR(500) NOT NULL,
      detection_enabled BOOLEAN DEFAULT true,
      recording_enabled BOOLEAN DEFAULT true,
      zones JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_instances_user_id ON instances(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_cameras_instance_id ON cameras(instance_id)`
  ];

  for (const stmt of statements) {
    await pool.query(stmt);
  }
  console.log('Migrations completed successfully');
}

// Middleware
app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/instances', instanceRoutes);
app.use('/api/webhooks', webhookRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function start() {
  try {
    await waitForDB();
    await runMigrations();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`API Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
