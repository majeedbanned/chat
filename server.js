require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { verifyToken } = require('./lib/auth');
const chatService = require('./services/chat');

// Create Express app
const app = express();
const server = http.createServer(app);

// Enable CORS
app.use(cors({
  origin: ['http://localhost:3000', 'https://formmaker3.com'],
  credentials: true
}));

// Parse JSON request body
app.use(express.json());

// Socket.IO instance with CORS
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://formmaker3.com'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.IO middleware to authenticate user
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const user = await verifyToken(token);
    if (!user) {
      return next(new Error('Invalid token'));
    }

    socket.user = user;
    next();
  } catch (error) {
    console.error('Socket authentication error:', error);
    next(new Error('Authentication failed'));
  }
});

// Connected clients by user ID
const connectedClients = new Map();

// Socket.IO connection handler
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`User connected: ${user.name} (${user.username})`);
  
  // Store client connection
  connectedClients.set(user.username, socket);
  
  // Handle joining a chatroom
  socket.on('join-room', async (chatroomId, callback) => {
    try {
      // Leave previous rooms
      Array.from(socket.rooms).forEach(room => {
        if (room !== socket.id) {
          socket.leave(room);
        }
      });
      
      // Join new room
      socket.join(chatroomId);
      console.log(`${user.name} joined room: ${chatroomId}`);
      
      // Get previous messages
      const messages = await chatService.getChatroomMessages(
        chatroomId, 
        user.schoolCode, 
        socket.handshake.headers.host || 'localhost:3000'
      );
      
      // Mark messages as read
      await chatService.markMessagesAsRead(
        chatroomId, 
        user.username, 
        user.schoolCode, 
        socket.handshake.headers.host || 'localhost:3000'
      );
      
      // Send response
      if (callback) {
        callback({
          success: true,
          messages
        });
      }
    } catch (error) {
      console.error('Error joining room:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to join chatroom'
        });
      }
    }
  });
  
  // Handle sending a message
  socket.on('send-message', async (messageData, callback) => {
    try {
      if (!messageData.content.trim()) {
        if (callback) {
          callback({
            success: false,
            error: 'Message cannot be empty'
          });
        }
        return;
      }
      
      // Create message with sender info
      const newMessage = {
        chatroomId: messageData.chatroomId,
        schoolCode: user.schoolCode,
        content: messageData.content,
        sender: {
          id: user.username,
          name: user.name,
          username: user.username,
          role: user.role
        },
        timestamp: new Date(),
        read: false
      };
      
      // Save message to database
      const savedMessage = await chatService.saveMessage(
        newMessage, 
        socket.handshake.headers.host || 'localhost:3000'
      );
      
      // Broadcast to room
      io.to(messageData.chatroomId).emit('new-message', savedMessage);
      
      // Return success
      if (callback) {
        callback({
          success: true,
          message: savedMessage
        });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to send message'
        });
      }
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${user.name} (${user.username})`);
    connectedClients.delete(user.username);
  });
});

// API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Chat server is running' });
});

// GET endpoint to retrieve chatrooms
app.get('/api/chatrooms', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const domain = req.headers['x-domain'] || 'localhost:3000';
    const chatrooms = await chatService.getChatrooms(user.schoolCode, domain);
    
    res.json({ chatrooms });
  } catch (error) {
    console.error('Error fetching chatrooms:', error);
    res.status(500).json({ error: 'Failed to fetch chatrooms' });
  }
});

// GET endpoint to retrieve messages for a chatroom
app.get('/api/messages/:chatroomId', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { chatroomId } = req.params;
    const domain = req.headers['x-domain'] || 'localhost:3000';
    
    const messages = await chatService.getChatroomMessages(
      chatroomId, 
      user.schoolCode, 
      domain
    );
    
    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chat server listening on port ${PORT}`);
}); 