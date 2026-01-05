require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { verifyToken } = require('./lib/auth');
const chatService = require('./services/chat');
const floatingChatService = require('./services/floatingChat');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Create Express app
const app = express();
const server = http.createServer(app);

// Enable CORS - Allow mobile app connections
app.use(cors({
  origin: ['http://localhost:3000', 'https://formmaker3.com', 'https://parsplus.farsamooz.ir', 'http://localhost:8081', 'http://localhost:19006'],
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

// Socket.IO instance with CORS - Allow mobile app connections
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://formmaker3.com', 'https://parsplus.farsamooz.ir', 'http://localhost:8081', 'http://localhost:19006'],
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
      
      // If this is the floating chat room, use the floating chat service
      if (chatroomId === 'floating-chat') {
        // Get previous messages
        const messages = await floatingChatService.getMessages(
          user.schoolCode, 
          user.domain
        );
        
        // Mark messages as read
        await floatingChatService.markMessagesAsRead(
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
      } else {
        // Get previous messages for regular chat rooms
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
      
      // Add reply information if present
      if (messageData.replyTo) {
        newMessage.replyTo = {
          id: messageData.replyTo.id,
          content: messageData.replyTo.content,
          sender: {
            id: messageData.replyTo.sender.id,
            name: messageData.replyTo.sender.name
          },
          hasAttachment: !!messageData.replyTo.hasAttachment
        };
      }
      
      try {
        let savedMessage;
        
        // Check if this is a floating chat message
        if (messageData.chatroomId === 'floating-chat') {
          // Save message to floating chat collection
          savedMessage = await floatingChatService.saveMessage(
            newMessage, 
            user.domain
          );
        } else {
          // For regular chat, add chatroomId to the message
          newMessage.chatroomId = messageData.chatroomId;
          
          // Save message to regular chat collection
          savedMessage = await chatService.saveMessage(
            newMessage, 
            user.domain
          );
        }
        
        // Broadcast to room
        console.log(`[send-message] Broadcasting to room ${messageData.chatroomId}:`, savedMessage._id);
        io.to(messageData.chatroomId).emit('new-message', savedMessage);
        
        // Notify other users in the school about unread count changes
        // Get all connected clients from the same school
        console.log(`Total connected clients: ${connectedClients.size}`);
        console.log(`Sender: ${user.id} (${user.schoolCode})`);
        
        for (const [clientUserId, clientSocket] of connectedClients) {
          console.log(`Checking client: ${clientUserId} (${clientSocket.user.schoolCode})`);
          // Skip the sender and only notify users from the same school
          if (clientUserId !== user.id && clientSocket.user.schoolCode === user.schoolCode) {
            console.log(`Will send unread counts to: ${clientUserId}`);
            try {
              // Get updated unread counts for this user
              const unreadCounts = await chatService.getUnreadCountsByChatroom(
                clientUserId,
                user.schoolCode,
                user.domain
              );
              
              console.log(`Sending unread counts to user ${clientUserId}:`, unreadCounts);
              
              // Emit unread count update
              clientSocket.emit('unread-counts-updated', unreadCounts);
            } catch (error) {
              console.error('Error updating unread counts for user:', clientUserId, error);
            }
          }
        }
        
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
  
  // Handle editing a message
  socket.on('edit-message', async (data, callback) => {
    try {
      const { messageId, chatroomId, newContent } = data;
      
      if (!messageId || !chatroomId || !newContent) {
        if (callback) {
          callback({
            success: false,
            error: 'Missing required fields'
          });
        }
        return;
      }
      
      // Call the service to edit the message
      const result = await chatService.editMessage(
        messageId,
        user.id,
        user.schoolCode,
        user.domain,
        newContent
      );
      
      if (result.success) {
        // Notify all users in the chatroom that a message was edited
        io.to(chatroomId).emit('message-edited', { 
          messageId,
          newContent: result.updatedMessage.content,
          editedAt: result.updatedMessage.editedAt
        });
        
        // Return success
        if (callback) {
          callback({
            success: true,
            updatedMessage: result.updatedMessage
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
      console.error('Error editing message:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to edit message'
        });
      }
    }
  });
  
  // Handle message reactions
  socket.on('toggle-reaction', async (data, callback) => {
    try {
      const { messageId, chatroomId, emoji } = data;
      
      if (!messageId || !chatroomId || !emoji) {
        if (callback) {
          callback({
            success: false,
            error: 'Missing required fields'
          });
        }
        return;
      }
      
      // Call the service to toggle the reaction
      const result = await chatService.toggleReaction(
        messageId,
        emoji,
        user,
        user.schoolCode,
        user.domain
      );
      
      if (result.success) {
        // Notify all users in the chatroom about the reaction change
        io.to(chatroomId).emit('message-reaction-updated', { 
          messageId,
          reactions: result.message.reactions || {}
        });
        
        // Return success
        if (callback) {
          callback({
            success: true,
            reactions: result.message.reactions || {}
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
      console.error('Error handling reaction:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to process reaction'
        });
      }
    }
  });
  
  // Handle deleting a floating chat message
  socket.on('delete-floating-message', async (data, callback) => {
    try {
      const { messageId } = data;
      
      if (!messageId) {
        if (callback) {
          callback({
            success: false,
            error: 'Message ID is required'
          });
        }
        return;
      }
      
      const result = await floatingChatService.deleteMessage(
        messageId,
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (result.success) {
        // Broadcast deletion to floating chat room
        io.to('floating-chat').emit('message-deleted', { messageId });
        
        if (callback) {
          callback({
            success: true
          });
        }
      } else {
        if (callback) {
          callback({
            success: false,
            error: result.error
          });
        }
      }
    } catch (error) {
      console.error('Error deleting floating message:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to delete message'
        });
      }
    }
  });
  
  // Get unread floating chat message count
  socket.on('get-floating-unread-count', async (_, callback) => {
    try {
      const count = await floatingChatService.getUnreadCount(
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (callback) {
        callback({
          success: true,
          count
        });
      }
    } catch (error) {
      console.error('Error getting unread floating message count:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to get unread count'
        });
      }
    }
  });
  
  // Get unread message counts for all chatrooms
  socket.on('get-unread-counts', async (_, callback) => {
    try {
      const unreadCounts = await chatService.getUnreadCountsByChatroom(
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (callback) {
        callback({
          success: true,
          unreadCounts
        });
      }
    } catch (error) {
      console.error('Error getting unread counts:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to get unread counts'
        });
      }
    }
  });

  // Get unread count for a specific chatroom
  socket.on('get-chatroom-unread-count', async (data, callback) => {
    try {
      const { chatroomId } = data;
      
      if (!chatroomId) {
        if (callback) {
          callback({
            success: false,
            error: 'Chatroom ID is required'
          });
        }
        return;
      }

      const count = await chatService.getUnreadCountForChatroom(
        chatroomId,
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (callback) {
        callback({
          success: true,
          count
        });
      }
    } catch (error) {
      console.error('Error getting chatroom unread count:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to get unread count'
        });
      }
    }
  });
  
  // Mark messages as read for a specific chatroom
  socket.on('mark-messages-read', async (data, callback) => {
    try {
      const { chatroomId } = data;
      
      if (!chatroomId) {
        if (callback) {
          callback({
            success: false,
            error: 'Chatroom ID is required'
          });
        }
        return;
      }

      // Mark messages as read
      await chatService.markMessagesAsRead(
        chatroomId,
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (callback) {
        callback({
          success: true
        });
      }
    } catch (error) {
      console.error('Error marking messages as read:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to mark messages as read'
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
    
    console.log('[/api/chatrooms] User:', user.id, 'Type:', user.userType, 'SchoolCode:', user.schoolCode);
    
    // Pass user object for role-based filtering
    const chatrooms = await chatService.getChatrooms(user.schoolCode, user.domain, user);
    
    console.log('[/api/chatrooms] Found', chatrooms.length, 'chatrooms for user');
    
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

// API endpoint to get unread counts for all chatrooms
app.get('/api/chatrooms/unread-counts', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const unreadCounts = await chatService.getUnreadCountsByChatroom(
      user.id,
      user.schoolCode,
      user.domain
    );
    
    res.json({ success: true, unreadCounts });
  } catch (error) {
    console.error('Error fetching unread counts:', error);
    res.status(500).json({ error: 'Failed to fetch unread counts' });
  }
});

// API endpoint to get unread count for a specific chatroom
app.get('/api/chatrooms/:chatroomId/unread-count', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const user = await verifyToken(token);
    
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const { chatroomId } = req.params;
    
    const count = await chatService.getUnreadCountForChatroom(
      chatroomId,
      user.id,
      user.schoolCode,
      user.domain
    );
    
    res.json({ success: true, count });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// Create API routes for floating chat
app.get('/api/floating-chat/messages', async (req, res) => {
  try {
    // Get auth token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Verify user
    const user = await verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Get messages
    const messages = await floatingChatService.getMessages(
      user.schoolCode,
      user.domain
    );
    
    return res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching floating chat messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/floating-chat/mark-read', async (req, res) => {
  try {
    // Get auth token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Verify user
    const user = await verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Mark messages as read
    const result = await floatingChatService.markMessagesAsRead(
      user.id,
      user.schoolCode,
      user.domain
    );
    
    return res.json({ success: true, result });
  } catch (error) {
    console.error('Error marking floating chat messages as read:', error);
    return res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

app.get('/api/floating-chat/unread-count', async (req, res) => {
  try {
    // Get auth token
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Verify user
    const user = await verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Get unread count
    const count = await floatingChatService.getUnreadCount(
      user.id,
      user.schoolCode,
      user.domain
    );
    
    return res.json({ success: true, count });
  } catch (error) {
    console.error('Error getting unread floating chat message count:', error);
    return res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Chat server listening on port ${PORT}`);
}); 