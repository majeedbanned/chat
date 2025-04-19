# FormMaker3 Chat Server

A real-time chat server for the FormMaker3 application, built with Node.js, Express, and Socket.IO.

## Features

- Real-time messaging with Socket.IO
- Authentication using JWT tokens
- Message persistence in MongoDB
- Support for multiple chatrooms
- Read receipts
- File upload and sharing
- Image preview for image attachments
- RTL (Right-to-Left) language support

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
FILE_UPLOAD_MAX_SIZE=10485760
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
- `POST /api/upload` - Upload a file attachment

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

## Environment Variables

- `PORT`: Server port (default: 3001)
- `JWT_SECRET`: Secret key for JWT authentication (must match the Next.js app)
- `FILE_UPLOAD_MAX_SIZE`: Maximum file upload size in bytes (default: 10MB)

### File Uploads

Files are stored in the `uploads/{schoolCode}/chat` directory structure to organize files by school. Supported file types include:

- Images (jpg, png, gif, etc.)
- Documents (pdf, docx, xlsx, etc.)
- Text files (txt)

Maximum file size is configurable through the `FILE_UPLOAD_MAX_SIZE` environment variable.
