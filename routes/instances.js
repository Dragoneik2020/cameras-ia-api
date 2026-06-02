const express = require('express');
const router = express.Router();
const Docker = require('dockerode');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Create new instance
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;

    // Check subscription limits
    const subResult = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND status = $2',
      [req.user.id, 'active']
    );

    if (subResult.rows.length === 0) {
      return res.status(403).json({ error: 'Active subscription required' });
    }

    const subscription = subResult.rows[0];

    // Check instance limit
    const instanceCount = await pool.query(
      'SELECT COUNT(*) FROM instances WHERE user_id = $1',
      [req.user.id]
    );

    const maxInstances = subscription.plan === 'enterprise' ? 10 : 
                         subscription.plan === 'pro' ? 5 : 2;

    if (parseInt(instanceCount.rows[0].count) >= maxInstances) {
      return res.status(403).json({ error: 'Instance limit reached' });
    }

    // Generate unique port
    const basePort = 5000;
    const portOffset = parseInt(instanceCount.rows[0].count);
    const port = basePort + portOffset + (parseInt(req.user.id.slice(0, 8), 16) % 1000);

    // Create instance record
    const instanceResult = await pool.query(
      'INSERT INTO instances (user_id, name, status, port) VALUES ($1, $2, $3, $4) RETURN *',
      [req.user.id, name, 'creating', port]
    );

    const instance = instanceResult.rows[0];

    // Create Docker container
    const container = await docker.createContainer({
      Image: 'ghcr.io/blakeblackshear/frigate:stable',
      name: `frigate-${instance.id.slice(0, 8)}`,
      Hostname: `frigate-${instance.id.slice(0, 8)}`,
      ExposedPorts: {
        '5000/tcp': {},
        '8554/tcp': {},
        '8555/tcp': {}
      },
      HostConfig: {
        PortBindings: {
          '5000/tcp': [{ HostPort: port.toString() }],
          '8554/tcp': [{ HostPort: (port + 1).toString() }],
          '8555/tcp': [{ HostPort: (port + 2).toString() }]
        },
        Binds: [
          `/var/lib/cameras-ia/${instance.id}/config:/config`,
          `/var/lib/cameras-ia/${instance.id}/media:/media/frigate`
        ],
        Memory: 512 * 1024 * 1024, // 512MB
        Privileged: true
      },
      Labels: {
        'cameras-ia.user': req.user.id,
        'cameras-ia.instance': instance.id
      }
    });

    await container.start();

    // Update instance with container ID
    await pool.query(
      'UPDATE instances SET container_id = $1, status = $2 WHERE id = $3',
      [container.id, 'running', instance.id]
    );

    res.status(201).json({
      ...instance,
      container_id: container.id,
      status: 'running',
      access_url: `http://${process.env.SERVER_IP}:${port}`
    });
  } catch (error) {
    console.error('Instance creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user instances
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM instances WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Stop instance
router.post('/:id/stop', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const instance = await pool.query(
      'SELECT * FROM instances WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (instance.rows.length === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    const container = docker.getContainer(instance.rows[0].container_id);
    await container.stop();

    await pool.query('UPDATE instances SET status = $1 WHERE id = $2', ['stopped', id]);

    res.json({ message: 'Instance stopped' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete instance
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const instance = await pool.query(
      'SELECT * FROM instances WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (instance.rows.length === 0) {
      return res.status(404).json({ error: 'Instance not found' });
    }

    // Stop and remove container
    try {
      const container = docker.getContainer(instance.rows[0].container_id);
      await container.stop();
      await container.remove({ v: true });
    } catch (e) {
      console.log('Container already removed');
    }

    // Delete instance
    await pool.query('DELETE FROM instances WHERE id = $1', [id]);

    res.json({ message: 'Instance deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
