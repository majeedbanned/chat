const { connectToDatabase } = require('../lib/mongodb');
const { createFloatingMessageModel } = require('../models/floatingMessage');
const mongoose = require('mongoose');

/**
 * Floating Chat Service - Handles operations related to floating chat messages
 */
class FloatingChatService {
  /**
   * Save a new floating chat message to the database
   * @param {Object} messageData - Message data to save
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} The saved message
   */
  async saveMessage(messageData, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const FloatingMessageModel = createFloatingMessageModel(connection);
      
      const message = new FloatingMessageModel(messageData);
      const savedMessage = await message.save();
      
      return savedMessage;
    } catch (error) {
      console.error('Error saving floating chat message:', error);
      throw error;
    }
  }

  /**
   * Get floating chat messages for a specific school
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @param {number} limit - Maximum number of messages to return
   * @returns {Promise<Array>} Array of messages
   */
  async getMessages(schoolCode, domain, limit = 100) {
    try {
      const connection = await connectToDatabase(domain);
      const FloatingMessageModel = createFloatingMessageModel(connection);
      
      const messages = await FloatingMessageModel.find({ 
        schoolCode 
      })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();
      
      return messages.reverse(); // Return in chronological order
    } catch (error) {
      console.error('Error fetching floating chat messages:', error);
      throw error;
    }
  }

  /**
   * Mark floating chat messages as read for a specific user
   * @param {string} userId - User ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Update result
   */
  async markMessagesAsRead(userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const FloatingMessageModel = createFloatingMessageModel(connection);
      
      const result = await FloatingMessageModel.updateMany(
        { 
          schoolCode,
          'sender.id': { $ne: userId }, // Don't mark your own messages
          read: false
        },
        { 
          $set: { read: true },
          $addToSet: { 
            readBy: { 
              userId: userId, 
              timestamp: new Date() 
            } 
          }
        }
      ).exec();
      
      return result;
    } catch (error) {
      console.error('Error marking floating chat messages as read:', error);
      throw error;
    }
  }

  /**
   * Delete a specific floating chat message
   * @param {string} messageId - Message ID
   * @param {string} userId - User ID (for authorization)
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<Object>} Deletion result
   */
  async deleteMessage(messageId, userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const FloatingMessageModel = createFloatingMessageModel(connection);
      
      // First, find the message to verify the sender
      const message = await FloatingMessageModel.findOne({
        _id: messageId,
        schoolCode
      });
      
      // Message not found
      if (!message) {
        return { success: false, error: 'Message not found' };
      }
      
      // Check if the user is the sender of the message or an admin
      if (message.sender.id !== userId && message.sender.role !== 'admin') {
        return { success: false, error: 'Unauthorized: You can only delete your own messages' };
      }
      
      // Delete the message
      const result = await FloatingMessageModel.deleteOne({ _id: messageId });
      
      return { success: true, result };
    } catch (error) {
      console.error('Error deleting floating chat message:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get unread message count for a user
   * @param {string} userId - User ID
   * @param {string} schoolCode - School code
   * @param {string} domain - Domain name
   * @returns {Promise<number>} Number of unread messages
   */
  async getUnreadCount(userId, schoolCode, domain) {
    try {
      const connection = await connectToDatabase(domain);
      const FloatingMessageModel = createFloatingMessageModel(connection);
      
      const count = await FloatingMessageModel.countDocuments({
        schoolCode,
        'sender.id': { $ne: userId }, // Don't count your own messages
        read: false
      }).exec();
      
      return count;
    } catch (error) {
      console.error('Error getting unread floating chat message count:', error);
      throw error;
    }
  }
}

module.exports = new FloatingChatService(); 