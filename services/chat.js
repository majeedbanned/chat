const { connectToDatabase } = require('../lib/mongodb');
const { createMessageModel } = require('../models/message');
const mongoose = require('mongoose');

/**
 * Chat Service - Handles operations related to chat messages
 */
class ChatService {
  /**
   * Save a new message to the database
   * @param {Object} messageData - Message data to save
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} The saved message
   */
  async saveMessage(messageData, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      const message = new MessageModel(messageData);
      const savedMessage = await message.save();
      
      return savedMessage;
    } catch (error) {
      console.error('Error saving message:', error);
      throw error;
    }
  }

  /**
   * Get messages for a specific chatroom
   * @param {string} chatroomId - Chatroom ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @param {number} limit - Maximum number of messages to return
   * @returns {Promise<Array>} Array of messages
   */
  async getChatroomMessages(chatroomId, schoolCode, domain, limit = 50) {
    try {
      const connection = await connectToDatabase(domain);

      console.log("domain", domain);
      const MessageModel = createMessageModel(connection);
      
      const messages = await MessageModel.find({ 
        chatroomId, 
        schoolCode 
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
      
      return messages.reverse(); // Return in chronological order
    } catch (error) {
      console.error('Error fetching messages:', error);
      throw error;
    }
  }

  /**
   * Mark messages as read
   * @param {string} chatroomId - Chatroom ID
   * @param {string} userId - User ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Update result
   */
  async markMessagesAsRead(chatroomId, userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      console.log("chatroomId", chatroomId);
      console.log("userId", userId);
      console.log("schoolCode", schoolCode);
      console.log("domain", domain);
      
      // Add user to readBy array for unread messages in this chatroom
      const result = await MessageModel.updateMany(
        { 
          chatroomId, 
          schoolCode,
          'sender.id': { $ne: userId }, // Don't mark your own messages
          readBy: { $ne: userId } // Only update messages not already read by this user
        },
        { 
          $addToSet: { readBy: userId }, // Add user to readBy array
          $set: { read: true } // Keep the old read field for backward compatibility
        }
      ).exec();
      
      return result;
    } catch (error) {
      console.error('Error marking messages as read:', error);
      throw error;
    }
  }

  /**
   * Get unread message count for each chatroom for a specific user
   * @param {string} userId - User ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Object with chatroomId as key and unread count as value
   */
  async getUnreadCountsByChatroom(userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      // Aggregate unread counts by chatroom
      const unreadCounts = await MessageModel.aggregate([
        {
          $match: {
            schoolCode,
            'sender.id': { $ne: userId }, // Exclude user's own messages
            readBy: { $ne: userId } // Messages not read by this user
          }
        },
        {
          $group: {
            _id: '$chatroomId',
            unreadCount: { $sum: 1 }
          }
        }
      ]).exec();
      
      // Convert to object with chatroomId as key
      const result = {};
      unreadCounts.forEach(item => {
        result[item._id] = item.unreadCount;
      });
      
      return result;
    } catch (error) {
      console.error('Error getting unread counts by chatroom:', error);
      throw error;
    }
  }

  /**
   * Get unread message count for a specific chatroom
   * @param {string} chatroomId - Chatroom ID
   * @param {string} userId - User ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<number>} Number of unread messages
   */
  async getUnreadCountForChatroom(chatroomId, userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      const count = await MessageModel.countDocuments({
        chatroomId,
        schoolCode,
        'sender.id': { $ne: userId }, // Exclude user's own messages
        readBy: { $ne: userId } // Messages not read by this user
      }).exec();
      
      return count;
    } catch (error) {
      console.error('Error getting unread count for chatroom:', error);
      throw error;
    }
  }

  /**
   * Get all chatrooms for a school
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Array>} Array of chatrooms
   */
  async getChatrooms(schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const collection = connection.collection('chatrooms');
      
      const chatrooms = await collection.find({ 
        schoolCode 
      }).toArray();
      
      return chatrooms;
    } catch (error) {
      console.error('Error fetching chatrooms:', error);
      throw error;
    }
  }

  /**
   * Delete a specific message
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID (for authorization)
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Deletion result
   */
  async deleteMessage(messageId, userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      // First, find the message to verify the sender
      const message = await MessageModel.findOne({
        _id: messageId,
        schoolCode
      });
      
      // Message not found
      if (!message) {
        return { success: false, error: 'Message not found' };
      }
      
      // Check if the user is the sender of the message
      if (message.sender.id !== userId) {
        return { success: false, error: 'Unauthorized: You can only delete your own messages' };
      }
      
      // Delete the message
      const result = await MessageModel.deleteOne({ _id: messageId });
      
      // If there's a file attachment, we could delete the file here too
      // This would require additional file system operations
      
      return { success: true, result };
    } catch (error) {
      console.error('Error deleting message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Edit a specific message
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID (for authorization)
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @param {string} newContent - New message content
   * @returns {Promise<Object>} Edit result
   */
  async editMessage(messageId, userId, schoolCode, domain, newContent) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      // First, find the message to verify the sender
      const message = await MessageModel.findOne({
        _id: messageId,
        schoolCode
      });
      
      // Message not found
      if (!message) {
        return { success: false, error: 'Message not found' };
      }
      
      // Check if the user is the sender of the message
      if (message.sender.id !== userId) {
        return { success: false, error: 'Unauthorized: You can only edit your own messages' };
      }
      
      // Check if content is empty
      if (!newContent.trim()) {
        return { success: false, error: 'Message content cannot be empty' };
      }
      
      // Update the message
      const result = await MessageModel.findByIdAndUpdate(
        messageId, 
        { 
          $set: { 
            content: newContent.trim(),
            edited: true,
            editedAt: new Date()
          } 
        },
        { new: true } // Return the updated document
      );
      
      return { success: true, updatedMessage: result };
    } catch (error) {
      console.error('Error editing message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Toggle reaction on a message
   * @param {string} messageId - Message ID
   * @param {string} emoji - Emoji to toggle
   * @param {Object} user - User who is reacting
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Result with updated message
   */
  async toggleReaction(messageId, emoji, user, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const MessageModel = createMessageModel(connection);
      
      // Find the message
      const message = await MessageModel.findOne({
        _id: messageId,
        schoolCode
      });
      
      if (!message) {
        return { success: false, error: 'Message not found' };
      }
      
      // Ensure reactions Map exists
      if (!message.reactions) {
        message.reactions = new Map();
      }
      
      // Create a user object with only the necessary information
      const userInfo = {
        id: user.id,
        name: user.name
      };
      
      // First, remove any existing reactions from this user on this message
      // Each user can only have one reaction per message
      for (const [existingEmoji, reaction] of message.reactions.entries()) {
        const userIndex = reaction.users.findIndex(u => u.id === user.id);
        if (userIndex !== -1) {
          // Remove this user from the reaction
          reaction.users.splice(userIndex, 1);
          
          // If no users left for this emoji, remove the emoji entry
          if (reaction.users.length === 0) {
            message.reactions.delete(existingEmoji);
          } else {
            // Update the reaction with modified users array
            message.reactions.set(existingEmoji, reaction);
          }
        }
      }
      
      // If the user clicked the same emoji they already had, we already removed it above
      // If it's a different emoji, we need to add the new reaction
      if (emoji) {
        // Check if this emoji reaction exists
        if (!message.reactions.has(emoji)) {
          // If this emoji reaction doesn't exist, create it
          message.reactions.set(emoji, {
            emoji,
            users: [userInfo]
          });
        } else {
          // Get the current reaction
          const reaction = message.reactions.get(emoji);
          
          // Add the user to this reaction (we already removed them from all reactions above)
          reaction.users.push(userInfo);
          message.reactions.set(emoji, reaction);
        }
      }
      
      // Convert reactions Map to plain object for the response
      const reactionsObject = {};
      message.reactions.forEach((value, key) => {
        reactionsObject[key] = value;
      });
      
      // Save the updated message
      await message.save();
      
      // Fetch the updated message to ensure consistency
      const updatedMessage = await MessageModel.findById(messageId);
      
      // Convert reactions Map to plain object for the response in updated message
      const updatedReactionsObject = {};
      if (updatedMessage.reactions) {
        updatedMessage.reactions.forEach((value, key) => {
          updatedReactionsObject[key] = value;
        });
      }
      
      return { 
        success: true, 
        message: {
          ...updatedMessage.toObject(),
          reactions: updatedReactionsObject
        }
      };
    } catch (error) {
      console.error('Error toggling reaction:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new ChatService(); 