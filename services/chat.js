const { connectToDatabase } = require('../lib/mongodb');
const { createMessageModel } = require('../models/message');

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
      const result = await MessageModel.updateMany(
        { 
          chatroomId, 
          schoolCode,
          'sender.id': { $ne: userId }, // Don't mark your own messages
          read: false
        },
        { $set: { read: true } }
      ).exec();
      
      return result;
    } catch (error) {
      console.error('Error marking messages as read:', error);
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
}

module.exports = new ChatService(); 