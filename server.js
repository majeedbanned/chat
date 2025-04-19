require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { verifyToken } = require('./lib/auth');
const chatService = require('./services/chat');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

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

// Set up public folder for file access
app.use('/uploads', express.static('uploads'));

// Configure file upload storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return cb(new Error('Authentication required'), null);
    }
    
    // Verify token to get user
    verifyToken(token).then(user => {
      if (!user) {
        return cb(new Error('Invalid token'), null);
      }
      
      // Create upload directory if it doesn't exist
      const uploadDir = `uploads/${user.schoolCode}/chat`;
      fs.mkdirSync(uploadDir, { recursive: true });
      
      cb(null, uploadDir);
    }).catch(err => {
      cb(err, null);
    });
  },
  filename: function (req, file, cb) {
    // Generate unique filename with original extension
    const uniqueFilename = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileExt = path.extname(file.originalname);
    cb(null, uniqueFilename + fileExt);
  }
});

// Set up multer upload
const upload = multer({
  storage: storage,
  limits: {
    fileSize: process.env.FILE_UPLOAD_MAX_SIZE ? parseInt(process.env.FILE_UPLOAD_MAX_SIZE) : 10 * 1024 * 1024 // Default 10MB limit
  },
  fileFilter: function(req, file, cb) {
    // Allow all file types for now; add restrictions if needed
    cb(null, true);
  }
});

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
  connectedClients.set(user.id, socket);
  
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
        user.domain
      );
      
      // Mark messages as read
      await chatService.markMessagesAsRead(
        chatroomId, 
        user.id, 
        user.schoolCode, 
        user.domain
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
      // Check that at least one of content or fileAttachment is provided
      if (!messageData.content.trim() && !messageData.fileAttachment) {
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
        content: messageData.content.trim(), // Trim but allow empty string when file is attached
        sender: {
          id: user.id,
          name: user.name,
          username: user.id,
          role: user.role
        },
        timestamp: new Date(),
        read: false
      };

      // Add file attachment if present
      if (messageData.fileAttachment) {
        newMessage.fileAttachment = messageData.fileAttachment;
      }
      
      try {
        // Save message to database
        const savedMessage = await chatService.saveMessage(
          newMessage, 
          user.domain
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
      } catch (saveError) {
        console.error('Error saving message:', saveError);
        if (callback) {
          callback({
            success: false,
            error: 'Failed to save message: ' + (saveError.message || 'Unknown error')
          });
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to process message: ' + (error.message || 'Unknown error')
        });
      }
    }
  });
  
  // Handle deleting a message
  socket.on('delete-message', async (data, callback) => {
    try {
      const { messageId, chatroomId } = data;
      
      if (!messageId || !chatroomId) {
        if (callback) {
          callback({
            success: false,
            error: 'Missing required fields'
          });
        }
        return;
      }
      
      // Call the service to delete the message
      const result = await chatService.deleteMessage(
        messageId,
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (result.success) {
        // Notify all users in the chatroom that a message was deleted
        io.to(chatroomId).emit('message-deleted', { messageId });
        
        // Return success
        if (callback) {
          callback({
            success: true
          });
        }
      } else {
        // Return error
        if (callback) {
          callback({
            success: false,
            error: result.error
          });
        }
      }
    } catch (error) {
      console.error('Error deleting message:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to delete message'
        });
      }
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${user.name} (${user.username})`);
    connectedClients.delete(user.id);
  });
});

// API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Chat server is running' });
});

// Upload file endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      // Remove the uploaded file if authentication fails
      fs.unlinkSync(req.file.path);
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if file is an image
    const isImage = req.file.mimetype.startsWith('image/');
    
    // Create file attachment object with the same structure as our Mongoose schema
    const fileAttachment = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      type: req.file.mimetype,
      url: `/uploads/${user.schoolCode}/chat/${req.file.filename}`,
      isImage
    };

    // Log the file attachment object for debugging
    console.log('Created file attachment:', JSON.stringify(fileAttachment, null, 2));
    
    res.json({ success: true, fileAttachment });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file: ' + error.message });
  }
});

// GET endpoint to retrieve chatrooms
app.get('/api/chatrooms', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const chatrooms = await chatService.getChatrooms(user.schoolCode, user.domain);
    
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
    
    const messages = await chatService.getChatroomMessages(
      chatroomId, 
      user.schoolCode, 
      user.domain
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