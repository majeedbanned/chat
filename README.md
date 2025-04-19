# FormMaker3 Chat Server

A real-time chat server for the FormMaker3 application, built with Node.js, Express, and Socket.IO.

## Features

- Real-time messaging with Socket.IO
- Authentication using JWT tokens
- Message persistence in MongoDB
- Support for multiple chatrooms
- Read receipts

## Installation

1. Clone the repository
2. Install dependencies:

```bash
cd server/chat
npm install
```

3. Configure environment variables by creating or editing `.env` file:

```
PORT=3001
JWT_SECRET=formmaker3_chat_secret
```

## Usage

Start the development server:

```bash
npm run dev
```

Or start the production server:

```bash
npm start
```

## API Endpoints

- `GET /api/health` - Check server status
- `GET /api/chatrooms` - Get all chatrooms for the authenticated user
- `GET /api/messages/:chatroomId` - Get messages for a specific chatroom

## Socket.IO Events

### Client to Server

- `join-room` - Join a chatroom
- `send-message` - Send a message to a chatroom

### Server to Client

- `new-message` - Receive a new message

## Authentication

All requests and socket connections require authentication using JWT tokens. For HTTP endpoints, include the token in the Authorization header:

```
Authorization: Bearer <token>
```

For Socket.IO connections, include the token in the auth object:

```javascript
const socket = io("http://localhost:3001", {
  auth: {
    token: "<token>",
  },
});
```

## License

This project is part of the FormMaker3 application.
