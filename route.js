import express from 'express';
import { createAgent, extractUrl } from './agent.js';
import { HumanMessage } from "@langchain/core/messages";

const router = express.Router();

// Map to store user threads (simple in-memory implementation - would use a database in production)
const userThreads = new Map();

// Initialize the agent (should be configured with your Anthropic API key)
let agent = null;

// Route to interact with the agent
router.post('/chat', async (req, res) => {
  try {
    const { message, userId = 'default' } = req.body;
    
    if (!message) {
      return res.status(400).json({ 
        error: true, 
        message: "Message is required" 
      });
    }

    // Initialize agent if not already done
    if (!agent) {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) {
        return res.status(500).json({ 
          error: true, 
          message: "ANTHROPIC_API_KEY environment variable not set" 
        });
      }
      
      try {
        console.log("⚙️ Auto-configuring agent with API key from environment...");
        agent = createAgent(anthropicKey);
      } catch (error) {
        console.error("❌ Error configuring agent:", error);
        return res.status(500).json({ 
          error: true, 
          message: `Error configuring agent: ${error.message}` 
        });
      }
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
