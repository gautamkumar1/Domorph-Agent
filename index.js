import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import agentRoutes from './route.js';
import searchRoutes from './search.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/agent', agentRoutes);
app.use('/api/agent', searchRoutes);

// Root route
app.get('/', (req, res) => {
  res.send('Domorph Agent API is running. Use /api/agent endpoints to interact with the agent.');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 API Documentation:`);
  console.log(`  - POST /api/agent/configure - Configure the agent with API keys`);
  console.log(`  - POST /api/agent/chat - Send a message to the agent`);
  console.log(`  - POST /api/agent/clear - Clear a user's conversation thread`);
  console.log(`  - GET /api/agent/debug/threads - Debug information about active threads`);
});