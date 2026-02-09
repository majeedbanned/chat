require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { verifyToken } = require('./lib/auth');
const chatService = require('./services/chat');
const floatingChatService = require('./services/floatingChat');
const notifyFormmaker3 = require('./lib/notifyFormmaker3');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Create Express app
const app = express();
const server = http.createServer(app);

// ===========================================
// RATE LIMITING IMPLEMENTATION
// ===========================================

/**
 * Simple in-memory rate limiter
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMs - Time window in milliseconds
 */
class RateLimiter {
  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map(); // userId -> { count, resetTime }
  }

  /**
   * Check if a user is rate limited
   * @param {string} userId - User identifier
   * @returns {Object} { allowed: boolean, remaining: number, resetIn: number }
   */
  check(userId) {
    const now = Date.now();
    const userLimit = this.requests.get(userId);

    if (!userLimit || now > userLimit.resetTime) {
      // Reset or initialize
      this.requests.set(userId, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return { allowed: true, remaining: this.maxRequests - 1, resetIn: this.windowMs };
    }

    if (userLimit.count >= this.maxRequests) {
      return { 
        allowed: false, 
        remaining: 0, 
        resetIn: userLimit.resetTime - now 
      };
    }

    userLimit.count++;
    return { 
      allowed: true, 
      remaining: this.maxRequests - userLimit.count, 
      resetIn: userLimit.resetTime - now 
    };
  }

  // Clean up old entries periodically
  cleanup() {
    const now = Date.now();
    for (const [userId, limit] of this.requests.entries()) {
      if (now > limit.resetTime) {
        this.requests.delete(userId);
      }
    }
  }
}

// Create rate limiters for different operations
const rateLimiters = {
  messages: new RateLimiter(30, 60000),      // 30 messages per minute
  uploads: new RateLimiter(10, 60000),       // 10 uploads per minute
  reactions: new RateLimiter(60, 60000),     // 60 reactions per minute
  general: new RateLimiter(100, 60000),      // 100 general requests per minute
};

// Clean up rate limiters periodically
setInterval(() => {
  Object.values(rateLimiters).forEach(limiter => limiter.cleanup());
}, 60000);

/**
 * Rate limiting middleware for socket events
 * @param {string} type - Type of rate limiter to use
 * @returns {Function} Rate limit check function
 */
const checkRateLimit = (type, userId, callback) => {
  const limiter = rateLimiters[type] || rateLimiters.general;
  const result = limiter.check(userId);
  
  if (!result.allowed) {
    if (callback) {
      callback({
        success: false,
        error: `نرخ درخواست‌ها بیش از حد مجاز است. لطفاً ${Math.ceil(result.resetIn / 1000)} ثانیه صبر کنید.`,
        rateLimited: true,
        resetIn: result.resetIn
      });
    }
    return false;
  }
  return true;
};

/**
 * Express rate limiting middleware
 */
const expressRateLimiter = (type) => {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    let userId = 'anonymous';
    
    if (token) {
      try {
        const user = await verifyToken(token);
        if (user) userId = user.id;
      } catch (e) {
        // Use IP as fallback
        userId = req.ip || 'anonymous';
      }
    } else {
      userId = req.ip || 'anonymous';
    }
    
    const limiter = rateLimiters[type] || rateLimiters.general;
    const result = limiter.check(userId);
    
    res.set({
      'X-RateLimit-Limit': limiter.maxRequests,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': Math.ceil(result.resetIn / 1000)
    });
    
    if (!result.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        message: `نرخ درخواست‌ها بیش از حد مجاز است. لطفاً ${Math.ceil(result.resetIn / 1000)} ثانیه صبر کنید.`,
        retryAfter: Math.ceil(result.resetIn / 1000)
      });
    }
    
    next();
  };
};

// Enable CORS - Allow mobile app connections
app.use(cors({
  origin: ['http://localhost:3000', 'https://formmaker3.com', 'https://wpa.farsamooz.ir', 'http://localhost:8081', 'http://localhost:19006'],
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

// ===========================================
// FILE UPLOAD VALIDATION
// ===========================================

// Allowed file types whitelist
const ALLOWED_FILE_TYPES = {
  // Images
  'image/jpeg': { maxSize: 10 * 1024 * 1024, extension: ['.jpg', '.jpeg'] },
  'image/png': { maxSize: 10 * 1024 * 1024, extension: ['.png'] },
  'image/gif': { maxSize: 5 * 1024 * 1024, extension: ['.gif'] },
  'image/webp': { maxSize: 10 * 1024 * 1024, extension: ['.webp'] },
  // Audio (voice messages)
  'audio/mpeg': { maxSize: 25 * 1024 * 1024, extension: ['.mp3'] },
  'audio/mp4': { maxSize: 25 * 1024 * 1024, extension: ['.m4a'] },
  'audio/m4a': { maxSize: 25 * 1024 * 1024, extension: ['.m4a'] },  // Expo/iOS voice recording
  'audio/ogg': { maxSize: 25 * 1024 * 1024, extension: ['.ogg'] },
  'audio/webm': { maxSize: 25 * 1024 * 1024, extension: ['.webm'] },
  'audio/wav': { maxSize: 25 * 1024 * 1024, extension: ['.wav'] },
  'audio/x-m4a': { maxSize: 25 * 1024 * 1024, extension: ['.m4a'] },
  // Documents
  'application/pdf': { maxSize: 25 * 1024 * 1024, extension: ['.pdf'] },
  'application/msword': { maxSize: 25 * 1024 * 1024, extension: ['.doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { maxSize: 25 * 1024 * 1024, extension: ['.docx'] },
  'application/vnd.ms-excel': { maxSize: 25 * 1024 * 1024, extension: ['.xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { maxSize: 25 * 1024 * 1024, extension: ['.xlsx'] },
  'application/vnd.ms-powerpoint': { maxSize: 50 * 1024 * 1024, extension: ['.ppt'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { maxSize: 50 * 1024 * 1024, extension: ['.pptx'] },
  // Text files
  'text/plain': { maxSize: 5 * 1024 * 1024, extension: ['.txt'] },
  'text/csv': { maxSize: 10 * 1024 * 1024, extension: ['.csv'] },
  // Archives
  'application/zip': { maxSize: 50 * 1024 * 1024, extension: ['.zip'] },
  'application/x-rar-compressed': { maxSize: 50 * 1024 * 1024, extension: ['.rar'] },
  // Video (limited support)
  'video/mp4': { maxSize: 50 * 1024 * 1024, extension: ['.mp4'] },
  'video/quicktime': { maxSize: 50 * 1024 * 1024, extension: ['.mov'] },
};

/**
 * Validate file type and extension
 * @param {Object} file - Multer file object
 * @returns {{ valid: boolean, error?: string }}
 */
const validateFileType = (file) => {
  const mimeType = file.mimetype.toLowerCase();
  const extension = path.extname(file.originalname).toLowerCase();
  
  // Check if MIME type is allowed
  const allowedType = ALLOWED_FILE_TYPES[mimeType];
  if (!allowedType) {
    return { 
      valid: false, 
      error: `نوع فایل مجاز نیست. فرمت ${extension} پشتیبانی نمی‌شود.` 
    };
  }
  
  // Check if extension matches the MIME type
  if (!allowedType.extension.includes(extension)) {
    return { 
      valid: false, 
      error: `پسوند فایل با نوع آن مطابقت ندارد.` 
    };
  }
  
  return { valid: true };
};

// Set up multer upload with file validation
const upload = multer({
  storage: storage,
  limits: {
    fileSize: process.env.FILE_UPLOAD_MAX_SIZE ? parseInt(process.env.FILE_UPLOAD_MAX_SIZE) : 50 * 1024 * 1024 // Default 50MB max limit
  },
  fileFilter: function(req, file, cb) {
    const validation = validateFileType(file);
    if (!validation.valid) {
      return cb(new Error(validation.error), false);
    }
    cb(null, true);
  }
});

// Socket.IO instance with CORS - Allow mobile app connections
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'https://chat.farsamooz.ir', 'https://parsplus.farsamooz.ir', 'http://localhost:8081', 'http://localhost:19006'],
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

// ===========================================
// MENTION PARSING
// ===========================================

/**
 * Parse mentions from message content
 * Mentions are in format @username or @name
 * @param {string} content - Message content
 * @returns {Array} Array of mentioned usernames/names
 */
const parseMentions = (content) => {
  if (!content) return [];
  // Match @username patterns (alphanumeric, dots, underscores)
  const mentionRegex = /@([\w\u0600-\u06FF\.]+)/g;
  const matches = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  return [...new Set(matches)]; // Remove duplicates
};

// ===========================================
// ONLINE STATUS TRACKING
// ===========================================

// Online users by school code: Map<schoolCode, Set<userId>>
const onlineUsersBySchool = new Map();

/**
 * Get online users for a school
 * @param {string} schoolCode - School code
 * @returns {Array} Array of online user objects
 */
const getOnlineUsers = (schoolCode) => {
  const onlineUserIds = onlineUsersBySchool.get(schoolCode) || new Set();
  const onlineUsers = [];
  
  for (const userId of onlineUserIds) {
    const socket = connectedClients.get(userId);
    if (socket && socket.user) {
      onlineUsers.push({
        id: socket.user.id,
        name: socket.user.name,
        userType: socket.user.userType
      });
    }
  }
  
  return onlineUsers;
};

/**
 * Add user to online list
 * @param {Object} user - User object
 */
const addOnlineUser = (user) => {
  if (!onlineUsersBySchool.has(user.schoolCode)) {
    onlineUsersBySchool.set(user.schoolCode, new Set());
  }
  onlineUsersBySchool.get(user.schoolCode).add(user.id);
};

/**
 * Remove user from online list
 * @param {Object} user - User object
 */
const removeOnlineUser = (user) => {
  const schoolOnlineUsers = onlineUsersBySchool.get(user.schoolCode);
  if (schoolOnlineUsers) {
    schoolOnlineUsers.delete(user.id);
  }
};

// Socket.IO connection handler
io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`User connected: ${user.name} (${user.username})`);
  
  // Store client connection
  connectedClients.set(user.id, socket);
  
  // Add user to online list and broadcast
  addOnlineUser(user);
  
  // Broadcast user online status to all users in the same school
  const roomName = `school:${user.schoolCode}`;
  socket.join(roomName);
  io.to(roomName).emit('user-online', {
    user: {
      id: user.id,
      name: user.name,
      userType: user.userType
    }
  });
  
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
        // Get previous messages for regular chat rooms (with pagination info)
        const result = await chatService.getChatroomMessages(
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
        
        // Extract messages and pagination info
        const { messages, hasMore, nextCursor } = result;
        
        // Send response with pagination info
        if (callback) {
          callback({
            success: true,
            messages,
            hasMore,
            nextCursor
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
  
  // Handle loading more messages (pagination)
  socket.on('load-more-messages', async (data, callback) => {
    try {
      const { chatroomId, before, limit = 50 } = data;
      
      if (!chatroomId) {
        if (callback) {
          callback({
            success: false,
            error: 'Chatroom ID is required'
          });
        }
        return;
      }
      
      const result = await chatService.getChatroomMessages(
        chatroomId,
        user.schoolCode,
        user.domain,
        limit,
        before
      );
      
      if (callback) {
        callback({
          success: true,
          messages: result.messages,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor
        });
      }
    } catch (error) {
      console.error('Error loading more messages:', error);
      if (callback) {
        callback({
          success: false,
          error: 'Failed to load messages'
        });
      }
    }
  });
  
  // Handle sending a message
  socket.on('send-message', async (messageData, callback) => {
    // Apply rate limiting for messages
    if (!checkRateLimit('messages', user.id, callback)) {
      return;
    }
    
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
      
      // Parse and add mentions from content
      if (messageData.mentions && Array.isArray(messageData.mentions)) {
        newMessage.mentions = messageData.mentions;
      } else {
        // Parse mentions from content if not provided
        const mentionedNames = parseMentions(messageData.content);
        // Mentions will be resolved client-side, store the raw parsed data
        newMessage.mentions = mentionedNames.map(name => ({ name }));
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
        
        // Ask formmaker3 to send push notifications (new message only when teacher sends; mention always)
        if (messageData.chatroomId !== 'floating-chat') {
          console.log('messageData.chatroomId>>>>>>', messageData.chatroomId);
          chatService.getChatroomById(messageData.chatroomId, user.domain).then((chatroom) => {
           console.log('chatroom>>>>>>',JSON.stringify( chatroom));
            if (!chatroom || !chatroom.data) return;
            const recipients = chatroom.data.recipients || {};
            const students = (recipients.students || []).map((s) => (typeof s === 'object' ? s.value : s)).filter(Boolean);
            const teachers = (recipients.teachers || []).map((t) => (typeof t === 'object' ? t.value : t)).filter(Boolean);
            const classCodes = (recipients.classCode || []).map((c) => (typeof c === 'object' ? c.value : c)).filter(Boolean);
            const senderCode = user.username || user.id;
            const recipientStudentCodes = students.filter((c) => c !== senderCode);
            const recipientTeacherCodes = teachers.filter((c) => c !== senderCode);
            // classCodes are class identifiers (e.g. "7A"); pass all so formmaker3 notifies all students in those classes
            const recipientClassCodes = classCodes;
            const hasRecipients = recipientStudentCodes.length > 0 || recipientTeacherCodes.length > 0 || recipientClassCodes.length > 0;
            const messagePreview = savedMessage.content
              ? savedMessage.content.substring(0, 100)
              : (savedMessage.fileAttachment && (savedMessage.fileAttachment.isImage || savedMessage.fileAttachment.type?.startsWith?.('image/')))
                ? '📷 تصویر'
                : '📎 فایل';
            const chatroomName = chatroom.data.chatroomName || 'گفتگو';
            // New-message push: only when a teacher or school user sends

            // console.log('hasRecipients>>>>>>', hasRecipients);
           // console.log('*****recipientClassCodes*****>>>>>>', recipientClassCodes);
            // console.log('recipientStudentCodes>>>>>>', recipientStudentCodes);
            // console.log('recipientTeacherCodes>>>>>>', recipientTeacherCodes);


           // return;
            if (hasRecipients && (user.userType === 'teacher' || user.userType === 'school')) {
              console.log('[send-message] Triggering new-message push: room=', chatroomName, 'senderType=', user.userType);
              notifyFormmaker3.notifyNewMessage({
                domain: user.domain,
                schoolCode: user.schoolCode,
                chatroomId: messageData.chatroomId,
                chatroomName,
                senderName: user.name || user.username || 'کاربر',
                messagePreview,
                recipientStudentCodes,
                recipientTeacherCodes,
                recipientClassCodes,
                senderCode,
              });
            }
            if (savedMessage.mentions && savedMessage.mentions.length > 0) {
              const mentionedCodes = savedMessage.mentions
                .map((m) => m.id || m.username || m.name)
                .filter(Boolean);
              if (mentionedCodes.length > 0) {
                console.log('[send-message] Triggering mention push: room=', chatroomName, 'mentionedCount=', mentionedCodes.length);
                notifyFormmaker3.notifyMention({
                  domain: user.domain,
                  schoolCode: user.schoolCode,
                  chatroomId: messageData.chatroomId,
                  chatroomName,
                  senderName: user.name || user.username || 'کاربر',
                  messagePreview,
                  mentionedStudentCodes: mentionedCodes,
                  mentionedTeacherCodes: mentionedCodes,
                });
              }
            }
          }).catch((err) => console.error('[send-message] getChatroomById for push:', err));
        }
        
        // Notify mentioned users directly (if they have matching username or name)
        if (savedMessage.mentions && savedMessage.mentions.length > 0) {
          const mentionedNames = savedMessage.mentions.map(m => (m.name || m.username || '').toLowerCase());
          
          for (const [clientUserId, clientSocket] of connectedClients) {
            if (clientUserId === user.id) continue; // Skip sender
            if (clientSocket.user.schoolCode !== user.schoolCode) continue; // Same school only
            
            const clientName = (clientSocket.user.name || '').toLowerCase();
            const clientUsername = (clientSocket.user.username || '').toLowerCase();
            
            if (mentionedNames.some(name => name === clientName || name === clientUsername)) {
              console.log(`[send-message] Sending mention notification to: ${clientUserId}`);
              clientSocket.emit('user-mentioned', {
                messageId: savedMessage._id,
                chatroomId: messageData.chatroomId,
                sender: savedMessage.sender,
                preview: savedMessage.content.substring(0, 100)
              });
            }
          }
        }
        
        // Notify other users in the school about unread count changes
        // Get all connected clients from the same school
        console.log(`Total connected clients: ${connectedClients.size}`);
        console.log(`Sender: ${user.id} (${user.schoolCode})`);
        
        for (const [clientUserId, clientSocket] of connectedClients) {
          console.log(`Checking client:11 ${clientUserId} (${clientSocket.user.schoolCode})`);
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
    // Apply rate limiting for reactions
    if (!checkRateLimit('reactions', user.id, callback)) {
      return;
    }
    
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

  // Handle getting pinned messages
  socket.on('get-pinned-messages', async (data, callback) => {
    try {
      const { chatroomId } = data;
      
      if (!chatroomId) {
        if (callback) {
          callback({ success: false, error: 'Missing chatroomId' });
        }
        return;
      }
      
      const pinnedMessages = await chatService.getPinnedMessages(
        chatroomId,
        user.schoolCode,
        user.domain
      );
      
      if (callback) {
        callback({ success: true, pinnedMessages });
      }
    } catch (error) {
      console.error('Error getting pinned messages:', error);
      if (callback) {
        callback({ success: false, error: 'Failed to get pinned messages' });
      }
    }
  });

  // Handle pinning a message
  socket.on('pin-message', async (data, callback) => {
    try {
      const { messageId, chatroomId } = data;
      
      if (!messageId || !chatroomId) {
        if (callback) {
          callback({ success: false, error: 'Missing required fields' });
        }
        return;
      }
      
      const result = await chatService.pinMessage(
        messageId,
        chatroomId,
        user.id,
        user.schoolCode,
        user.domain
      );
      
      if (result.success) {
        // Get all pinned messages to broadcast
        const pinnedMessages = await chatService.getPinnedMessages(
          chatroomId,
          user.schoolCode,
          user.domain
        );
        
        // Notify all users in the chatroom
        io.to(chatroomId).emit('pinned-messages-updated', { 
          chatroomId,
          pinnedMessages 
        });
        
        if (callback) {
          callback({ success: true, message: result.message, pinnedMessages });
        }
      } else {
        if (callback) {
          callback({ success: false, error: result.error });
        }
      }
    } catch (error) {
      console.error('Error pinning message:', error);
      if (callback) {
        callback({ success: false, error: 'Failed to pin message' });
      }
    }
  });

  // Handle unpinning a message
  socket.on('unpin-message', async (data, callback) => {
    try {
      const { messageId, chatroomId } = data;
      
      if (!messageId || !chatroomId) {
        if (callback) {
          callback({ success: false, error: 'Missing required fields' });
        }
        return;
      }
      
      const result = await chatService.unpinMessage(
        messageId,
        user.schoolCode,
        user.domain
      );
      
      if (result.success) {
        // Get all pinned messages to broadcast
        const pinnedMessages = await chatService.getPinnedMessages(
          chatroomId,
          user.schoolCode,
          user.domain
        );
        
        // Notify all users in the chatroom
        io.to(chatroomId).emit('pinned-messages-updated', { 
          chatroomId,
          pinnedMessages 
        });
        
        if (callback) {
          callback({ success: true, pinnedMessages });
        }
      } else {
        if (callback) {
          callback({ success: false, error: result.error });
        }
      }
    } catch (error) {
      console.error('Error unpinning message:', error);
      if (callback) {
        callback({ success: false, error: 'Failed to unpin message' });
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
  
  // ===========================================
  // TYPING INDICATORS
  // ===========================================
  
  // Handle typing start event
  socket.on('typing-start', (data) => {
    const { chatroomId } = data;
    if (!chatroomId) return;
    
    // Broadcast to other users in the room
    socket.to(chatroomId).emit('user-typing', {
      chatroomId,
      user: {
        id: user.id,
        name: user.name
      }
    });
  });
  
  // Handle typing stop event
  socket.on('typing-stop', (data) => {
    const { chatroomId } = data;
    if (!chatroomId) return;
    
    // Broadcast to other users in the room
    socket.to(chatroomId).emit('user-stopped-typing', {
      chatroomId,
      userId: user.id
    });
  });
  
  // ===========================================
  // MESSAGE SEARCH
  // ===========================================
  
  // Search messages in a chatroom or globally
  socket.on('search-messages', async (data, callback) => {
    try {
      const { chatroomId, query, limit = 50 } = data;
      
      if (!query || query.trim().length < 2) {
        if (callback) {
          callback({
            success: false,
            error: 'حداقل ۲ کاراکتر برای جستجو وارد کنید'
          });
        }
        return;
      }
      
      const results = await chatService.searchMessages(
        chatroomId,
        user.schoolCode,
        user.domain,
        query.trim(),
        limit
      );
      
      if (callback) {
        callback({
          success: true,
          messages: results,
          query: query.trim()
        });
      }
    } catch (error) {
      console.error('Error searching messages:', error);
      if (callback) {
        callback({
          success: false,
          error: 'خطا در جستجو'
        });
      }
    }
  });

  // ===========================================
  // ONLINE STATUS HANDLERS
  // ===========================================
  
  // Get online users for the school
  socket.on('get-online-users', (_, callback) => {
    const onlineUsers = getOnlineUsers(user.schoolCode);
    if (callback) {
      callback({
        success: true,
        onlineUsers
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${user.name} (${user.username})`);
    connectedClients.delete(user.id);
    
    // Remove from online users and broadcast
    removeOnlineUser(user);
    const roomName = `school:${user.schoolCode}`;
    io.to(roomName).emit('user-offline', {
      userId: user.id
    });
    
    // Broadcast that user stopped typing (if they were) to all rooms
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('user-stopped-typing', {
          chatroomId: roomId,
          userId: user.id
        });
      }
    });
  });
});

// API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Chat server is running' });
});

// Upload file endpoint (with rate limiting)
app.post('/api/upload', expressRateLimiter('uploads'), (req, res, next) => {
  // Custom error handler for multer
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ 
            error: 'حجم فایل بیش از حد مجاز است.',
            maxSize: '50MB'
          });
        }
        return res.status(400).json({ error: err.message });
      }
      // Custom validation error
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'هیچ فایلی انتخاب نشده است.' });
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
    
    // Check if file is audio (voice message)
    const isAudio = req.file.mimetype.startsWith('audio/');
    
    // Create file attachment object with the same structure as our Mongoose schema
    const fileAttachment = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size,
      type: req.file.mimetype,
      url: `/uploads/${user.schoolCode}/chat/${req.file.filename}`,
      isImage,
      isAudio
    };

    // Log the file attachment object for debugging
    console.log('Created file attachment:', JSON.stringify(fileAttachment, null, 2));
    
    res.json({ success: true, fileAttachment });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'خطا در آپلود فایل: ' + error.message });
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