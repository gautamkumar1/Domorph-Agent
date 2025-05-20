import express from 'express';
import { createAgent, extractUrl } from './agent.js';
import { HumanMessage } from "@langchain/core/messages";

const router = express.Router();

// Map to store user threads (simple in-memory implementation - would use a database in production)
const userThreads = new Map();

// Initialize the agent (should be configured with your Anthropic API key)
let agent = null;

// Middleware to check if agent is initialized
const checkAgent = (req, res, next) => {
  if (!agent) {
    return res.status(500).json({ 
      error: true, 
      message: "Agent not initialized. Please configure API keys" 
    });
  }
  next();
};

// Route to set API keys
router.post('/configure', (req, res) => {
  console.log(JSON.stringify(req.body));
  const { anthropicKey } = req.body;
  
  if (!anthropicKey) {
    return res.status(400).json({ 
      error: true, 
      message: "Anthropic API key is required" 
    });
  }
  
  try {
    console.log("⚙️ Configuring agent with API keys...");
    agent = createAgent(anthropicKey);
    res.json({ 
      success: true, 
      message: "Agent configured successfully" 
    });
  } catch (error) {
    console.error("❌ Error configuring agent:", error);
    res.status(500).json({ 
      error: true, 
      message: `Error configuring agent: ${error.message}` 
    });
  }
});

// Route to interact with the agent
router.post('/chat', checkAgent, async (req, res) => {
  console.log(JSON.stringify(req.body));
  try {
    const { message, userId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        error: true, 
        message: "Message is required" 
      });
    }

    console.log(`📩 Received message from user ${userId}: ${message}`);
    
    // Get or create thread for this user
    if (!userThreads.has(userId)) {
      userThreads.set(userId, []);
    }
    
    const threadMessages = userThreads.get(userId);
    const humanMessage = new HumanMessage(message);
    
    // Check if the message contains a URL
    const url = extractUrl(message);
    if (url) {
      console.log(`🌐 Detected URL in message: ${url}`);
    }
    
    // Update thread with new message
    threadMessages.push(humanMessage);
    
    // Invoke the agent
    console.log(`🤖 Invoking agent for user ${userId}...`);
    const result = await agent.invoke(
      { messages: threadMessages },
      { configurable: { thread_id: userId } }
    );
    
    // Store the AI's response in the thread
    const aiResponse = result.messages[result.messages.length - 1];
    threadMessages.push(aiResponse);
    
    // Send response to client
    res.json({ 
      response: aiResponse.content,
      threadId: userId
    });
    
  } catch (error) {
    console.error("❌ Error processing message:", error);
    res.status(500).json({ 
      error: true, 
      message: `Error processing message: ${error.message}` 
    });
  }
});

// Route to clear a user's thread
router.post('/clear', (req, res) => {
  const { userId = 'default' } = req.body;
  
  if (userThreads.has(userId)) {
    userThreads.delete(userId);
    console.log(`🧹 Cleared thread for user ${userId}`);
  }
  
  res.json({ success: true, message: `Thread cleared for user ${userId}` });
});

// Route to get debug info about threads
router.get('/debug/threads', (req, res) => {
  const threadInfo = {};
  
  userThreads.forEach((messages, userId) => {
    threadInfo[userId] = {
      messageCount: messages.length,
      preview: messages.length > 0 ? messages[messages.length - 1].content.substring(0, 100) + '...' : ''
    };
  });
  
  res.json(threadInfo);
});

export default router;
